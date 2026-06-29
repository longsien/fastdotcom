#!/usr/bin/env node
'use strict';

// fast — a tiny CLI that measures your connection using fast.com (Netflix
// Open Connect) as its backend. Zero dependencies.
//
// On a TTY it renders a small btop-style TUI: each metric is a gauge scaled
// 0 → max (this run), gradient-filled to the average, with a white tick at the
// minimum and superscript min/avg/max labels above. Piped (or --json) output
// falls back to plain text.

const https = require('node:https');

// ---- formatting ------------------------------------------------------------

function fmtBits(bitsPerSec) {
  const mbps = bitsPerSec / 1e6;
  if (mbps >= 1000) return (mbps / 1000).toFixed(2) + ' Gbps';
  if (mbps < 1) return (bitsPerSec / 1e3).toFixed(0) + ' kbps';
  return mbps.toFixed(1) + ' Mbps';
}

function fmtMs(ms) {
  return ms.toFixed(1) + ' ms';
}

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Nearest-rank percentile (p in [0,1]). Speed tests headline a high percentile
// of their throughput samples, which sits near the sustained peak.
function percentile(xs, p) {
  if (!xs || !xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

function stats(xs) {
  if (!xs || !xs.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const x of xs) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }
  return { min, avg: sum / xs.length, max, p90: percentile(xs, 0.9) };
}

// Superscript "micro" digits for the inline labels above each bar.
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
function sup(n) {
  return String(Math.round(n))
    .split('')
    .map((c) => SUP[c] || c)
    .join('');
}

// ---- ANSI / colour ---------------------------------------------------------

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length; // width sans ANSI

const C_BORDER = fg(88, 96, 112);
const C_TITLE = fg(122, 222, 255);
const C_LABEL = fg(210, 215, 225);
const C_MUTE = fg(120, 128, 145);
const C_TRACK = fg(48, 52, 64);
const C_TICK = BOLD + fg(255, 255, 255); // the min marker (bright dot)
const C_MAXTICK = fg(96, 104, 122); // the max marker (slightly lighter than track)

// Border shimmer: while a measurement runs, a soft band of lighter grey sweeps
// left→right across the whole box outline (corners, dashes and vertical bars),
// and through the muted header/footer text.
const SHIMMER_BASE = [88, 96, 112]; // C_BORDER grey (resting colour)
const SHIMMER_GLOW = [165, 176, 198]; // a clear lift over base as the band passes
const SHIMMER_EDGE = 0.4; // dim factor for the vertical edges (a whole column
//                           lights at once, so full glow reads as a flash)
const SHIMMER_TEXT = [120, 128, 145]; // muted text resting colour (C_MUTE)
const SHIMMER_TEXT_GLOW = [185, 192, 208]; // brightened muted text as the band passes

// Gradient stops (left → right across a gauge).
// Bars are scaled 0→max, so a full bar means avg≈max (a consistent reading);
// gradients end green/cool so "fuller = healthier" reads the same everywhere.
const G_PING = [[52, 211, 153], [250, 204, 21], [239, 68, 68]]; // green=low → red=high
const PING_SCALE = 150; // ms mapped to the full green→red range
const G_DOWN = [[196, 181, 253], [167, 139, 250], [139, 92, 246]]; // lilac→violet
const G_UP = [[249, 168, 212], [244, 114, 182], [236, 72, 153]]; // pink→rose

function gradColor(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const seg = (stops.length - 1) * t;
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const DOT = '⠿'; // braille all-6-dots (U+283F)

function clampIdx(frac, width) {
  return Math.max(0, Math.min(width - 1, Math.round(frac * width)));
}

// A gauge of `width` columns scaled 0 → scaleMax: gradient-filled to st.avg,
// with a white tick at st.min; the rest is a dim track. Download and upload
// pass a shared scaleMax so their bars are directly comparable.
function gaugeStats(st, width, stops, scaleMax) {
  const max = scaleMax || (st && st.max) || 0;
  if (!st || max <= 0) return C_TRACK + DOT.repeat(width) + RESET;
  const fill = Math.round(Math.min(1, st.avg / max) * width);
  const minIdx = clampIdx(Math.min(1, st.min / max), width);
  const maxIdx = clampIdx(Math.min(1, st.max / max), width);
  let out = '';
  for (let i = 0; i < width; i++) {
    if (i === minIdx) {
      out += C_TICK + DOT; // bright min marker
    } else if (i < fill) {
      const t = width > 1 ? i / (width - 1) : 0;
      const [r, g, b] = gradColor(stops, t);
      out += fg(r, g, b) + DOT;
    } else if (i === maxIdx) {
      out += C_MAXTICK + DOT; // faint max marker in the track
    } else {
      out += C_TRACK + DOT;
    }
  }
  return out + RESET;
}

// ---- cell-grid helpers (for the superscript label row) ---------------------

// Each cell is exactly one display column, so widths stay aligned.
function newCells(width) {
  return Array.from({ length: width }, () => ({ ch: ' ', color: null }));
}
function place(cells, text, idx, align, color) {
  const w = cells.length;
  if (text.length > w) text = text.slice(0, w); // never overflow / widen the row
  const len = text.length;
  let start =
    align === 'left' ? idx : align === 'right' ? idx - len + 1 : idx - ((len - 1) >> 1);
  start = Math.max(0, Math.min(w - len, start));
  for (let i = 0; i < len; i++) cells[start + i] = { ch: text[i], color };
}
function renderCells(cells) {
  let out = '';
  for (const c of cells) out += c.color && c.ch !== ' ' ? c.color + c.ch : c.ch;
  return out + RESET;
}

// Write a left-to-right ordered list of labels into `cells`, nudging them apart
// so they never overlap (at least `gap` blank columns between them). Positions
// can drift from their ideal anchor, but we never collide.
function placeLabels(cells, items, gap = 1) {
  const width = cells.length;
  const L = items.map((it) => it.text.length);
  const start = items.map((it, i) =>
    it.align === 'left'
      ? it.anchor
      : it.align === 'right'
      ? it.anchor - L[i] + 1
      : it.anchor - ((L[i] - 1) >> 1)
  );
  // Forward: keep order and spacing.
  for (let i = 1; i < items.length; i++)
    start[i] = Math.max(start[i], start[i - 1] + L[i - 1] + gap);
  // Pull the last one in-bounds, then push leftward neighbours back.
  const last = items.length - 1;
  if (start[last] + L[last] > width) start[last] = width - L[last];
  for (let i = last - 1; i >= 0; i--)
    if (start[i] + L[i] + gap > start[i + 1]) start[i] = start[i + 1] - gap - L[i];
  // Final clamp + write.
  for (let i = 0; i < items.length; i++) {
    const s = Math.max(0, Math.min(width - L[i], start[i]));
    for (let k = 0; k < L[i] && s + k < width; k++)
      cells[s + k] = { ch: items[i].text[k], color: items[i].color };
  }
}

// The min/avg/max superscript row that sits above a gauge, positioned on the
// shared scaleMax.
function labelRow(st, width, stops, fmtSup, scaleMax) {
  const cells = newCells(width);
  const max = scaleMax || (st && st.max) || 0;
  if (st && max > 0) {
    const avgF = Math.min(1, st.avg / max);
    const [r, g, b] = gradColor(stops, avgF);
    // The gradient fills columns 0…fill-1, so the bar visually ends at fill-1.
    // min/max have ticks drawn at their clampIdx column; avg has none, so anchor
    // it to the last filled dot rather than the first empty cell past it.
    const avgIdx = Math.max(0, Math.round(avgF * width) - 1);
    placeLabels(cells, [
      // Each label's right edge sits on its own marker (min tick, avg fill end,
      // max tick); placeLabels nudges them apart only if they crowd.
      { text: fmtSup(st.min), anchor: clampIdx(Math.min(1, st.min / max), width), align: 'right', color: C_TICK },
      { text: fmtSup(st.avg), anchor: avgIdx, align: 'right', color: BOLD + fg(r, g, b) },
      { text: fmtSup(st.max), anchor: clampIdx(Math.min(1, st.max / max), width), align: 'right', color: C_MUTE },
    ]);
  }
  return renderCells(cells);
}

// ---- measurements ----------------------------------------------------------

// Turn a non-OK speed-endpoint status into a readable message. A 1-byte 429
// body otherwise gets timed as ~0 bps and shows up as a bogus 0/0/0 reading.
function httpReason(status, phase) {
  if (status === 429)
    return `${phase} rate-limited (HTTP 429)`;
  return `${phase} failed: HTTP ${status}`;
}

// Generic parallel-throughput sampler. Runs `streams` worker loops in parallel;
// each worker repeatedly transfers data and calls `credit(bytes)` for every
// chunk/request. We aggregate credited bytes across ALL workers into fixed
// time windows (JS is single-threaded, so the shared counters need no locking)
// and discard the first `warmup` windows as ramp-up. Returns min/avg/max/p90.
async function sampleThroughput(opts, worker, onTick) {
  const { streams, window: WINDOW, warmup: WARMUP, maxDur: MAXDUR } = opts;
  const samples = [];
  const start = performance.now();
  const ctl = { stopped: false, controller: new AbortController() };
  let winBytes = 0;
  let winStart = start;
  let widx = 0;

  function credit(len) {
    winBytes += len;
    const now = performance.now();
    if (now - winStart >= WINDOW) {
      const bps = (winBytes * 8) / ((now - winStart) / 1000);
      if (widx >= WARMUP) samples.push(bps);
      widx++;
      winBytes = 0;
      winStart = now;
      if (onTick) onTick(stats(samples.length ? samples : [bps]));
      if (now - start >= MAXDUR) {
        ctl.stopped = true;
        ctl.controller.abort();
      }
    }
  }
  const elapsed = () => performance.now() - start;

  await Promise.all(
    Array.from({ length: streams }, (_, idx) =>
      worker({ idx, credit, ctl, elapsed, maxDur: MAXDUR })
    )
  );

  // Record the final partial window so a short tail isn't dropped. Require at
  // least half a window so a tiny sliver can't divide out to a wild bps.
  const tail = performance.now() - winStart;
  if (winBytes > 0 && tail >= WINDOW / 2 && widx >= WARMUP) {
    samples.push((winBytes * 8) / (tail / 1000));
  }

  const s = stats(samples);
  if (onTick) onTick(s);
  return s;
}

// Stream a sized GET repeatedly, crediting every chunk; `url(streamIdx)` lets
// each worker hit its own fast.com target.
function downloadWorker(url) {
  return async ({ idx, credit, ctl, elapsed, maxDur }) => {
    while (!ctl.stopped && elapsed() < maxDur) {
      let res;
      try {
        res = await fetch(url(idx), { signal: ctl.controller.signal, cache: 'no-store' });
      } catch (e) {
        if (e.name === 'AbortError') return;
        throw e;
      }
      if (!res.ok) throw new Error(httpReason(res.status, 'download'));
      try {
        for await (const chunk of res.body) {
          credit(chunk.length);
          if (ctl.stopped) break;
        }
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
      }
    }
  };
}

// Send-side upload POST over a FRESH connection, crediting bytes as the kernel
// drains them (the write callback fires on flush; backpressure gates the loop to
// the socket's ACK rate). `fetch` can't observe on-wire upload progress, so we
// drop to node:https here. Used for fast.com, whose Open Connect endpoints 400
// on a reused keep-alive socket (hence agent:false) and don't behave as a clean
// throughput sink — so this reads high and is treated as approximate. `chunk`
// must be a whole multiple of the buffer length so Content-Length matches.
function rawUploadPost(url, chunk, buf, credit, ctl) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const signal = ctl.controller.signal;
    let settled = false;
    let req;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(v);
    };
    // fetch-based download cancels via the shared signal; node:https must be
    // torn down explicitly, so honour the same signal here.
    const onAbort = () => {
      if (req) req.destroy();
      finish(-1);
    };
    req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        agent: false, // fresh connection — reuse triggers 400s on Open Connect
        headers: { 'content-type': 'application/octet-stream', 'content-length': chunk },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => finish(res.statusCode));
        res.on('error', () => finish(0));
      }
    );
    req.on('error', () => finish(0));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return onAbort();
    let sent = 0;
    const pump = () => {
      while (sent < chunk) {
        if (ctl.stopped) {
          req.destroy();
          return finish(-1);
        }
        const ok = req.write(buf, () => credit(buf.length));
        sent += buf.length;
        if (!ok) {
          req.once('drain', pump); // wait for the socket to drain (backpressure)
          return;
        }
      }
      req.end();
    };
    pump();
  });
}

