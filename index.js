#!/usr/bin/env node
'use strict';

// fast — a tiny CLI that measures your connection using fast.com (Netflix
// Open Connect) as its backend. Zero dependencies.
//
// On a TTY it renders a small btop-style TUI: each metric is a gauge scaled
// 0 → max (this run), gradient-filled to the 90th percentile, with a white tick
// at the minimum and superscript min/p90/max labels above. Piped (or --json)
// output falls back to plain text.

const https = require('node:https');

// ---- formatting ------------------------------------------------------------

function fmtBits(bitsPerSec) {
  const mbps = bitsPerSec / 1e6;
  // Unit thresholds sit where toFixed rounds up, so 999.96 Mbps prints as
  // "1.00 Gbps" rather than "1000.0 Mbps" (and likewise at the kbps edge).
  if (mbps >= 999.95) return (mbps / 1000).toFixed(2) + ' Gbps';
  if (mbps < 0.9995) return (bitsPerSec / 1e3).toFixed(0) + ' kbps';
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

// Turn a series of completed fine windows ({ bytes, dur } in ms) into a rolling
// throughput series: at each window, the bps over the trailing `roll` windows
// (~1s when roll·WINDOW ≈ 1000ms). Sampling throughput over ~1s — rather than a
// raw 200ms window — is what a network monitor and other speed tests report, so
// a high percentile of THIS series reflects sustained rate instead of latching
// onto a sub-second burst. Emits only once a full roll window exists.
function rollingBps(fine, roll) {
  const out = [];
  for (let i = roll - 1; i < fine.length; i++) {
    let bytes = 0;
    let dur = 0;
    for (let j = i - roll + 1; j <= i; j++) {
      bytes += fine[j].bytes;
      dur += fine[j].dur;
    }
    if (dur > 0) out.push((bytes * 8) / (dur / 1000));
  }
  return out;
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

// Query the terminal for its background colour via OSC 11.  Returns true if
// the background is light, false if dark (or on detection failure).
async function detectLightBg() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const prevRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    let resolved = false;
    let cleaned = false;
    let drain = null;
    const onData = (chunk) => { buf += chunk.toString(); };
    stdin.on('data', onData);

    // Send OSC 11 query (request background colour).
    process.stdout.write('\x1b]11;?\x07');

    const finish = (light) => {
      if (resolved) return;
      resolved = true;
      resolve(light);
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(poll);
      clearTimeout(timer);
      clearTimeout(drain);
      stdin.removeListener('data', onData);
      stdin.setRawMode(prevRaw);
      stdin.pause();
      finish(false);
    };

    const check = () => {
      const m = buf.match(/\x1b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i);
      if (m) {
        const r = parseInt(m[1], 16) >> (m[1].length > 2 ? 8 : 0);
        const g = parseInt(m[2], 16) >> (m[2].length > 2 ? 8 : 0);
        const b = parseInt(m[3], 16) >> (m[3].length > 2 ? 8 : 0);
        finish(0.299 * r + 0.587 * g + 0.114 * b > 128);
        cleanup();
      }
    };
    const poll = setInterval(check, 10);
    // No reply by the deadline: assume dark and get going, but keep draining
    // stdin briefly — over a slow link (SSH) the reply can arrive late, and
    // once we stop reading it would leak into the shell as garbage keystrokes.
    const timer = setTimeout(() => {
      finish(false);
      drain = setTimeout(cleanup, 400);
    }, 250);
  });
}

// Palette: switch colours depending on detected background.
const DARK = {
  border: [88, 96, 112],
  title: [122, 222, 255],
  label: [210, 215, 225],
  mute: [120, 128, 145],
  track: [48, 52, 64],
  tick: [255, 255, 255],
  maxtick: [96, 104, 122],
  shimmerBase: [88, 96, 112],
  shimmerGlow: [165, 176, 198],
  shimmerText: [120, 128, 145],
  shimmerTextGlow: [185, 192, 208],
  gPing: [[52, 211, 153], [250, 204, 21], [239, 68, 68]],
  gDown: [[196, 181, 253], [167, 139, 250], [139, 92, 246]],
  gUp: [[249, 168, 212], [244, 114, 182], [236, 72, 153]],
};

