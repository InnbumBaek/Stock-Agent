'use strict';

// PIXEL TRADING FLOOR — 성적표·캘리브레이션 집계
//
// reports/decisions.json에 쌓인 판정을 읽어 "확신도가 실제 적중률과 맞는가"를 본다.
//
// 규칙
// - 판정의 성패는 "판정 이후 가격"이 있어야 알 수 있다. 주입된 priceLookup으로만 구한다.
//   가격이 없으면 그 건은 pending(평가 대기)이고 승률 계산에서 제외한다. 추측하지 않는다.
// - 관망(HOLD/PASS)은 방향이 없으므로 flat으로 분류하고 적중률에 넣지 않는다.
// - 표본이 적으면 note에 한국어로 한계를 명시한다. 숫자만 예쁘게 내지 않는다.
//
// buildStats는 async다. priceLookup이 네트워크 조회(market.js)일 수 있어서
// 계약의 시그니처를 그대로 두되 Promise를 반환한다. 라우트에서 await 하면 된다.

const fs = require('fs');
const path = require('path');

let positionsMod = null;
try {
  positionsMod = require('./positions');
} catch (_) {
  positionsMod = null;
}

const DEFAULT_FILE = path.join(__dirname, '..', 'reports', 'decisions.json');

const BUCKET_ORDER = ['<50', '50-59', '60-69', '70-79', '80-89', '90-100'];
const MODE_KEYS = ['algo', 'scalp', 'attack', 'unknown'];

