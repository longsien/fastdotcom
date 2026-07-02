'use strict';

// Unit tests for the pure pieces of fast (formatting, stats, and the
// fixed-width gauge/label renderers). The network and TUI plumbing aren't
// exercised here — these cover the logic that's easy to get subtly wrong
// (rounding, percentile ranks, and keeping rendered rows exactly N columns).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeTui,
  gaugeStats,
  labelRow,
  stats,
  sup,
  fmtBits,
  fmtMs,
  median,
  percentile,
  rollingBps,
  nextChunk,
  parseArgs,
  tuiCapable,
  sampleThroughput,
} = require('./index.js');

// Visible width with ANSI escape sequences stripped (mirrors index.js).
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
// Count braille gauge dots in a rendered bar.
const countDots = (s) => (s.match(/⠿/g) || []).length;

const G = [[0, 0, 0], [255, 255, 255]]; // a trivial 2-stop gradient for rendering

test('fmtBits picks units across the kbps/Mbps/Gbps boundaries', () => {
  assert.equal(fmtBits(500e3), '500 kbps'); // < 1 Mbps → kbps, no decimals
  assert.equal(fmtBits(1e6), '1.0 Mbps'); // exactly 1 Mbps
  assert.equal(fmtBits(480.7e6), '480.7 Mbps');
  assert.equal(fmtBits(999e6), '999.0 Mbps'); // just under the Gbps switch
  assert.equal(fmtBits(1e9), '1.00 Gbps'); // 1000 Mbps → Gbps
  assert.equal(fmtBits(2.5e9), '2.50 Gbps');
});

test('fmtBits rounds before picking a unit at the kbps/Mbps/Gbps boundaries', () => {
  assert.equal(fmtBits(999.96e6), '1.00 Gbps'); // not "1000.0 Mbps"
  assert.equal(fmtBits(999.6e3), '1.0 Mbps'); // not "1000 kbps"
  assert.equal(fmtBits(999.4e3), '999 kbps'); // still below the round-up point
});

test('fmtMs keeps one decimal place', () => {
  assert.equal(fmtMs(0), '0.0 ms');
  assert.equal(fmtMs(25.74), '25.7 ms');
  assert.equal(fmtMs(92.65), '92.7 ms'); // rounds, not truncates
});

test('median handles odd, even, and empty inputs', () => {
  assert.equal(median([3, 1, 2]), 2); // sorts first
  assert.equal(median([1, 2, 3, 4]), 2.5); // mean of the two middles
  assert.equal(median([42]), 42);
  assert.ok(Number.isNaN(median([])));
});

test('percentile uses nearest-rank', () => {
  const xs = [10, 20, 30, 40, 50];
  assert.equal(percentile(xs, 0), 10); // clamps to the first element
  assert.equal(percentile(xs, 1), 50); // and the last
  assert.equal(percentile(xs, 0.9), 50);
  assert.equal(percentile(xs, 0.5), 30);
  assert.ok(Number.isNaN(percentile([], 0.9)));
});

test('stats returns min/avg/max/p90, or null when empty', () => {
  const s = stats([10, 20, 30, 40, 50]);
  assert.equal(s.min, 10);
  assert.equal(s.max, 50);
  assert.equal(s.avg, 30);
  assert.equal(s.p90, 50);
  assert.equal(stats([]), null);
  assert.equal(stats(null), null);
});

test('rollingBps reports throughput over the trailing ~1s window', () => {
  // Five 200ms windows (= 1s) each carrying 25 MB → one rolling sample.
  const fine = Array.from({ length: 5 }, () => ({ bytes: 25e6, dur: 200 }));
  const r = rollingBps(fine, 5);
  assert.equal(r.length, 1); // one full 1s window available
  assert.equal(r[0], (125e6 * 8) / 1); // 125 MB over 1s = 1 Gbps
});

test('rollingBps emits nothing until a full roll window exists', () => {
  const fine = Array.from({ length: 3 }, () => ({ bytes: 10e6, dur: 200 }));
  assert.deepEqual(rollingBps(fine, 5), []); // <5 windows → no sustained sample yet
});

test('rollingBps smooths a single-window burst far below the raw fine peak', () => {
  const steady = { bytes: 10e6, dur: 200 }; // 400 Mbps fine window
  const burst = { bytes: 30e6, dur: 200 }; // 1.2 Gbps fine window
  const fine = [steady, steady, steady, steady, burst];
  const r = rollingBps(fine, 5);
  assert.equal(r.length, 1);
  const rawBurstBps = (30e6 * 8) / 0.2; // 1.2 Gbps — what p90-of-200ms would latch onto
  assert.ok(r[0] < rawBurstBps); // rolling window dilutes the burst
  assert.equal(Math.round(r[0]), Math.round((70e6 * 8) / 1)); // 70 MB over 1s
});