// Night Owl Light — terminal palette from Sarah Drasner's VS Code theme.
const LIGHT = {
  border:    [147, 161, 161], // white   — muted, recedes
  title:     [40, 142, 215],  // blue    — #288ed7, the signature accent
  label:     [64, 63, 83],    // fg      — #403f53, main foreground
  mute:      [147, 161, 161], // white   — #93A1A1, subdued
  track:     [230, 230, 230], // between bg #F6F6F6 and selection #E0E0E0
  tick:      [64, 63, 83],    // fg      — #403f53, strong contrast
  maxtick:   [180, 185, 190], // subtle in the track
  shimmerBase:     [147, 161, 161], // white resting
  shimmerGlow:     [90, 95, 110],  // darken toward fg
  shimmerText:     [147, 161, 161], // white resting
  shimmerTextGlow: [90, 95, 110],  // darken toward fg
  gPing: [[8, 145, 106], [224, 175, 2], [222, 61, 59]], // green→yellow→red
  gDown: [[42, 162, 152], [40, 142, 215], [214, 67, 138]], // cyan→blue→magenta
  gUp:   [[224, 175, 2], [214, 67, 138], [222, 61, 59]], // yellow→magenta→red
};

let T; // active theme — set by initTheme()

function theme(light) {
  T = light ? LIGHT : DARK;
}
theme(false); // default dark; initTheme() overrides before first paint

function C_BORDER() { return fg(...T.border); }
function C_TITLE() { return fg(...T.title); }
function C_LABEL() { return fg(...T.label); }
function C_MUTE() { return fg(...T.mute); }
function C_TRACK() { return fg(...T.track); }
function C_TICK() { return BOLD + fg(...T.tick); }
function C_MAXTICK() { return fg(...T.maxtick); }

const SHIMMER_EDGE = 0.4;

// Gradient stops (left → right across a gauge).
const PING_SCALE = 150; // ms mapped to the full green→red range

function G_PING() { return T.gPing; }
function G_DOWN() { return T.gDown; }
function G_UP() { return T.gUp; }

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

