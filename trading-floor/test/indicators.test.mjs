import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeIndicators } = require('../server/indicators.js');

// Build candles from an array of closing prices (past -> latest).
// h/l set equal to close so high20/low20 are deterministic from closes.
function candlesFromCloses(closes) {
  return closes.map((c, i) => ({ t: i * 86400000, o: c, h: c, l: c, c, v: 1000 }));
}

// Known sequence: closes 1..30
const closes1to30 = Array.from({ length: 30 }, (_, i) => i + 1);

test('sma20 is the mean of the last 20 closes', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  // last 20 closes are 11..30, mean = (11+30)/2 = 20.5
  assert.equal(r.sma20, 20.5);
});

test('sma50 is null when fewer than 50 candles', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(r.sma50, null);
});

test('high20 and low20 come from the last 20 candles', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(r.high20, 30);
  assert.equal(r.low20, 11);
});

test('rsi14 is within 0..100 and near 100 for a strictly rising series', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.ok(r.rsi14 >= 0 && r.rsi14 <= 100, `rsi out of range: ${r.rsi14}`);
  assert.ok(r.rsi14 >= 99, `rsi should be near 100 for rising series: ${r.rsi14}`);
});

test('rsi14 is near 0 for a strictly falling series', () => {
  const r = computeIndicators(candlesFromCloses([...closes1to30].reverse()));
  assert.ok(r.rsi14 >= 0 && r.rsi14 <= 100, `rsi out of range: ${r.rsi14}`);
  assert.ok(r.rsi14 <= 1, `rsi should be near 0 for falling series: ${r.rsi14}`);
});

test('macd exposes numeric macd/signal/hist fields', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(typeof r.macd.macd, 'number');
  assert.equal(typeof r.macd.signal, 'number');
  assert.equal(typeof r.macd.hist, 'number');
  assert.ok(Number.isFinite(r.macd.macd));
  assert.ok(Number.isFinite(r.macd.signal));
  assert.ok(Number.isFinite(r.macd.hist));
});

test('price and changePct24h reflect the latest candle', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(r.price, 30);
  // prev close 29 -> 30 : (1/29)*100
  assert.ok(Math.abs(r.changePct24h - (1 / 29) * 100) < 1e-9);
});

test('volatilityPct is a finite non-negative number', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.ok(Number.isFinite(r.volatilityPct));
  assert.ok(r.volatilityPct >= 0);
});

test('summaryLines is an array of Korean strings (roughly 5 lines)', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.ok(Array.isArray(r.summaryLines));
  assert.ok(r.summaryLines.length >= 3 && r.summaryLines.length <= 7);
  for (const line of r.summaryLines) {
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 0);
  }
});