test('rollingBps slides one full window per fine window once warmed', () => {
  const fine = Array.from({ length: 8 }, () => ({ bytes: 5e6, dur: 200 }));
  assert.equal(rollingBps(fine, 5).length, 4); // 8 - 5 + 1
});

test('nextChunk grows toward a ~1s request when the link outruns the size', () => {
  const base = 26e6, cap = 256e6;
  // 26MB delivered in 0.2s → 130 MB/s → a 1s request wants ~130MB.
  const n = nextChunk(base, 26e6, 0.2, base, cap, 1);
  assert.equal(n, 130e6);
  assert.ok(n > base && n < cap);
});

test('nextChunk is grow-only: a slow completion never shrinks below the previous size', () => {
  const base = 26e6, cap = 256e6;
  assert.equal(nextChunk(base, 26e6, 3, base, cap, 1), base); // small "want" → hold base
  assert.equal(nextChunk(100e6, 100e6, 5, base, cap, 1), 100e6); // hold a grown size too
});

test('nextChunk is capped for very fast links', () => {
  const base = 26e6, cap = 256e6;
  assert.equal(nextChunk(base, 26e6, 0.01, base, cap, 1), cap); // 2.6 GB/s → clamped
});

test('nextChunk holds on a zero/invalid duration', () => {
  assert.equal(nextChunk(40e6, 10e6, 0, 26e6, 256e6, 1), 40e6);
});

test('sup maps digits to superscript glyphs', () => {
  assert.equal(sup(0), '⁰');
  assert.equal(sup(123), '¹²³');
  assert.equal(sup(7.6), '⁸'); // rounds before mapping
});

test('gaugeStats renders exactly `width` columns', () => {
  const s = stats([100, 200, 300]);
  for (const w of [10, 24, 46]) {
    assert.equal(countDots(gaugeStats(s, w, G, s.max)), w, `width ${w}`);
  }
});

test('gaugeStats renders an empty track when there is no data', () => {
  assert.equal(countDots(gaugeStats(null, 20, G, 0)), 20);
  assert.equal(countDots(gaugeStats(stats([0]), 20, G, 0)), 20);
});

test('gaugeStats fill grows with the p90 relative to scaleMax', () => {
  const lo = stats([10]); // p90 10
  const hi = stats([90]); // p90 90
  const scale = 100;
  // Unfilled cells are the dim track colour C_TRACK = fg(48,52,64). A higher
  // p90 fills more of the bar, leaving fewer track cells behind. Colour codes
  // are run-coalesced, so count dots under the active colour, not SGRs.
  const trackCells = (s) => {
    const re = /(\x1b\[[0-9;]*m)|(⠿)/g;
    let cur = '';
    let n = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m[1]) cur = m[1];
      else if (cur === '\x1b[38;2;48;52;64m') n++;
    }
    return n;
  };
  assert.ok(trackCells(gaugeStats(hi, 40, G, scale)) < trackCells(gaugeStats(lo, 40, G, scale)));
});

test('gaugeStats coalesces same-colour runs into one escape sequence', () => {
  // p90 = 10 on a 0-100 scale fills 4 of 40 columns; the remaining ~35 track
  // cells share one colour, so the track SGR should be emitted exactly once.
  const out = gaugeStats(stats([10]), 40, G, 100);
  const trackSeqs = (out.match(/38;2;48;52;64/g) || []).length;
  assert.equal(trackSeqs, 1);
});

test('parseArgs rejects unknown options', () => {
  assert.throws(() => parseArgs(['--jsn']), /unknown option '--jsn'/);
  assert.throws(() => parseArgs(['-x']), /unknown option/);
});

test('parseArgs understands --version and -v', () => {
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.ok(!parseArgs([]).version);
});

test('parseArgs parses --duration in both forms and validates the range', () => {
  assert.equal(parseArgs(['--duration', '10']).duration, 10);
  assert.equal(parseArgs(['--duration=10']).duration, 10);
  assert.equal(parseArgs([]).duration, null);
  assert.throws(() => parseArgs(['--duration', '2']), /--duration/);
  assert.throws(() => parseArgs(['--duration', '31']), /--duration/);
  assert.throws(() => parseArgs(['--duration', 'abc']), /--duration/);
  assert.throws(() => parseArgs(['--duration']), /--duration/);
});

test('parseArgs keeps tui tri-state: auto by default, forced by --tui/--no-tui', () => {
  assert.equal(parseArgs([]).tui, 'auto');
  assert.equal(parseArgs(['--tui']).tui, true);
  assert.equal(parseArgs(['--no-tui']).tui, false);
});

