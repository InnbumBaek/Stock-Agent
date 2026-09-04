'use strict';

// Technical-indicator math for the pixel trading floor.
// Input: candles = [{ t, o, h, l, c, v }] ordered oldest -> newest.
// Output: a plain object with price/indicators + Korean summaryLines for prompt injection.
//
// No external dependencies (Node built-ins only).

// --- small helpers -------------------------------------------------------

// Simple moving average of the last `period` values. null if not enough data.
function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

// Exponential moving average series aligned to `values`.
// Seeded at values[0] so every index has a value (robust for short series).
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = values.length ? values[0] : 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI over `period`. null if not enough data.
function wilderRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD(fast, slow, signal). Returns { macd, signal, hist } using the last value.
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length === 0) {
    return { macd: 0, signal: 0, hist: 0 };
  }
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = emaSeries(macdLine, signalPeriod);
  const i = closes.length - 1;
  const m = macdLine[i];
  const s = signalLine[i];
  return { macd: m, signal: s, hist: m - s };
}

// Annualized volatility (%) from daily log-ish simple returns.
function volatility(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev === 0) continue;
    returns.push((closes[i] - prev) / prev);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  return std * Math.sqrt(365) * 100;
}

// --- number formatting for the Korean summary ---------------------------

function fmt(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString('en-US');
  if (abs >= 1) return Number(n.toFixed(dp)).toLocaleString('en-US');
  if (abs >= 0.01) return n.toFixed(4);
  if (abs === 0) return '0';
  return n.toPrecision(4);
}

function signStr(n) {
  return n >= 0 ? '+' : '';
}

// --- main ---------------------------------------------------------------

function computeIndicators(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error('computeIndicators: candles가 비어 있습니다');
  }

  const closes = candles.map((c) => Number(c.c));
  const last = candles[candles.length - 1];
  const prev = candles.length >= 2 ? candles[candles.length - 2] : null;

  const price = Number(last.c);
  const changePct24h =
    prev && Number(prev.c) !== 0
      ? ((price - Number(prev.c)) / Number(prev.c)) * 100
      : 0;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = wilderRsi(closes, 14);
  const macdObj = macd(closes, 12, 26, 9);

  const recent20 = candles.slice(-20);
  const high20 = Math.max(...recent20.map((c) => Number(c.h)));
  const low20 = Math.min(...recent20.map((c) => Number(c.l)));

  const volatilityPct = volatility(closes);

  // Korean summary lines (~5) for prompt injection.
  const rsiTag =
    rsi14 == null ? '데이터 부족' : rsi14 >= 70 ? '과매수' : rsi14 <= 30 ? '과매도' : '중립';
  const smaTrend =
    sma20 == null ? '판단 불가' : price >= sma20 ? 'SMA20 위(강세)' : 'SMA20 아래(약세)';
  const histTag = macdObj.hist >= 0 ? '양(+) 모멘텀' : '음(-) 모멘텀';

  const summaryLines = [
    `현재가 ${fmt(price)} · 전일대비 ${signStr(changePct24h)}${changePct24h.toFixed(2)}%`,
    `SMA20 ${fmt(sma20)} / SMA50 ${fmt(sma50)} — 가격은 ${smaTrend}`,
    `RSI14 ${rsi14 == null ? '-' : rsi14.toFixed(1)} (${rsiTag})`,
    `MACD ${fmt(macdObj.macd, 4)} / 시그널 ${fmt(macdObj.signal, 4)} · 히스토그램 ${histTag}`,
    `최근 20일 고점 ${fmt(high20)} / 저점 ${fmt(low20)} · 연환산 변동성 ${volatilityPct.toFixed(1)}%`,
  ];

  return {
    price,
    changePct24h,
    sma20,
    sma50,
    rsi14,
    macd: macdObj,
    high20,
    low20,
    volatilityPct,
    summaryLines,
  };
}

module.exports = { computeIndicators };