// A gauge of `width` columns scaled 0 → scaleMax: gradient-filled to st.p90,
// with a white tick at st.min; the rest is a dim track. Download and upload
// pass a shared scaleMax so their bars are directly comparable.
function gaugeStats(st, width, stops, scaleMax) {
  const max = scaleMax || (st && st.max) || 0;
  if (!st || max <= 0) return C_TRACK() + DOT.repeat(width) + RESET;
  const fill = Math.round(Math.min(1, st.p90 / max) * width);
  const minIdx = clampIdx(Math.min(1, st.min / max), width);
  const maxIdx = clampIdx(Math.min(1, st.max / max), width);
  // Emit a colour code only when it changes — long same-colour runs (the dim
  // track especially) collapse to one SGR instead of one per character, which
  // shrinks each repaint several-fold on slow terminals/SSH.
  let out = '';
  let last = null;
  const put = (color, ch) => {
    if (color !== last) {
      out += color;
      last = color;
    }
    out += ch;
  };
  for (let i = 0; i < width; i++) {
    if (i === minIdx) {
      put(C_TICK(), DOT); // bright min marker
    } else if (i < fill) {
      const t = width > 1 ? i / (width - 1) : 0;
      const [r, g, b] = gradColor(stops, t);
      put(fg(r, g, b), DOT);
    } else if (i === maxIdx) {
      put(C_MAXTICK(), DOT); // faint max marker in the track
    } else {
      put(C_TRACK(), DOT);
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
  // Same run-coalescing as gaugeStats: repeat a colour code only on change.
  // Spaces render identically under any foreground, so they don't break a run.
  let out = '';
  let last = null;
  for (const c of cells) {
    const color = c.ch !== ' ' ? c.color : null;
    if (color && color !== last) {
      out += color;
      last = color;
    }
    out += c.ch;
  }
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

// The min/p90/max superscript row that sits above a gauge, positioned on the
// shared scaleMax.
function labelRow(st, width, stops, fmtSup, scaleMax) {
  const cells = newCells(width);
  const max = scaleMax || (st && st.max) || 0;
  if (st && max > 0) {
    const p90F = Math.min(1, st.p90 / max);
    const [r, g, b] = gradColor(stops, p90F);
    // The gradient fills columns 0…fill-1, so the bar visually ends at fill-1.
    // min/max have ticks drawn at their clampIdx column; p90 has none, so anchor
    // it to the last filled dot rather than the first empty cell past it.
    const p90Idx = Math.max(0, Math.round(p90F * width) - 1);
    placeLabels(cells, [
      // Each label's right edge sits on its own marker (min tick, p90 fill end,
      // max tick); placeLabels nudges them apart only if they crowd.
      { text: fmtSup(st.min), anchor: clampIdx(Math.min(1, st.min / max), width), align: 'right', color: C_TICK() },
      { text: fmtSup(st.p90), anchor: p90Idx, align: 'right', color: BOLD + fg(r, g, b) },
      { text: fmtSup(st.max), anchor: clampIdx(Math.min(1, st.max / max), width), align: 'right', color: C_MUTE() },
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

// fetch with a deadline and a readable timeout message. The bulk-transfer
// paths manage their own AbortController (plus the sampler's watchdog); this
// covers the small one-shot requests — discovery and latency probes — that
// would otherwise hang forever on a stalled connection.
async function timedFetch(url, ms, what, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new Error(`${what} timed out`);
    throw e;
  }
}

// Generic parallel-throughput sampler. Runs `streams` worker loops in parallel;
// each worker repeatedly transfers data and calls `credit(bytes)` for every
// chunk/request. We aggregate credited bytes across ALL workers into fixed
// time windows (JS is single-threaded, so the shared counters need no locking)
// and discard the first `warmup` windows as ramp-up. Returns min/avg/max/p90.
async function sampleThroughput(opts, worker, onTick) {
  const { streams, window: WINDOW, warmup: WARMUP, maxDur: MAXDUR, rollMs = 1000, label = 'transfer' } = opts;
  // How many fine windows make up the ~1s rolling window the headline reports.
  const roll = Math.max(1, Math.round(rollMs / WINDOW));
  const fine = []; // post-warmup fine windows: { bytes, dur }
  const fineBps = []; // their raw bps — a live fallback until 1s of data exists
  const start = performance.now();
  const ctl = { stopped: false, controller: new AbortController() };
  let winBytes = 0;
  let winStart = start;
  let widx = 0;

  // Headline stats run over the rolling 1s series; before a full 1s exists, fall
  // back to the raw fine windows so the live gauge still moves.
  const series = () => {
    const roll1s = rollingBps(fine, roll);
    return stats(roll1s.length ? roll1s : fineBps);
  };

  function credit(len) {
    winBytes += len;
    const now = performance.now();
    if (now - winStart >= WINDOW) {
      const dur = now - winStart;
      if (widx >= WARMUP) {
        fine.push({ bytes: winBytes, dur });
        fineBps.push((winBytes * 8) / (dur / 1000));
      }
      widx++;
      winBytes = 0;
      winStart = now;
      if (onTick) onTick(series());
      if (now - start >= MAXDUR) {
        ctl.stopped = true;
        ctl.controller.abort();
      }
    }
  }
  const elapsed = () => performance.now() - start;

  // Watchdog: credit() enforces maxDur only while data is flowing, so a fully
  // stalled connection would otherwise hang the run forever (the workers block
  // in a body read / drain wait that only ends on abort). Fires a beat after
  // the deadline so the normal in-band shutdown wins whenever data moves.
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    ctl.stopped = true;
    ctl.controller.abort();
  }, MAXDUR + 500);

  // allSettled, not all: one stream dying (a reset, a stray 429) mustn't throw
  // away an otherwise-valid measurement — the surviving streams keep sampling.
  // Only if EVERY stream failed is the reading meaningless; then surface the
  // first real error.
  const results = await Promise.allSettled(
    Array.from({ length: streams }, (_, idx) =>
      worker({ idx, credit, ctl, elapsed, maxDur: MAXDUR })
    )
  );
  clearTimeout(watchdog);

  // Record the final partial window so a short tail isn't dropped. Require at
  // least half a window so a tiny sliver can't divide out to a wild bps.
  const tail = performance.now() - winStart;
  if (winBytes > 0 && tail >= WINDOW / 2 && widx >= WARMUP) {
    fine.push({ bytes: winBytes, dur: tail });
    fineBps.push((winBytes * 8) / (tail / 1000));
  }

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length === results.length && failures.length) throw failures[0].reason;

  const s = series();
  if (onTick) onTick(s);
  if (!s && watchdogFired) throw new Error(`${label} stalled: no data received`);
  return s;
}

// Pick the next request size from the just-observed per-connection rate so the
// request lasts ~targetSec. GROW-ONLY and capped: small chunks re-sample each
// transfer's fast slow-start head and read high, so we never shrink below the
// previous size (and never below `base`). When a request already takes longer
// than targetSec the computed `want` falls below `prev`, so it naturally holds.
function nextChunk(prev, bytes, secs, base, cap, targetSec) {
  if (!(secs > 0)) return prev; // no clean timing → hold
  const want = Math.ceil((bytes / secs) * targetSec);
  return Math.max(base, Math.min(cap, Math.max(prev, want)));
}

// Stream sized GETs repeatedly, crediting every chunk; `target(streamIdx)` lets
// each worker hit its own fast.com target. The request size adapts upward on
// fast per-connection links (see nextChunk) so we measure sustained throughput
// rather than repeatedly catching transfers' fast starts.
function downloadWorker(target, ranged, base, cap) {
  const TARGET_SEC = 1; // aim for ~1s per request
  return async ({ idx, credit, ctl, elapsed, maxDur }) => {
    let chunk = base;
    while (!ctl.stopped && elapsed() < maxDur) {
      const t0 = performance.now();
      let got = 0;
      let full = true;
      let res;
      try {
        res = await fetch(ranged(target(idx), chunk), { signal: ctl.controller.signal, cache: 'no-store' });
      } catch (e) {
        if (e.name === 'AbortError') return;
        throw e;
      }
      if (!res.ok) throw new Error(httpReason(res.status, 'download'));
      try {
        for await (const c of res.body) {
          credit(c.length);
          got += c.length;
          if (ctl.stopped) { full = false; break; }
        }
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
        full = false;
      }
      // Only re-size off a request that fully completed — an aborted tail has no
      // clean rate, and on a slow link the deadline fires mid-request so the
      // size correctly stays at `base`.
      if (full && got > 0) chunk = nextChunk(chunk, got, (performance.now() - t0) / 1000, base, cap, TARGET_SEC);
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
    const home = await (await timedFetch('https://fast.com/', 10000, 'fast.com discovery')).text();
    const sm = home.match(/<script src="(\/app-[^"]+\.js)"/);
    if (!sm) throw new Error('fast.com: app bundle not found');
    const js = await (await timedFetch('https://fast.com' + sm[1], 10000, 'fast.com discovery')).text();
    const tm = js.match(/token:"([^"]+)"/);
    if (!tm) throw new Error('fast.com: token not found');
    const res = await timedFetch(
      `https://api.fast.com/netflix/speedtest/v2?https=true&token=${tm[1]}&urlCount=5`,
      10000,
      'fast.com discovery'
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
      // Untimed warm-up: the first request pays DNS + TCP + TLS setup, which
      // would otherwise inflate max/avg (and jitter, computed off the mean).
      await timedFetch(url, 5000, 'latency probe', { cache: 'no-store' })
        .then((r) => r.arrayBuffer())
        .catch(() => {}); // a failed warm-up just means no pre-warm; probes still run
      const times = [];
      for (let i = 0; i < samples; i++) {
        const t0 = performance.now();
        const res = await timedFetch(url, 5000, 'latency probe', { cache: 'no-store' });
        await res.arrayBuffer();
        times.push(performance.now() - t0);
        if (onTick) onTick(stats(times));
      }
      const s = stats(times);
      const jitter = median(times.map((t) => Math.abs(t - s.avg)));
      return { stats: s, jitter };
    },
    async download(onTick, maxDur) {
      await ensure();
      const BASE = 26e6; // request size floor — already sustained on normal links
      const CAP = 256e6; // ceiling for very fast per-connection links
      // Open several connections PER target. The Open Connect OCAs sit ~15-20ms
      // out, so a single TCP stream each is window/RTT-limited and under-fills a
      // high-bandwidth link; parallelising multiplies aggregate throughput (and
      // the data used) until it saturates. 4×targets matches what fast.com's own
      // site pulls on a fast connection.
      const PER = 4;
      const streams = targets.length * PER;
      return sampleThroughput(
        { streams, window: 200, warmup: 2, maxDur: maxDur || 6000, label: 'download' },
        downloadWorker((idx) => targets[idx % targets.length], ranged, BASE, CAP),
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
    async upload(onTick, maxDur) {
      await ensure();
      const buf = Buffer.alloc(64 * 1024);
      const CHUNK = 400 * buf.length; // 25 MiB, exact multiple of buf
      // 8 streams is the measured sweet spot: wire-accurate upload peaks at
      // ~8-16 connections, but the send-side reading's over-read climbs with
      // parallelism (1.06× at 8, 1.6× at 24). 8 keeps near-peak real throughput
      // at the lowest over-read; piling on more inflates the figure, not the
      // bytes that actually reach the server.
      const streams = Math.min(8, targets.length * 2);
      return sampleThroughput(
        { streams, window: 200, warmup: 3, maxDur: maxDur ? maxDur + 500 : 6500, label: 'upload' },
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
    mix(T.shimmerBase, T.shimmerGlow, sweepK(col) * gain);

  // A run of `count` identical border chars from column `startCol`, swept.
  // When the shimmer is idle every column is the resting colour, so the whole
  // run is one SGR + repeat; while sweeping, coalesce equal-colour neighbours.
  function borderRun(ch, count, startCol) {
    if (count <= 0) return '';
    if (shimmer == null) return fg(...T.shimmerBase) + ch.repeat(count) + RESET;
    let s = '';
    let last = null;
    for (let i = 0; i < count; i++) {
      const c = borderColor(startCol + i);
      if (c !== last) {
        s += c;
        last = c;
      }
      s += ch;
    }
    return s + RESET;
  }

  // Muted header/footer text (location, IP) that also catches the sweep.
  function sweptText(text, startCol) {
    if (shimmer == null) return fg(...T.shimmerText) + text + RESET;
    let s = '';
    let last = null;
    for (let i = 0; i < text.length; i++) {
      const c = mix(T.shimmerText, T.shimmerTextGlow, sweepK(startCol + i));
      if (c !== last) {
        s += c;
        last = c;
      }
      s += text[i];
    }
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
      (lt ? C_TITLE() + BOLD + lt + RESET : '') +
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
    place(cells, pad('PING', labelW), 0, 'left', active ? C_TICK() : st ? BOLD + C_LABEL() : C_MUTE());
    if (st) {
      // Colour the latency by value: green (low) → red (high).
      const [r, g, b] = gradColor(G_PING(), st.avg / PING_SCALE);
      place(cells, fmtMs(st.avg), labelW + 1, 'left', BOLD + fg(r, g, b));
      const spread =
        `${st.min.toFixed(0)} / ${st.max.toFixed(0)} ms` +
        (state.jitter != null ? `  ±${state.jitter.toFixed(1)}` : '');
      place(cells, spread, body - 1, 'right', C_MUTE());
    } else {
      place(cells, 'measuring…', labelW + 1, 'left', C_MUTE());
    }
    return wrap(renderCells(cells));
  }

  // Two lines: superscript labels above, the gauge below (shared scaleMax).
  function metricBlock(key, label, st, stops, scaleMax, note) {
    const active = state.phase === key;
    const lab =
      (active ? C_TICK() : st ? BOLD + C_LABEL() : C_MUTE()) + pad(label, labelW) + RESET;

    let labels;
    if (note && !st) {
      const cells = newCells(barW);
      place(cells, note, barW >> 1, 'center', C_MUTE());
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
  // Available space for IP in the bottom border: total inner width minus the
  // peak summary (roughly 30-40 chars depending on speeds), some padding, and
  // a minimum run of dashes for visual breathing room.
  function ipInBorderMax() { return Math.max(15, inner - 45); }
  function ipCaption(text) {
    return ' '.repeat(Math.max(0, W - text.length)) + C_MUTE() + text + RESET;
  }

  function buildFrame() {
    const m = state.meta;
    const loc = m
      ? [m.colo, m.country].filter(Boolean).join(' · ') || state.provider || ''
      : 'connecting…';
    const ipText = m && m.clientIp ? m.clientIp : '';
    const ipInBorder = ipText.length <= ipInBorderMax();

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
      ...metricBlock('down', 'DOWN', state.downStats, G_DOWN(), scaleMax),
      ...metricBlock(
        'up',
        'UP',
        state.doUpload ? state.upStats : null,
        G_UP(),
        scaleMax,
        !state.doUpload ? 'skipped' : state.upUnavailable ? 'n/a on fast.com' : undefined
      ),
      blank(),
      borderLine('╰', '╯', peakSummary(scaleMax), ipInBorder ? ipText : ''),
    ];
    if (ipText && !ipInBorder) lines.push(ipCaption(ipText));
    return lines;
  }

  // Footer summary: each stream's headline speed (90th percentile, near the
  // sustained peak — how speed tests usually report), coloured to match its
  // bar's gradient at the p90 fill point.
  function peakSummary(scaleMax) {
    const max = scaleMax || 1;
    const seg = (stops, p90, text) => {
      const t = Math.min(1, p90 / max);
      return BOLD + fg(...gradColor(stops, t)) + text + RESET;
    };
    const parts = [];
    if (state.downStats?.p90 > 0)
      parts.push(seg(G_DOWN(), state.downStats.p90, `DOWN ${fmtBits(state.downStats.p90)}`));
    if (state.doUpload && state.upStats?.p90 > 0)
      parts.push(seg(G_UP(), state.upStats.p90, `UP ${state.uploadApprox ? '~' : ''}${fmtBits(state.upStats.p90)}`));
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
  const light = await detectLightBg();
  theme(light);
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

    const durMs = opts.duration ? opts.duration * 1000 : undefined;
    tui.state.phase = 'down';
    tui.paint(true);
    tui.state.downStats = await session.download((st) => {
      tui.state.downStats = st;
      tui.paint();
    }, durMs);
    tui.state.provider = session.name(); // may have failed over mid-run

    if (opts.upload) {
      tui.state.phase = 'up';
      tui.paint(true);
      tui.state.upStats = await session.upload((st) => {
        tui.state.upStats = st;
        tui.paint();
      }, durMs);
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
  const durMs = opts.duration ? opts.duration * 1000 : undefined;
  // Non-JSON plain output prints each line as its phase completes, so an
  // interactive `--no-tui` run isn't silent for the whole ~15 seconds. JSON
  // stays a single document emitted at the end.
  const say = opts.json ? () => {} : (line) => console.log(line);

  const meta = await session.getMeta().catch(() => null);
  if (meta) {
    const where = [meta.colo, meta.country].filter(Boolean).join(' · ');
    say(`Testing via ${session.name()}${where ? ' ' + where : ''}`);
  }

  const ping = await session.latency(12);
  if (ping.stats)
    say(`  latency  ${range(ping.stats, fmtMs)}  jitter ${fmtMs(ping.jitter)}`);

  const down = await session.download(undefined, durMs);
  if (down) say(`  download ${speedRange(down, fmtBits)}`);

  const up = opts.upload ? await session.upload(undefined, durMs) : null;
  if (up) {
    const tags = [];
    if (session.uploadName() !== session.name()) tags.push(`via ${session.uploadName()}`);
    if (session.uploadApprox()) tags.push('approx');
    const suffix = tags.length ? `  (${tags.join(', ')})` : '';
    say(`  upload   ${speedRange(up, fmtBits)}${suffix}`);
  } else if (opts.upload) {
    say(`  upload   unavailable (no usable backend for this connection)`);
  }

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
  }
}

// ---- entry -----------------------------------------------------------------

function parseArgs(argv) {
  // tui is tri-state: 'auto' picks TUI only on a truecolor-capable TTY (see
  // tuiCapable); --tui / --no-tui force it. duration is seconds per direction.
  const opts = { json: false, upload: true, tui: 'auto', duration: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--no-upload') opts.upload = false;
    else if (a === '--no-tui') opts.tui = false;
    else if (a === '--tui') opts.tui = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--duration' || a.startsWith('--duration=')) {
      const v = a.includes('=') ? a.slice('--duration='.length) : argv[++i];
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n < 3 || n > 30)
        throw new Error(`--duration wants seconds between 3 and 30 (got ${v ?? 'nothing'})`);
      opts.duration = n;
    } else throw new Error(`unknown option '${a}' (try --help)`);
  }
  return opts;
}

// Whether the TUI can render: it's drawn entirely in 24-bit colour, so beyond
// a TTY we want no NO_COLOR (https://no-color.org — any non-empty value wins),
// a real terminal, and a truecolor hint. Without one the gradients would come
// out as approximated or garbled colours — plain output is the honest fallback
// (--tui still forces it for terminals that support truecolor but don't say so).
function tuiCapable(env, isTTY) {
  if (!isTTY) return false;
  if (env.NO_COLOR) return false;
  if (env.TERM === 'dumb') return false;
  if (/truecolor|24bit/i.test(env.COLORTERM || '')) return true;
  if (/-direct/.test(env.TERM || '')) return true;
  return false;
}

function help() {
  console.log(`fast — fast.com (Netflix) speedtest from the command line

Usage:
  fast [options]

Download and upload share one scale (the run's peak = a full bar) so they're
directly comparable; each bar is filled to its 90th percentile (sustained
peak), with a white tick at the minimum and superscript min/p90/max above.
Ping is shown as a number.
Upload uses a send-side measurement and reads on the high side (shown ~approx).

Options:
  --json           Output results as JSON (implies plain output)
  --no-upload      Skip the upload test
  --duration <s>   Seconds per direction, 3-30 (default ~6)
  --tui            Force the TUI (auto-picked on truecolor terminals)
  --no-tui         Force plain line output instead of the TUI
  -v, --version    Print the version
  -h, --help       Show this help

Respects NO_COLOR: when set (or the terminal lacks truecolor support), output
falls back to plain lines.`);
}

async function main() {
  // Piping into e.g. `head` closes stdout early; without this the write fails
  // with an unhandled EPIPE stack trace instead of a quiet exit.
  process.stdout.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(0);
    throw e;
  });

  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();
  if (opts.version) return console.log(require('./package.json').version);

  const useTui =
    !opts.json &&
    process.stdout.isTTY &&
    opts.tui !== false &&
    (opts.tui === true || tuiCapable(process.env, true));
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
  module.exports = { makeTui, gaugeStats, labelRow, stats, sup, fmtBits, fmtMs, median, percentile, rollingBps, nextChunk, parseArgs, tuiCapable, sampleThroughput };
}