function round2(n) {
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

// 유한한 숫자면 그 값, 아니면 null. Number(null)===0 함정을 막는다
// (확신도 없음이 "확신도 0"으로 둔갑하면 버킷 집계가 통째로 틀어진다).
function fin(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function decisionsFile(opts) {
  if (opts && opts.file) return opts.file;
  if (process.env.FLOOR_DECISIONS_FILE) return process.env.FLOOR_DECISIONS_FILE;
  return DEFAULT_FILE;
}

// 절대 throw 하지 않는다. 파일 없음·JSON 깨짐 → 빈 배열.
function readDecisions(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((d) => d && typeof d === 'object') : [];
  } catch (_) {
    return [];
  }
}

// 스캘핑 편향이 방향을 주면 그것을 우선, 없으면 action. 관망이면 null.
function sideOf(d) {
  const bias = d.scalpBias != null ? String(d.scalpBias).toUpperCase().trim() : null;
  if (bias === 'LONG' || bias === 'SHORT') return bias;
  const a = String(d.action || '').toUpperCase().trim();
  if (a === 'BUY') return 'LONG';
  if (a === 'SELL') return 'SHORT';
  return null;
}

function bucketOf(v) {
  const conf = fin(v);
  if (conf == null) return null;
  if (conf < 50) return '<50';
  if (conf < 60) return '50-59';
  if (conf < 70) return '60-69';
  if (conf < 80) return '70-79';
  if (conf < 90) return '80-89';
  return '90-100';
}

function modeOf(d) {
  const m = String(d.mode || '').toLowerCase().trim();
  return MODE_KEYS.includes(m) && m !== 'unknown' ? m : 'unknown';
}

// 캔들 정규화: {t,c}만 남기고, 초 단위 타임스탬프면 ms로 올린다.
function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];
  const out = [];
  for (const c of candles) {
    if (!c) continue;
    const t = fin(c.t != null ? c.t : c[0]);
    const close = fin(c.c != null ? c.c : c.close);
    if (t == null || t <= 0 || close == null || close <= 0) continue;
    // 초 단위 타임스탬프(1e12 미만)를 ms로 올린다
    out.push({ t: t < 1e12 ? t * 1000 : t, c: close });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function pending(reason) {
  return { outcome: 'pending', returnPct: null, rawReturnPct: null, horizonDays: null, reason };
}

// 판정 시점 종가 → 사용 가능한 마지막 종가까지의 수익률로 성패를 본다.
// (보유 기간은 건마다 다르므로 horizonDays를 함께 남긴다)
function evaluateDecision(d, candles) {
  const side = sideOf(d);
  if (!side) {
    return {
      outcome: 'flat',
      returnPct: null,
      rawReturnPct: null,
      horizonDays: null,
      reason: '방향 없는 판정(관망) — 적중률 대상 아님',
    };
  }
  const ts = Date.parse(d.ts);
  if (!Number.isFinite(ts)) return pending('판정 시각을 읽을 수 없음');
  const norm = normalizeCandles(candles);
  if (!norm.length) return pending('가격 데이터 없음');

  let baseIdx = -1;
  for (let i = 0; i < norm.length; i++) {
    if (norm[i].t <= ts) baseIdx = i;
    else break;
  }
  if (baseIdx === -1) return pending('판정 시점 이전 가격 없음');
  if (baseIdx === norm.length - 1) return pending('판정 이후 가격 없음');

  const base = norm[baseIdx].c;
  const last = norm[norm.length - 1];
  const raw = ((last.c - base) / base) * 100;
  const adj = side === 'SHORT' ? -raw : raw;
  return {
    outcome: adj > 0 ? 'win' : adj < 0 ? 'loss' : 'even',
    returnPct: round2(adj),
    rawReturnPct: round2(raw),
    horizonDays: round2((last.t - ts) / 86400000),
    reason: null,
  };
}

function emptyAgg() {
  return {
    n: 0,
    evaluated: 0,
    wins: 0,
    losses: 0,
    even: 0,
    pending: 0,
    flat: 0,
    _confSum: 0,
    _confN: 0,
    _retSum: 0,
  };
}

function addToAgg(agg, d, ev) {
  agg.n += 1;
  const conf = fin(d.confidence);
  if (conf != null) {
    agg._confSum += conf;
    agg._confN += 1;
  }
  if (ev.outcome === 'pending') agg.pending += 1;
  else if (ev.outcome === 'flat') agg.flat += 1;
  else {
    agg.evaluated += 1;
    agg._retSum += fin(ev.returnPct) || 0;
    if (ev.outcome === 'win') agg.wins += 1;
    else if (ev.outcome === 'loss') agg.losses += 1;
    else agg.even += 1;
  }
}

function finishAgg(agg) {
  const decided = agg.wins + agg.losses;
  return {
    n: agg.n,
    evaluated: agg.evaluated,
    wins: agg.wins,
    losses: agg.losses,
    even: agg.even,
    pending: agg.pending,
    flat: agg.flat,
    hitRate: decided > 0 ? round2((agg.wins / decided) * 100) : null,
    avgReturnPct: agg.evaluated > 0 ? round2(agg._retSum / agg.evaluated) : null,
    avgConfidence: agg._confN > 0 ? round2(agg._confSum / agg._confN) : null,
  };
}

/**
 * 성적표를 만든다.
 * @param {object} [opts]
 * @param {(symbol:string) => ({candles:Array}|Promise<{candles:Array}>)} [opts.priceLookup]
 *        심볼별 캔들 공급자. 없거나 실패하면 해당 심볼의 판정은 전부 pending이 된다.
 * @param {string} [opts.file] decisions.json 경로(테스트용)
 * @returns {Promise<object>}
 */
async function buildStats(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const priceLookup = typeof o.priceLookup === 'function' ? o.priceLookup : null;
  const decisions = readDecisions(decisionsFile(o));

  // 심볼당 한 번만 조회한다(같은 심볼 판정이 여러 건이므로).
  const cache = new Map();
  async function candlesFor(symbol) {
    if (!priceLookup || !symbol) return null;
    if (cache.has(symbol)) return cache.get(symbol);
    let out = null;
    try {
      const r = await priceLookup(symbol);
      if (r && Array.isArray(r.candles)) out = r.candles;
      else if (Array.isArray(r)) out = r; // 배열을 그대로 준 경우도 받아준다
    } catch (_) {
      out = null; // 조회 실패 = 평가 대기. 지어내지 않는다.
    }
    cache.set(symbol, out);
    return out;
  }

  const byMode = {};
  for (const k of MODE_KEYS) byMode[k] = emptyAgg();
  const byBucket = {};
  for (const k of BUCKET_ORDER) byBucket[k] = emptyAgg();
  const overall = emptyAgg();
  let unbucketed = 0;

  const evaluated = [];
  for (const d of decisions) {
    const symbol = d.symbol ? String(d.symbol).toUpperCase() : null;
    const candles = await candlesFor(symbol);
    const ev = evaluateDecision(d, candles);
    const bucket = bucketOf(d.confidence);

    addToAgg(overall, d, ev);
    addToAgg(byMode[modeOf(d)], d, ev);
    if (bucket) addToAgg(byBucket[bucket], d, ev);
    else unbucketed += 1;

    evaluated.push({
      ts: d.ts || null,
      symbol,
      mode: d.mode || null,
      action: d.action || null,
      confidence: fin(d.confidence),
      scalpBias: d.scalpBias != null ? d.scalpBias : null,
      verdict: d.verdict != null ? d.verdict : null,
      side: sideOf(d),
      outcome: ev.outcome,
      returnPct: ev.returnPct,
      horizonDays: ev.horizonDays,
      reason: ev.reason,
    });
  }

  const byConfidence = BUCKET_ORDER.map((bucket) => {
    const a = finishAgg(byBucket[bucket]);
    return { bucket, ...a };
  });

  // 캘리브레이션: 같은 표본(승패가 갈린 건)에 대해 확신도 평균 vs 실제 적중률.
  // 평가 표본이 없으면 predicted/actual/gap 전부 null — 0으로 채우지 않는다.
  const calibration = BUCKET_ORDER.map((bucket) => {
    const a = byBucket[bucket];
    const decided = a.wins + a.losses;
    const predicted = decided > 0 && a._confN > 0 ? round2(a._confSum / a._confN) : null;
    const actual = decided > 0 ? round2((a.wins / decided) * 100) : null;
    return {
      bucket,
      n: decided,
      predicted,
      actual,
      gap: predicted != null && actual != null ? round2(predicted - actual) : null,
    };
  });

  const recent = evaluated
    .slice()
    .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
    .slice(0, 20);

  const modeOut = {};
  for (const k of MODE_KEYS) modeOut[k] = finishAgg(byMode[k]);

  let posSummary = null;
  try {
    if (positionsMod && typeof positionsMod.summary === 'function') {
      posSummary = positionsMod.summary();
    }
  } catch (e) {
    posSummary = null;
  }

  const total = decisions.length;
  const done = finishAgg(overall);
  const notes = [];
  if (total === 0) {
    notes.push('판정 기록이 없다 — 집계할 것이 없음');
  } else {
    notes.push(
      `평가 가능 표본 ${done.evaluated}건` +
        (done.evaluated < 30 ? ' — 통계적 유의성 없음' : ' — 참고용(표본 편향 가능)')
    );
    notes.push(
      `전체 판정 ${total}건 중 방향성 판정 ${done.evaluated + done.pending}건, ` +
        `평가 대기 ${done.pending}건, 관망 ${done.flat}건`
    );
    if (!priceLookup) {
      notes.push('가격 조회 함수(priceLookup)가 없어 성패를 판정하지 못했다');
    }
    if (done.evaluated > 0) {
      notes.push('수익률은 판정 시점 종가 → 최신 종가 기준이라 건마다 보유 기간이 다르다');
    }
    if (unbucketed > 0) {
      notes.push(`확신도가 없는 판정 ${unbucketed}건은 버킷 집계에서 제외했다`);
    }
  }

  return {
    total,
    overall: done,
    byMode: modeOut,
    byConfidence,
    calibration,
    recent,
    positions: posSummary,
    note: notes.join(' · '),
  };
}

module.exports = { buildStats };
