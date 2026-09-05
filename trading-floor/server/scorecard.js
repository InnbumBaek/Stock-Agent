'use strict';

// PIXEL TRADING FLOOR — 판정 성적표 (agent.scorecard/1)
//
// 이 데스크는 매주 의견을 만든다. 그런데 그 의견이 맞았는지 아무도 채점하지
// 않으면, 회의에서 17명의 말이 전부 같은 무게로 읽힌다. 그것이 이 시스템의
// 가장 큰 구멍이었다.
//
// 여기서 하는 일은 셋이다.
//
//   1. **원장으로 채점한다.** stats.js 는 priceLookup 을 주입받는 구조인데,
//      기본 경로(야후)는 포트폴리오사에 쓸 수 없다 — 무기한 선물이 없는
//      종목이고, 사내망에서는 야후 자체가 막힌다. 그래서 원장의 KRX 공식
//      일봉을 priceLookup 으로 넣는다. 지어내는 것이 아니라 이미 받아 둔
//      값을 쓰는 것이다.
//
//   2. **목표가·손절가가 실제로 닿았는지 본다.** 사이드카(floor.run/1)에
//      데스크가 제시한 target·stop 이 남아 있다. 판정 이후의 일봉에서 어느
//      쪽이 먼저 닿았는지는 사후에 명확히 검증된다. 방향 적중률보다 이쪽이
//      회수 판단에 더 직접적이다 — "그 가격에 팔 수 있었나"이기 때문이다.
//
//   3. **못 재는 것을 못 잰다고 적는다.** 개별 에이전트의 적중률은 지금
//      구조로 낼 수 없다. 애널리스트는 자유 텍스트를 내고 방향 라벨이 없다.
//      추정해서 채우면 없는 성적을 지어내는 것이므로 limits 에 명시한다.
//
// 규칙
// - 판정 이후 가격이 없으면 pending 이다. 추측하지 않는다.
// - 표본이 적으면 숫자를 내되 그 사실을 함께 낸다. 30건 미만은 참고용도 아니다.
// - 이 모듈은 읽기만 한다. decisions.json 도 원장도 쓰지 않는다.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const kiBridge = require('./ki-bridge');
const { buildStats } = require('./stats');

const SCHEMA = 'agent.scorecard/1';
const RUN_SCHEMA = 'floor.run/1';
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// 표본이 이만큼은 돼야 숫자를 '경향'이라고 부를 수 있다.
const MIN_MEANINGFUL = 30;