test('tuiCapable requires a TTY, no NO_COLOR, and a truecolor hint', () => {
  assert.equal(tuiCapable({ COLORTERM: 'truecolor' }, true), true);
  assert.equal(tuiCapable({ COLORTERM: '24bit' }, true), true);
  assert.equal(tuiCapable({ TERM: 'xterm-direct' }, true), true);
  assert.equal(tuiCapable({ COLORTERM: 'truecolor' }, false), false); // not a TTY
  assert.equal(tuiCapable({ COLORTERM: 'truecolor', NO_COLOR: '1' }, true), false);
  assert.equal(tuiCapable({ COLORTERM: 'truecolor', NO_COLOR: '' }, true), true); // empty = unset per spec
  assert.equal(tuiCapable({ TERM: 'dumb', COLORTERM: 'truecolor' }, true), false);
  assert.equal(tuiCapable({ TERM: 'xterm-256color' }, true), false); // no truecolor hint
});

test('sampleThroughput aborts a stalled run instead of hanging forever', async () => {
  // A worker that never delivers a byte and only ends when aborted. Without a
  // watchdog this hangs: the maxDur check lives in credit(), which never runs.
  const stalled = ({ ctl }) =>
    new Promise((res) => ctl.controller.signal.addEventListener('abort', () => res(), { once: true }));
  const run = assert.rejects(
    sampleThroughput({ streams: 1, window: 50, warmup: 0, maxDur: 100, label: 'download' }, stalled),
    /download stalled/
  );
  const hung = new Promise((res) => setTimeout(() => res('hung'), 3000));
  assert.notEqual(await Promise.race([run.then(() => 'done'), hung]), 'hung');
});

test('sampleThroughput tolerates one dead stream when others deliver', async () => {
  const worker = async ({ idx, credit, ctl, elapsed, maxDur }) => {
    if (idx === 0) throw new Error('stream 0 reset');
    while (!ctl.stopped && elapsed() < maxDur) {
      credit(1e6);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const s = await sampleThroughput({ streams: 2, window: 20, warmup: 0, maxDur: 150 }, worker);
  assert.ok(s && s.avg > 0);
});

test('sampleThroughput still fails when every stream errors', async () => {
  await assert.rejects(
    sampleThroughput({ streams: 2, window: 20, warmup: 0, maxDur: 200 }, async () => {
      throw new Error('boom');
    }),
    /boom/
  );
});

test('TUI frames keep every line the same visible width (shimmer and idle paths)', () => {
  // Exercises the coalesced border/shimmer renderers end-to-end: capture two
  // painted frames (one mid-run with the sweep active, one done/idle) and
  // check every box line is exactly the same visible width.
  const tui = makeTui(true);
  const writes = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => {
    writes.push(s);
    return true;
  };
  try {
    tui.state.meta = { clientIp: '203.0.113.7', colo: 'Melbourne', country: 'AU', city: 'Melbourne' };
    tui.state.provider = 'fast.com';
    tui.state.pingStats = stats([12, 14, 20]);
    tui.state.jitter = 1.2;
    tui.state.downStats = stats([600e6, 700e6, 710e6]);
    tui.state.phase = 'down'; // busy → shimmer sweep active
    tui.paint(true);
    tui.state.phase = 'done'; // idle → single-colour fast paths
    tui.paint(true);
  } finally {
    process.stdout.write = orig;
  }
  // Each paint() flushes one frame in a single write; check them separately
  // (the second frame starts with cursor-up codes to overwrite the first).
  assert.equal(writes.length, 2);
  for (const frame of writes) {
    const lines = frame
      .split('\n')
      .map((l) => l.replace(/\r|\x1b\[[0-9;]*[A-Za-z]/g, '')) // strip CSI + carriage returns
      .filter((l) => l.length > 0);
    assert.ok(lines.length >= 10, `expected a full frame, got ${lines.length} lines`);
    const widths = new Set(lines.map((l) => l.length));
    assert.equal(widths.size, 1, `line widths differ: ${[...widths].join(', ')}`);
  }
});

test('labelRow stays exactly `width` columns wide', () => {
  const s = stats([100, 200, 300, 400]);
  const supSpeed = (v) => sup(v / 1e6);
  for (const w of [12, 24, 40]) {
    assert.equal(visLen(labelRow(s, w, G, supSpeed, s.max)), w, `width ${w}`);
  }
  // Null stats still produce a full-width (blank) row so the layout holds.
  assert.equal(visLen(labelRow(null, 24, G, supSpeed, 0)), 24);
});