// ---- provider: fast.com ----------------------------------------------------

// fast.com (Netflix Open Connect) is the sole backend. It hands back several
// distinct CDN server URLs (so download parallelises nicely) and reliably
// serves download + latency; upload is the approximate send-side measurement
// (see rawUploadPost). The token is scraped from fast.com's JS bundle
// (unofficial — can change), so discovery is lazy and any failure surfaces as
// a normal error.
function makeFastCom() {
  let inited = null;
  let targets = [];
  let client = null;

  async function discover() {
    const home = await (await fetch('https://fast.com/')).text();
    const sm = home.match(/<script src="(\/app-[^"]+\.js)"/);
    if (!sm) throw new Error('fast.com: app bundle not found');
    const js = await (await fetch('https://fast.com' + sm[1])).text();
    const tm = js.match(/token:"([^"]+)"/);
    if (!tm) throw new Error('fast.com: token not found');
    const res = await fetch(
      `https://api.fast.com/netflix/speedtest/v2?https=true&token=${tm[1]}&urlCount=5`
    );
    if (!res.ok) throw new Error(httpReason(res.status, 'fast.com discovery'));
    const data = await res.json();
    if (!data.targets?.length) throw new Error('fast.com: no targets returned');
    targets = data.targets.map((t) => t.url);
    client = data.client || null;
  }
  // Cache discovery, but clear the cache on failure so the next phase retries a
  // transient error instead of being stuck on a permanently-rejected promise.
  const ensure = () =>
    (inited ||= discover().catch((e) => {
      inited = null;
      throw e;
    }));

  // Turn a target URL (…/speedtest?query) into a sized range request.
  const ranged = (url, bytes) => {
    const [base, query] = url.split('?');
    return `${base}/range/0-${bytes}${query ? '?' + query : ''}`;
  };

  return {
    name: 'fast.com',
    async getMeta() {
      await ensure();
      return {
        clientIp: client?.ip || null,
        colo: client?.location?.city || null, // header shows "City · Country"
        country: client?.location?.country || null,
        city: client?.location?.city || null,
      };
    },
    async latency(samples, onTick) {
      await ensure();
      const url = ranged(targets[0], 0); // one target so the connection is reused
      const times = [];
      for (let i = 0; i < samples; i++) {
        const t0 = performance.now();
        const res = await fetch(url, { cache: 'no-store' });
        await res.arrayBuffer();
        times.push(performance.now() - t0);
        if (onTick) onTick(stats(times));
      }
      const s = stats(times);
      const jitter = median(times.map((t) => Math.abs(t - s.avg)));
      return { stats: s, jitter };
    },
    async download(onTick) {
      await ensure();
      const CHUNK = 26e6;
      return sampleThroughput(
        { streams: targets.length, window: 200, warmup: 2, maxDur: 6000 },
        downloadWorker((idx) => ranged(targets[idx], CHUNK)),
        onTick
      );
    },
    // Upload via the send-side raw-socket method (see rawUploadPost). `fetch`
    // with a Buffer body can't see on-wire progress and over-reads wildly (it
    // times the response, which the OCA early-ACKs). Measuring the kernel drain
    // rate is far better, but Open Connect's ingest buffers are large enough
    // that the reading still runs high and scales with offered load — so we use
    // a deliberately modest config and flag it approximate (see `approx`).
    approxUpload: true,
    async upload(onTick) {
      await ensure();
      const buf = Buffer.alloc(64 * 1024);
      const CHUNK = 400 * buf.length; // 25 MiB, exact multiple of buf
      const streams = Math.min(4, targets.length); // modest load → closer to real
      return sampleThroughput(
        { streams, window: 200, warmup: 3, maxDur: 6500 },
        async ({ idx, credit, ctl, elapsed, maxDur }) => {
          const url = ranged(targets[idx % targets.length], CHUNK);
          while (!ctl.stopped && elapsed() < maxDur) {
            const status = await rawUploadPost(url, CHUNK, buf, credit, ctl);
            // status: HTTP code, 0 on socket error, -1 when stopped/aborted.
            // A real HTTP rejection (Open Connect 400/429) would otherwise be
            // credited as throughput, so surface it like the download path.
            if (status >= 400) throw new Error(httpReason(status, 'upload'));
          }
        },
        onTick
      );
    },
  };
}

