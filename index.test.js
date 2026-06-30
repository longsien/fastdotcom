'use strict';

// Unit tests for the pure pieces of fast (formatting, stats, and the
// fixed-width gauge/label renderers). The network and TUI plumbing aren't
// exercised here — these cover the logic that's easy to get subtly wrong
// (rounding, percentile ranks, and keeping rendered rows exactly N columns).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
  // p90 fills more of the bar, leaving fewer track cells behind.
  const trackCells = (s) => (s.match(/\x1b\[38;2;48;52;64m/g) || []).length;
  assert.ok(trackCells(gaugeStats(hi, 40, G, scale)) < trackCells(gaugeStats(lo, 40, G, scale)));
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