function fin(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

// --- 원장 기반 가격 조회 -------------------------------------------------

/**
 * stats.buildStats 에 넣을 priceLookup 을 만든다.
 *
 * 심볼은 decisions.json 에 resolved.display 로 남는다 — 포트폴리오사는
 * KRX 6자리(또는 신형 단축코드)이고, 그 밖은 SKHYNIX 같은 별칭이다.
 * 원장이 아는 것은 앞쪽뿐이므로, 코드로 해석되지 않으면 null 을 돌려준다.
 * (null = 평가 대기. 그 건은 승률에서 빠진다.)
 */
function makeLedgerPriceLookup(opts = {}) {
  const cfg = opts.cfg;
  return async function ledgerPriceLookup(symbol) {
    const code = kiBridge.krCodeOf(symbol);
    if (!code) return null;
    const payload = await kiBridge.fetchKiCandles(code, { cfg }).catch(() => null);
    if (!payload || !Array.isArray(payload.candles) || !payload.candles.length) return null;
    return { candles: payload.candles };
  };
}

// --- 목표가·손절가 도달 --------------------------------------------------

/**
 * 판정 이후의 일봉에서 target 과 stop 중 어느 쪽이 먼저 닿았는지 본다.
 *
 * 같은 날 봉에서 고가가 target 을, 저가가 stop 을 동시에 넘는 경우가 있다.
 * 일봉만으로는 순서를 알 수 없으므로 그 건은 'ambiguous' 로 둔다 —
 * 유리한 쪽으로 세면 성적표가 조용히 부풀려진다.
 *
 * @returns {{outcome:string, days:number|null}}
 */
function evaluateLevels(rec, candles) {
  const d = (rec && rec.decision) || {};
  const target = fin(d.target);
  const stop = fin(d.stop);
  const action = String(d.action || '').toUpperCase();
  if (target == null && stop == null) return { outcome: 'no_levels', days: null };
  if (action !== 'BUY' && action !== 'SELL' && action !== 'LONG' && action !== 'SHORT') {
    return { outcome: 'flat', days: null }; // 관망에는 도달할 레벨이 없다
  }
  const ts = Date.parse(rec.ts);
  if (!Number.isFinite(ts) || !Array.isArray(candles) || !candles.length) {
    return { outcome: 'pending', days: null };
  }

  // 매수 판정이면 위로 가는 것이 target, 매도 판정이면 아래로 가는 것이 target.
  const long = action === 'BUY' || action === 'LONG';
  const after = candles.filter((c) => Number.isFinite(c.t) && c.t > ts);
  if (!after.length) return { outcome: 'pending', days: null };

  for (let i = 0; i < after.length; i += 1) {
    const c = after[i];
    const hi = fin(c.h);
    const lo = fin(c.l);
    if (hi == null || lo == null) continue;
    const hitTarget = target == null ? false : long ? hi >= target : lo <= target;
    const hitStop = stop == null ? false : long ? lo <= stop : hi >= stop;
    if (hitTarget && hitStop) return { outcome: 'ambiguous', days: i + 1 };
    if (hitTarget) return { outcome: 'target', days: i + 1 };
    if (hitStop) return { outcome: 'stop', days: i + 1 };
  }
  return { outcome: 'open', days: after.length };
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

// --- 사이드카 읽기 -------------------------------------------------------

async function readRuns(dir) {
  const reportsDir = dir || REPORTS_DIR;
  let names;
  try {
    names = await fsp.readdir(reportsDir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (name === 'decisions.json' || name === 'positions.json') continue;
    if (name === 'agent-brief.json') continue;
    let rec;
    try {
      // eslint-disable-next-line no-await-in-loop
      rec = JSON.parse(await fsp.readFile(path.join(reportsDir, name), 'utf8'));
    } catch (_) {
      continue;
    }
    if (rec && rec.schema === RUN_SCHEMA && rec.ts) out.push(rec);
  }
  return out;
}

// --- 조립 ---------------------------------------------------------------

/**
 * 성적표 한 벌. 실패해도 예외를 올리지 않고 ok:false 로 돌려준다 —
 * 성적표가 없다고 브리핑 전체가 서면 안 된다.
 */
async function buildScorecard(opts = {}) {
  const dir = opts.dir || REPORTS_DIR;
  const priceLookup = opts.priceLookup || makeLedgerPriceLookup({ cfg: opts.cfg });

  let stats;
  try {
    stats = await buildStats({ priceLookup, file: path.join(dir, 'decisions.json') });
  } catch (e) {
    return { ok: false, schema: SCHEMA, reason: `${e && e.message ? e.message : e}` };
  }

  const runs = await readRuns(dir);

  // 레벨 도달은 원장 일봉이 있어야 본다. 종목당 한 번만 조회한다.
  const cache = new Map();
  const levelRows = [];
  for (const rec of runs) {
    const sym = rec.krCode || rec.display;
    if (!cache.has(sym)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await priceLookup(sym).catch(() => null);
      cache.set(sym, r && Array.isArray(r.candles) ? r.candles : null);
    }
    const ev = evaluateLevels(rec, cache.get(sym));
    levelRows.push({
      ts: rec.ts,
      code: rec.krCode || null,
      name: rec.nameKo || rec.display || null,
      action: (rec.decision && rec.decision.action) || null,
      target: fin(rec.decision && rec.decision.target),
      stop: fin(rec.decision && rec.decision.stop),
      outcome: ev.outcome,
      days: ev.days,
    });
  }

  const counted = levelRows.filter((r) =>
    ['target', 'stop', 'open', 'ambiguous'].includes(r.outcome)
  );
  const nTarget = counted.filter((r) => r.outcome === 'target').length;
  const nStop = counted.filter((r) => r.outcome === 'stop').length;
  const nOpen = counted.filter((r) => r.outcome === 'open').length;
  const nAmb = counted.filter((r) => r.outcome === 'ambiguous').length;

  const levels = {
    n: counted.length,
    target_hit: nTarget,
    stop_hit: nStop,
    still_open: nOpen,
    ambiguous: nAmb,
    target_rate:
      nTarget + nStop > 0 ? round2((nTarget / (nTarget + nStop)) * 100) : null,
    median_days_to_target: median(
      counted.filter((r) => r.outcome === 'target').map((r) => r.days)
    ),
    rows: levelRows
      .filter((r) => r.outcome !== 'no_levels')
      .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
      .slice(0, 20),
  };

  // 못 재는 것을 적는다. 성적표에서 이 절이 제일 중요하다 —
  // 없는 성적을 지어내지 않았다는 것이 숫자를 믿을 근거이기 때문이다.
  const limits = [
    '개별 에이전트(TARO·DIANA·FLOW…)의 적중률은 아직 낼 수 없다. ' +
      '애널리스트는 자유 문장을 내고 방향 라벨이 없어, 텍스트에서 방향을 ' +
      '추정하면 없는 성적을 지어내는 것이 된다. 여기 숫자는 전부 ACE 의 최종 판정이다.',
    '수익률은 판정 시점 종가에서 최신 종가까지다. 건마다 보유 기간이 달라 ' +
      '서로 직접 비교할 수 없다.',
    '목표가 도달은 일봉의 고가·저가로 본다. 장중에 스쳤어도 도달로 세므로 ' +
      '실제로 그 가격에 체결됐다는 뜻은 아니다.',
  ];
  if (nAmb > 0) {
    limits.push(
      `같은 날 목표가와 손절가에 모두 닿은 ${nAmb}건은 일봉으로 순서를 알 수 없어 ` +
        '어느 쪽으로도 세지 않았다.'
    );
  }

  const evaluated = (stats.overall && stats.overall.evaluated) || 0;
  const notes = [];
  if (evaluated === 0) {
    notes.push('평가할 수 있는 판정이 아직 없다 — 판정 이후의 일봉이 쌓여야 채점된다');
  } else if (evaluated < MIN_MEANINGFUL) {
    notes.push(
      `표본 ${evaluated}건 — ${MIN_MEANINGFUL}건 미만이라 경향으로 읽으면 안 된다`
    );
  } else {
    notes.push(`표본 ${evaluated}건 — 참고용(표본 편향 가능)`);
  }

  return {
    ok: true,
    schema: SCHEMA,
    as_of: new Date().toISOString(),
    total: stats.total,
    overall: stats.overall,
    calibration: stats.calibration,
    by_confidence: stats.byConfidence,
    recent: stats.recent,
    levels,
    limits,
    note: [notes.join(' · '), stats.note].filter(Boolean).join(' | '),
  };
}

module.exports = {
  SCHEMA,
  buildScorecard,
  makeLedgerPriceLookup,
  evaluateLevels,
  _readRuns: readRuns,
};