// fast.com is the only backend, so the "session" is a thin wrapper around it —
// kept so the runners stay backend-agnostic and the upload-approx flag is
// surfaced the same way for output labelling.
function makeSession() {
  const p = makeFastCom();
  return {
    name: () => p.name,
    uploadName: () => p.name,
    uploadApprox: () => !!p.approxUpload,
    getMeta: (...a) => p.getMeta(...a),
    latency: (...a) => p.latency(...a),
    download: (...a) => p.download(...a),
    upload: (...a) => p.upload(...a),
  };
}

// ---- TUI -------------------------------------------------------------------

function makeTui(doUpload) {
  // Layout dims, recomputed on terminal resize (see resize()).
  const labelW = 5;
  let W, inner, body, barW;
  function computeDims() {
    const cols = process.stdout.columns || 64;
    W = Math.max(46, Math.min(120, cols)); // total box width (responsive, capped)
    inner = W - 2; // between borders
    body = W - 4; // between the pad spaces
    barW = body - labelW - 1;
  }
  computeDims();

  const supSpeed = (v) => sup(v / 1e6);

  const state = {
    meta: null,
    provider: null, // backend name (fast.com)
    upUnavailable: false, // set when the active provider can't measure upload
    uploadApprox: false, // set when the upload figure is a rough reading (fast.com)
    pingStats: null,
    downStats: null,
    upStats: null,
    jitter: null,
    phase: 'init', // init|ping|down|up|done
    doUpload,
  };

  let firstPaint = true;
  let lastPaint = 0;
  let lastLines = 0; // height of the last painted frame (varies with IP caption)
  let shimmer = null; // current sweep phase [0,1), or null when idle/done

  const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

  // How strongly the sweep lands on column `col` (0 = resting, 1 = peak).
  function sweepK(col) {
    if (shimmer == null) return 0;
    const head = shimmer * (W + 12) - 6; // band centre travels off both ends
    return Math.max(0, 1 - Math.abs(col - head) / 6); // falloff over 6 cols
  }
  const mix = (base, glow, k) =>
    fg(...base.map((c, j) => Math.round(c + (glow[j] - c) * k)));

  // Border cell colour. `gain` dims the sweep — the vertical edges pass < 1 so
  // the whole column lighting at once doesn't read as a flash.
  const borderColor = (col, gain = 1) =>
    mix(SHIMMER_BASE, SHIMMER_GLOW, sweepK(col) * gain);

  // A run of `count` identical border chars from column `startCol`, swept.
  function borderRun(ch, count, startCol) {
    let s = '';
    for (let i = 0; i < count; i++) s += borderColor(startCol + i) + ch;
    return s + RESET;
  }

  // Muted header/footer text (location, IP) that also catches the sweep.
  function sweptText(text, startCol) {
    let s = '';
    for (let i = 0; i < text.length; i++)
      s += mix(SHIMMER_TEXT, SHIMMER_TEXT_GLOW, sweepK(startCol + i)) + text[i];
    return s + RESET;
  }

  function wrap(content) {
    return borderColor(0, SHIMMER_EDGE) + '│' + RESET + ' ' + content + ' ' +
      borderColor(W - 1, SHIMMER_EDGE) + '│' + RESET;
  }

  function borderLine(left, right, leftText, rightText) {
    const lt = leftText ? ' ' + leftText + ' ' : '';
    const rt = rightText ? ' ' + rightText + ' ' : '';
    const dashes = Math.max(0, inner - visLen(lt) - visLen(rt));
    return (
      borderColor(0, SHIMMER_EDGE) + left + RESET +
      (lt ? C_TITLE + BOLD + lt + RESET : '') +
      borderRun('─', dashes, 1 + visLen(lt)) +
      (rt ? sweptText(rt, W - 1 - visLen(rt)) : '') +
      borderColor(W - 1, SHIMMER_EDGE) + right + RESET
    );
  }

  function blank() {
    return borderColor(0, SHIMMER_EDGE) + '│' + RESET + ' '.repeat(inner) +
      borderColor(W - 1, SHIMMER_EDGE) + '│' + RESET;
  }

  // Ping is a single numeric line (no gauge): avg, the min/max spread, jitter.
  function pingLine() {
    const st = state.pingStats;
    const active = state.phase === 'ping';
    const cells = newCells(body);
    place(cells, pad('PING', labelW), 0, 'left', active ? C_TICK : st ? BOLD + C_LABEL : C_MUTE);
    if (st) {
      // Colour the latency by value: green (low) → red (high).
      const [r, g, b] = gradColor(G_PING, st.avg / PING_SCALE);
      place(cells, fmtMs(st.avg), labelW + 1, 'left', BOLD + fg(r, g, b));
      const spread =
        `${st.min.toFixed(0)} / ${st.max.toFixed(0)} ms` +
        (state.jitter != null ? `  ±${state.jitter.toFixed(1)}` : '');
      place(cells, spread, body - 1, 'right', C_MUTE);
    } else {
      place(cells, 'measuring…', labelW + 1, 'left', C_MUTE);
    }
    return wrap(renderCells(cells));
  }

  // Two lines: superscript labels above, the gauge below (shared scaleMax).
  function metricBlock(key, label, st, stops, scaleMax, note) {
    const active = state.phase === key;
    const lab =
      (active ? C_TICK : st ? BOLD + C_LABEL : C_MUTE) + pad(label, labelW) + RESET;

    let labels;
    if (note && !st) {
      const cells = newCells(barW);
      place(cells, note, barW >> 1, 'center', C_MUTE);
      labels = renderCells(cells);
    } else {
      labels = labelRow(st, barW, stops, supSpeed, scaleMax);
    }

    // Labels go below the bar: superscript glyphs sit high in the cell, so
    // they hug the gauge above them.
    return [
      wrap(lab + ' ' + gaugeStats(st, barW, stops, scaleMax)),
      wrap(' '.repeat(labelW + 1) + labels),
    ];
  }

  // A long IP (IPv6 is up to 39 chars) can't share the bottom border with the
  // download/upload summary, so past this length it drops to its own dimmed,
  // right-aligned caption line just under the box instead of crowding them out.
  const IP_IN_BORDER_MAX = 15; // longest IPv4 ("255.255.255.255")
  function ipCaption(text) {
    return ' '.repeat(Math.max(0, W - text.length)) + C_MUTE + text + RESET;
  }

  function buildFrame() {
    const m = state.meta;
    const loc = m
      ? [m.colo, m.country].filter(Boolean).join(' · ') || state.provider || ''
      : 'connecting…';
    const ipText = m && m.clientIp ? m.clientIp : '';
    const ipInBorder = ipText.length <= IP_IN_BORDER_MAX;

    // Shared scale: the larger peak of download/upload = a full bar.
    const scaleMax = Math.max(
      state.downStats?.max || 0,
      (state.doUpload ? state.upStats?.max : 0) || 0
    );

    const busy = state.phase === 'ping' || state.phase === 'down' || state.phase === 'up';
    shimmer = busy ? (performance.now() / 1600) % 1 : null;

    const lines = [
      borderLine('╭', '╮', '', loc),
      blank(),
      pingLine(),
      blank(),
      ...metricBlock('down', 'DOWN', state.downStats, G_DOWN, scaleMax),
      ...metricBlock(
        'up',
        'UP',
        state.doUpload ? state.upStats : null,
        G_UP,
        scaleMax,
        !state.doUpload ? 'skipped' : state.upUnavailable ? 'n/a on fast.com' : undefined
      ),
      blank(),
      borderLine('╰', '╯', peakSummary(), ipInBorder ? ipText : ''),
    ];
    if (ipText && !ipInBorder) lines.push(ipCaption(ipText));
    return lines;
  }

  // Footer summary: each stream's headline speed (90th percentile, near the
  // sustained peak — how speed tests usually report), coloured to match its
  // bar's gradient.
  function peakSummary() {
    const seg = (stops, text) => BOLD + fg(...gradColor(stops, 0.5)) + text + RESET;
    const parts = [];
    if (state.downStats?.p90 > 0)
      parts.push(seg(G_DOWN, `DOWN ${fmtBits(state.downStats.p90)}`));
    if (state.doUpload && state.upStats?.p90 > 0)
      parts.push(seg(G_UP, `UP ${state.uploadApprox ? '~' : ''}${fmtBits(state.upStats.p90)}`));
    return parts.join('   ');
  }

  function paint(force) {
    const now = performance.now();
    if (!force && now - lastPaint < 40) return;
    lastPaint = now;
    const lines = buildFrame();
    let s = '';
    // Move up by the PREVIOUS frame's height (the IP caption can change the line
    // count once meta loads), then rewrite every line.
    if (!firstPaint && lastLines > 0) s += `\x1b[${lastLines - 1}A`;
    s += lines.map((l) => '\r\x1b[K' + l).join('\n');
    // If the frame shrank, wipe the now-orphaned lines below and step back up to
    // the last content line so the next repaint's cursor math stays aligned.
    if (lines.length < lastLines) {
      const extra = lastLines - lines.length;
      s += '\n\r\x1b[K'.repeat(extra) + `\x1b[${extra}A`;
    }
    process.stdout.write(s);
    firstPaint = false;
    lastLines = lines.length;
  }

  return {
    state,
    paint,
    start() {
      process.stdout.write('\x1b[?25l'); // hide cursor
      paint(true);
    },
    resize() {
      computeDims();
      // Jump to the frame's top and wipe everything below (clears any lines the
      // old, wider frame may have wrapped onto), then repaint fresh.
      if (!firstPaint && lastLines > 0) {
        const up = lastLines > 1 ? `\x1b[${lastLines - 1}A` : '';
        process.stdout.write(up + '\r\x1b[J');
      }
      firstPaint = true;
      lastLines = 0;
      paint(true);
    },
    finish() {
      state.phase = 'done';
      paint(true);
      process.stdout.write('\n\x1b[?25h'); // newline + show cursor
    },
    abort() {
      process.stdout.write('\n\x1b[?25h');
    },
  };
}

async function runTui(opts) {
  const tui = makeTui(opts.upload);
  const session = makeSession();
  let interrupted = false;
  const onSig = () => {
    interrupted = true;
    tui.abort();
    process.exit(130);
  };
  process.on('SIGINT', onSig);
  const onResize = () => tui.resize();
  process.stdout.on('resize', onResize);
  tui.start();
  // Drive the header shimmer independently of data ticks (ping is sparse).
  const anim = setInterval(() => tui.paint(), 90);

  try {
    tui.state.phase = 'ping';
    tui.state.meta = await session.getMeta().catch(() => null);
    tui.state.provider = session.name();
    tui.paint(true);

    const ping = await session.latency(12, (st) => {
      tui.state.pingStats = st;
      tui.paint();
    });
    tui.state.pingStats = ping.stats;
    tui.state.jitter = ping.jitter;

    tui.state.phase = 'down';
    tui.paint(true);
    tui.state.downStats = await session.download((st) => {
      tui.state.downStats = st;
      tui.paint();
    });
    tui.state.provider = session.name(); // may have failed over mid-run

    if (opts.upload) {
      tui.state.phase = 'up';
      tui.paint(true);
      tui.state.upStats = await session.upload((st) => {
        tui.state.upStats = st;
        tui.paint();
      });
      tui.state.provider = session.name();
      if (!tui.state.upStats) tui.state.upUnavailable = true; // provider can't measure it
      tui.state.uploadApprox = session.uploadApprox();
      tui.paint(true);
    }

    if (!interrupted) tui.finish();
  } catch (err) {
    tui.abort();
    throw err;
  } finally {
    clearInterval(anim);
    process.off('SIGINT', onSig);
    process.stdout.off('resize', onResize);
  }
}

// ---- plain output ----------------------------------------------------------

function range(st, fmt) {
  return `${fmt(st.avg)} avg  (min ${fmt(st.min)} / max ${fmt(st.max)})`;
}

// Throughput headline: lead with the 90th percentile (near sustained peak, as
// speed tests report), with the spread behind it.
function speedRange(st, fmt) {
  return `${fmt(st.p90)}  (avg ${fmt(st.avg)} / max ${fmt(st.max)})`;
}

async function runPlain(opts) {
  const session = makeSession();
  const meta = await session.getMeta().catch(() => null);

  const ping = await session.latency(12);
  const down = await session.download();
  const up = opts.upload ? await session.upload() : null;

  if (opts.json) {
    const pack = (s) =>
      s ? { min: s.min, avg: s.avg, max: s.max, p90: s.p90 } : null;
    console.log(
      JSON.stringify(
        {
          provider: session.name(),
          uploadProvider: up ? session.uploadName() : null,
          uploadApprox: up ? session.uploadApprox() : null,
          latencyMs: ping.stats
            ? { ...pack(ping.stats), jitter: ping.jitter }
            : null,
          downloadBps: pack(down),
          uploadBps: pack(up),
          colo: meta?.colo ?? null,
          city: meta?.city ?? null,
          country: meta?.country ?? null,
          ip: meta?.clientIp ?? null,
        },
        null,
        2
      )
    );
    return;
  }

  const out = [];
  if (meta) {
    const where = [meta.colo, meta.country].filter(Boolean).join(' · ');
    out.push(`Testing via ${session.name()}${where ? ' ' + where : ''}`);
  }
  if (ping.stats)
    out.push(`  latency  ${range(ping.stats, fmtMs)}  jitter ${fmtMs(ping.jitter)}`);
  if (down) out.push(`  download ${speedRange(down, fmtBits)}`);
  if (up) {
    const tags = [];
    if (session.uploadName() !== session.name()) tags.push(`via ${session.uploadName()}`);
    if (session.uploadApprox()) tags.push('approx');
    const suffix = tags.length ? `  (${tags.join(', ')})` : '';
    out.push(`  upload   ${speedRange(up, fmtBits)}${suffix}`);
  } else if (opts.upload) {
    out.push(`  upload   unavailable (no usable backend for this connection)`);
  }
  console.log(out.join('\n'));
}

// ---- entry -----------------------------------------------------------------

function parseArgs(argv) {
  const opts = { json: false, upload: true, tui: true };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--no-upload') opts.upload = false;
    else if (a === '--no-tui') opts.tui = false;
    else if (a === '-h' || a === '--help') opts.help = true;
  }
  return opts;
}

function help() {
  console.log(`fast — fast.com (Netflix) speedtest from the command line

Usage:
  fast [options]

Download and upload share one scale (the run's peak = a full bar) so they're
directly comparable; each bar is filled to its average, with a white tick at
the minimum and superscript min/avg/max above. Ping is shown as a number.
Upload uses a send-side measurement and reads on the high side (shown ~approx).

Options:
  --json        Output results as JSON (implies plain output)
  --no-upload   Skip the upload test
  --no-tui      Force plain line output instead of the TUI
  -h, --help    Show this help`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();

  const useTui = opts.tui && !opts.json && process.stdout.isTTY;
  if (useTui) await runTui(opts);
  else await runPlain(opts);
}

if (require.main === module) {
  main().catch((err) => {
    process.stdout.write('\x1b[?25h'); // ensure cursor restored
    console.error('\nfast: ' + (err?.message || err));
    process.exit(1);
  });
} else {
  module.exports = { makeTui, gaugeStats, labelRow, stats, sup, fmtBits, fmtMs, median, percentile };
}
