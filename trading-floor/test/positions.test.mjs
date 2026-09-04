// server/positions.js 단위 테스트.
// stats.js 테스트도 여기 같이 둔다 — 담당 신규 파일이 3개로 제한돼 있어
// test/stats.test.mjs를 따로 만들 수 없기 때문이다(파일 끝 "stats.js" 절 참고).
//
// 실제 reports/positions.json은 절대 건드리지 않는다.
// 임시 디렉터리를 저장소로 지정하고, 테스트가 끝나면 지우고 실제 파일이
// 그대로인지까지 확인한다.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// --- 임시 저장소 준비 (require보다 먼저 환경변수를 세운다) ---------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-pos-'));
const STORE = path.join(TMP, 'positions.json');
const DECISIONS = path.join(TMP, 'decisions.json');
const ENV_BACKUP = {
  pos: process.env.FLOOR_POSITIONS_FILE,
  dec: process.env.FLOOR_DECISIONS_FILE,
};
process.env.FLOOR_POSITIONS_FILE = STORE;
process.env.FLOOR_DECISIONS_FILE = DECISIONS;

const REAL_POSITIONS = fileURLToPath(new URL('../reports/positions.json', import.meta.url));
const REAL_DECISIONS = fileURLToPath(new URL('../reports/decisions.json', import.meta.url));
const realBefore = {
  positions: fs.existsSync(REAL_POSITIONS) ? fs.readFileSync(REAL_POSITIONS, 'utf8') : null,
  decisions: fs.existsSync(REAL_DECISIONS) ? fs.readFileSync(REAL_DECISIONS, 'utf8') : null,
};

const positions = require('../server/positions.js');
const { buildStats } = require('../server/stats.js');
positions._setStoreFile(STORE); // 환경변수와 별개로 한 번 더 못박는다

// riskmath.js는 다른 모듈이 병렬로 만드는 중이라 아직 없을 수 있다.
// 있을 때는 사이징·청산가를 그쪽이 계산하므로, 정확한 수치 단언은 폴백일 때만 한다.
let hasRiskmath = true;
try {
  require('../server/riskmath.js');
} catch (_) {
  hasRiskmath = false;
}

after(() => {
  const nowPositions = fs.existsSync(REAL_POSITIONS)
    ? fs.readFileSync(REAL_POSITIONS, 'utf8')
    : null;
  const nowDecisions = fs.existsSync(REAL_DECISIONS)
    ? fs.readFileSync(REAL_DECISIONS, 'utf8')
    : null;
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  if (ENV_BACKUP.pos === undefined) delete process.env.FLOOR_POSITIONS_FILE;
  else process.env.FLOOR_POSITIONS_FILE = ENV_BACKUP.pos;
  if (ENV_BACKUP.dec === undefined) delete process.env.FLOOR_DECISIONS_FILE;
  else process.env.FLOOR_DECISIONS_FILE = ENV_BACKUP.dec;
  positions._setStoreFile(null);
  assert.equal(nowPositions, realBefore.positions, '실제 reports/positions.json이 변경됐다');
  assert.equal(nowDecisions, realBefore.decisions, '실제 reports/decisions.json이 변경됐다');
});

// --- 헬퍼 ---------------------------------------------------------------

function reset() {
  try {
    fs.rmSync(STORE, { force: true });
  } catch (_) {}
}

const CFG = {
  risk: { leverage: 10, accountSize: 1000000, accountRiskPct: 2, maintenanceMarginPct: 0.5 },
};
const CFG_NOACCT = {
  risk: { leverage: 20, accountSize: 0, accountRiskPct: 2, maintenanceMarginPct: 0.5 },
};

function mkt(symbol, price) {
  return { symbol, display: symbol, indicators: { price } };
}

// --- 저장소 내구성 -------------------------------------------------------

test('저장 파일이 없어도 throw 없이 빈 장부를 준다', () => {
  reset();
  const r = positions.listPositions();
  assert.deepEqual(r.open, []);
  assert.deepEqual(r.closed, []);
  assert.equal(r.summary.openCount, 0);
  assert.equal(r.summary.winRate, null);
});

test('저장 파일이 깨져 있어도 throw 없이 빈 장부로 시작한다', () => {
  reset();
  fs.writeFileSync(STORE, '{ 이건 JSON이 아니다 <<<', 'utf8');
  const r = positions.listPositions();
  assert.deepEqual(r.open, []);
  assert.deepEqual(r.closed, []);
  assert.deepEqual(positions.markToMarket({ ANY: 1 }), []);
  assert.equal(positions.closePosition('없는id', { price: 1 }), null);
  assert.equal(positions.summary().closedCount, 0);
});

test('open/closed 배열이 아닌 쓰레기 형식도 빈 장부로 취급한다', () => {
  reset();
  fs.writeFileSync(STORE, '{"open": 3, "closed": "nope"}', 'utf8');
  const r = positions.listPositions();
  assert.deepEqual(r.open, []);
  assert.deepEqual(r.closed, []);
});

// --- openFromDecision ----------------------------------------------------

test('HOLD이고 스캘핑 판정이 없으면 포지션을 열지 않는다', () => {
  reset();
  const pos = positions.openFromDecision(
    { action: 'HOLD', confidence: 62, entry: '100', stop: '90', target: '130' },
    mkt('AAA', 100),
    CFG
  );
  assert.equal(pos, null);
  assert.deepEqual(positions.listPositions().open, []);
});

test('HOLD이고 스캘핑이 PASS면 포지션을 열지 않는다', () => {
  reset();
  const pos = positions.openFromDecision(
    {
      action: 'HOLD',
      confidence: 62,
      scalp: { bias: 'PASS', entry: '100', stop: '90', target: '130' },
    },
    mkt('AAA', 100),
    CFG
  );
  assert.equal(pos, null);
});

test('스캘핑 LONG은 action HOLD보다 우선한다 (한국주식 가격 문자열 파싱 포함)', () => {
  reset();
  const pos = positions.openFromDecision(
    {
      action: 'HOLD',
      confidence: 71,
      entry: '-',
      stop: '-',
      target: '-',
      scalp: {
        bias: 'LONG',
        entry: '1,341,000원',
        stop: '1,320,000원',
        target: '1,404,000원',
      },
    },
    mkt('SKHYNIX', 1350000),
    CFG_NOACCT
  );
  assert.ok(pos, '포지션이 열려야 한다');
  assert.equal(pos.side, 'LONG');
  assert.equal(pos.entry, 1341000);
  assert.equal(pos.stop, 1320000);
  assert.equal(pos.target, 1404000);
  assert.equal(pos.entrySource, 'plan');
  assert.equal(pos.status, 'open');
  assert.equal(pos.source, 'auto');
  assert.equal(pos.symbol, 'SKHYNIX');
  assert.equal(pos.leverage, 20);
  // 손익비 = 보상 63,000 / 위험 21,000 = 3
  assert.ok(Math.abs(pos.rr - 3) < 0.01, `rr=${pos.rr}`);
  // 계좌 크기 0 → 수량을 지어내지 않는다
  assert.equal(pos.qty, null);
  assert.ok(pos.sizingNote, '계좌 미설정 사유가 남아야 한다');
  assert.ok(pos.liq < pos.entry, 'LONG 청산가는 진입가보다 아래여야 한다');
  assert.equal(positions.listPositions().open.length, 1);
});

test('스캘핑이 없으면 BUY→LONG, SELL→SHORT로 방향을 잡는다', () => {
  reset();
  const long = positions.openFromDecision(
    { action: 'BUY', confidence: 80, entry: 100, stop: 90, target: 130 },
    mkt('AAA', 100),
    CFG_NOACCT
  );
  const short = positions.openFromDecision(
    { action: 'SELL', confidence: 80, entry: 100, stop: 110, target: 80 },
    mkt('BBB', 100),
    CFG_NOACCT
  );
  assert.equal(long.side, 'LONG');
  assert.equal(short.side, 'SHORT');
  assert.ok(short.liq > short.entry, 'SHORT 청산가는 진입가보다 위여야 한다');
  assert.ok(Math.abs(short.rr - 2) < 0.01, `rr=${short.rr}`); // 20 / 10
  assert.notEqual(long.id, short.id);
});

test('진입가가 숫자가 아니면 현재가로 잡고 그 사실을 남긴다', () => {
  reset();
  const pos = positions.openFromDecision(
    { action: 'BUY', confidence: 55, entry: '시장가 진입', stop: '-', target: '-' },
    mkt('AAA', 64500),
    CFG
  );
  assert.equal(pos.entry, 64500);
  assert.equal(pos.entrySource, 'market');
  assert.equal(pos.stop, null);
  assert.equal(pos.target, null);
  assert.equal(pos.rr, null); // 레벨이 없으면 손익비를 만들지 않는다
  assert.equal(pos.qty, null); // 손절이 없으면 수량도 계산하지 않는다
});

test('진입가도 현재가도 없으면 포지션을 열지 않는다', () => {
  reset();
  const pos = positions.openFromDecision(
    { action: 'BUY', confidence: 55, entry: '-', stop: '-', target: '-' },
    { symbol: 'AAA', display: 'AAA' },
    CFG
  );
  assert.equal(pos, null);
});

test('손익비는 방향이 어긋나면 만들지 않는다 (LONG인데 목표가 진입 아래)', () => {
  reset();
  const pos = positions.openFromDecision(
    { action: 'BUY', confidence: 60, entry: 100, stop: 90, target: 95 },
    mkt('AAA', 100),
    CFG_NOACCT
  );
  assert.equal(pos.rr, null);
});

// --- open → markToMarket → close 왕복 ------------------------------------

test('왕복: open → markToMarket → close', () => {
  reset();
  const pos = positions.openFromDecision(
    { action: 'BUY', confidence: 80, entry: 100, stop: 90, target: 130 },
    mkt('TESTX', 100),
    CFG
  );
  assert.ok(pos);
  assert.equal(pos.side, 'LONG');
  assert.ok(Math.abs(pos.rr - 3) < 0.01, `rr=${pos.rr}`);
  assert.ok(pos.qty > 0, '계좌가 있으면 수량이 나와야 한다');
  // 어떤 구현이든 지켜야 할 항등식: 명목 = 수량 × 진입가
  assert.ok(
    Math.abs(pos.notional - pos.qty * pos.entry) < Math.max(1, pos.notional * 0.01),
    `notional=${pos.notional} qty=${pos.qty}`
  );
  if (!hasRiskmath) {
    // riskmath가 없을 때의 폴백 계산: 위험 2% = 20,000원 / 단위위험 10 = 2,000주
    assert.equal(pos.qty, 2000);
    assert.equal(pos.notional, 200000);
    assert.equal(pos.marginRequired, 20000);
    assert.equal(pos.riskAmount, 20000);
    assert.equal(pos.liq, 90.5); // 100 × (1 − 1/10 + 0.005)
  }

  // 1) 상승 — 아직 목표 미달
  let open = positions.markToMarket({ TESTX: 110 });
  assert.equal(open.length, 1);
  assert.equal(open[0].unrealizedPct, 10);
  assert.equal(open[0].roePct, 100); // 10배 레버리지
  assert.equal(open[0].unrealizedAmt, Math.round(10 * pos.qty * 100) / 100);
  assert.equal(open[0].hitTarget, false);
  assert.equal(open[0].hitStop, false);
  assert.equal(open[0].lastPrice, 110);

  // 2) 다른 심볼 시세만 주면 아무것도 바뀌지 않는다 (수치를 지어내지 않는다)
  open = positions.markToMarket({ OTHER: 5 });
  assert.equal(open[0].unrealizedPct, 10);
  open = positions.markToMarket();
  assert.equal(open[0].unrealizedPct, 10);

  // 3) 목표 도달
  open = positions.markToMarket({ TESTX: 130 });
  assert.equal(open[0].hitTarget, true);
  assert.equal(open[0].hitStop, false);

  // 4) 손절 도달
  open = positions.markToMarket({ TESTX: 90 });
  assert.equal(open[0].hitStop, true);
  assert.equal(open[0].hitTarget, false);
  assert.equal(open[0].unrealizedPct, -10);

  // 5) 청산
  const closed = positions.closePosition(pos.id, { price: 130, reason: '목표 도달' });
  assert.ok(closed);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.realizedPct, 30);
  assert.equal(closed.realizedRoePct, 300);
  assert.equal(closed.closeReason, '목표 도달');
  assert.ok(closed.holdMin >= 0);
  assert.equal(closed.unrealizedPct, undefined, '청산 후에는 미실현 필드를 남기지 않는다');

  const list = positions.listPositions();
  assert.equal(list.open.length, 0);
  assert.equal(list.closed.length, 1);
  assert.equal(list.closed[0].id, pos.id);

  // 6) 같은 id를 또 닫아도 throw 없이 null
  assert.equal(positions.closePosition(pos.id, { price: 130 }), null);
  assert.equal(positions.closePosition('없는-id'), null);
});

test('SHORT는 손절/목표 판정 방향이 뒤집힌다', () => {
  reset();
  const pos = positions.openFromDecision(
    { action: 'SELL', confidence: 70, entry: 100, stop: 110, target: 80 },
    mkt('SHRT', 100),
    CFG_NOACCT
  );
  let open = positions.markToMarket({ SHRT: 110 });
  assert.equal(open[0].unrealizedPct, -10);
  assert.equal(open[0].hitStop, true);
  assert.equal(open[0].hitTarget, false);

  open = positions.markToMarket({ SHRT: 80 });
  assert.equal(open[0].unrealizedPct, 20);
  assert.equal(open[0].hitTarget, true);
  assert.equal(open[0].hitStop, false);

  const closed = positions.closePosition(pos.id, { price: 80, reason: '목표' });
  assert.equal(closed.realizedPct, 20);
});

test('청산가를 모르면 실현손익을 0으로 위장하지 않고 null로 남긴다', () => {
  reset();
  const pos = positions.openFromDecision(
    { action: 'BUY', confidence: 60, entry: 100, stop: 90, target: 130 },
    mkt('AAA', 100),
    CFG_NOACCT
  );
  const closed = positions.closePosition(pos.id, { reason: '수동' });
  assert.equal(closed.realizedPct, null);
  assert.equal(closed.realizedRoePct, null);
  assert.ok(closed.note, '사유가 남아야 한다');
  const s = positions.summary();
  assert.equal(s.closedCount, 1);
  assert.equal(s.evaluated, 0);
  assert.equal(s.winRate, null); // 평가 표본 0 → null
});

test('markToMarket 뒤 price 없이 닫으면 마지막 평가가를 쓴다', () => {
  reset();
  const pos = positions.openFromDecision(
    { action: 'BUY', confidence: 60, entry: 100, stop: 90, target: 130 },
    mkt('AAA', 100),
    CFG_NOACCT
  );
  positions.markToMarket({ AAA: 120 });
  const closed = positions.closePosition(pos.id, { reason: '수동' });
  assert.equal(closed.exitPrice, 120);
  assert.equal(closed.realizedPct, 20);
});

// --- summary -------------------------------------------------------------

function openAndClose(symbol, exit) {
  const pos = positions.openFromDecision(
    { action: 'BUY', confidence: 70, entry: 100, stop: 90, target: 130 },
    mkt(symbol, 100),
    { risk: { leverage: 1, accountSize: 0, accountRiskPct: 2, maintenanceMarginPct: 0.5 } }
  );
  return positions.closePosition(pos.id, { price: exit, reason: '테스트' });
}

test('summary: 승률·손익비·기대값을 표본대로 계산한다', () => {
  reset();
  openAndClose('T1', 130); // +30%
  openAndClose('T2', 90); // -10%
  openAndClose('T3', 105); // +5%

  const s = positions.summary();
  assert.equal(s.openCount, 0);
  assert.equal(s.closedCount, 3);
  assert.equal(s.evaluated, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.winRate, 66.67); // 2/3
  assert.equal(s.avgWinPct, 17.5); // (30+5)/2
  assert.equal(s.avgLossPct, -10);
  assert.equal(s.profitFactor, 3.5); // 35 / 10
  assert.equal(s.expectancyPct, 8.33); // (30-10+5)/3
  assert.ok(Math.abs(s.avgRR - 3) < 0.01, `avgRR=${s.avgRR}`);
  assert.ok(/표본 3건/.test(s.note), `note=${s.note}`);
});

test('summary: 전승이면 profitFactor를 0이나 Infinity로 만들지 않고 null로 둔다', () => {
  reset();
  openAndClose('T1', 130);
  const s = positions.summary();
  assert.equal(s.winRate, 100);
  assert.equal(s.losses, 0);
  assert.equal(s.avgLossPct, null);
  assert.equal(s.profitFactor, null);
  assert.equal(s.expectancyPct, 30);
});

test('summary: 표본이 0이면 전부 null이고 0으로 위장하지 않는다', () => {
  reset();
  const s = positions.summary();
  assert.equal(s.openCount, 0);
  assert.equal(s.closedCount, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.avgWinPct, null);
  assert.equal(s.avgLossPct, null);
  assert.equal(s.profitFactor, null);
  assert.equal(s.expectancyPct, null);
  assert.equal(s.avgRR, null);
  assert.ok(s.note);
});

// --- stats.js ------------------------------------------------------------

const DAY = 86400000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function writeDecisions(arr) {
  fs.writeFileSync(DECISIONS, JSON.stringify(arr, null, 2), 'utf8');
}

const SAMPLE = [
  {
    ts: '2026-01-02T00:00:00.000Z',
    symbol: 'AAA',
    mode: 'scalp',
    action: 'BUY',
    confidence: 72,
    scalpBias: 'LONG',
  },
  {
    ts: '2026-01-02T00:00:00.000Z',
    symbol: 'AAA',
    mode: 'scalp',
    action: 'SELL',
    confidence: 85,
    scalpBias: 'SHORT',
  },
  {
    ts: '2026-01-02T00:00:00.000Z',
    symbol: 'AAA',
    mode: 'algo',
    action: 'HOLD',
    confidence: 62,
    scalpBias: 'PASS',
  },
];

// 2026-01-01 종가 100 → 2026-01-03 종가 110 (+10%)
const CANDLES_AAA = {
  candles: [
    { t: T0, c: 100 },
    { t: T0 + 2 * DAY, c: 110 },
  ],
};

test('stats: 판정 기록이 깨져 있으면 빈 성적표를 준다', async () => {
  reset();
  fs.writeFileSync(DECISIONS, 'not json at all', 'utf8');
  const s = await buildStats({});
  assert.equal(s.total, 0);
  assert.equal(s.recent.length, 0);
  assert.equal(s.byConfidence.length, 6);
  assert.ok(/판정 기록이 없다/.test(s.note), s.note);
});

test('stats: priceLookup이 없으면 전 건 pending이고 승률을 만들지 않는다', async () => {
  reset();
  writeDecisions(SAMPLE);
  const s = await buildStats({});
  assert.equal(s.total, 3);
  assert.equal(s.overall.evaluated, 0);
  assert.equal(s.overall.pending, 2); // 방향이 있는 2건
  assert.equal(s.overall.flat, 1); // 관망 1건
  assert.equal(s.overall.hitRate, null);
  for (const b of s.byConfidence) assert.equal(b.hitRate, null);
  for (const c of s.calibration) {
    assert.equal(c.predicted, null);
    assert.equal(c.actual, null);
    assert.equal(c.gap, null);
  }
  assert.ok(/평가 가능 표본 0건 — 통계적 유의성 없음/.test(s.note), s.note);
  assert.ok(/priceLookup/.test(s.note), s.note);
});

test('stats: priceLookup이 있으면 판정 이후 가격으로 성패를 가른다', async () => {
  reset();
  writeDecisions(SAMPLE);
  let calls = 0;
  const s = await buildStats({
    priceLookup: async (sym) => {
      calls += 1;
      return sym === 'AAA' ? CANDLES_AAA : null;
    },
  });
  assert.equal(calls, 1, '같은 심볼은 한 번만 조회해야 한다');
  assert.equal(s.total, 3);
  assert.equal(s.overall.evaluated, 2);
  assert.equal(s.overall.wins, 1); // LONG +10%
  assert.equal(s.overall.losses, 1); // SHORT -10%
  assert.equal(s.overall.flat, 1);
  assert.equal(s.overall.hitRate, 50);

  const b70 = s.byConfidence.find((b) => b.bucket === '70-79');
  assert.equal(b70.n, 1);
  assert.equal(b70.hitRate, 100);
  assert.equal(b70.avgReturnPct, 10);
  const b80 = s.byConfidence.find((b) => b.bucket === '80-89');
  assert.equal(b80.hitRate, 0); // 실제로 틀린 것이지 표본 없음이 아니다
  assert.equal(b80.avgReturnPct, -10);
  const b60 = s.byConfidence.find((b) => b.bucket === '60-69');
  assert.equal(b60.n, 1);
  assert.equal(b60.flat, 1);
  assert.equal(b60.hitRate, null); // 관망은 적중률 대상이 아니다

  const c70 = s.calibration.find((c) => c.bucket === '70-79');
  assert.equal(c70.predicted, 72);
  assert.equal(c70.actual, 100);
  assert.equal(c70.gap, -28); // 확신도보다 실제가 더 좋았다

  assert.equal(s.byMode.scalp.n, 2);
  assert.equal(s.byMode.algo.n, 1);
  assert.equal(s.byMode.attack.n, 0);
  assert.equal(s.recent.length, 3);
  assert.ok(s.positions, 'positions 요약이 붙어야 한다');
  assert.ok(/평가 가능 표본 2건 — 통계적 유의성 없음/.test(s.note), s.note);
});

test('stats: priceLookup이 던지거나 데이터가 부족하면 pending으로 남긴다', async () => {
  reset();
  writeDecisions([
    SAMPLE[0],
    {
      ts: '2026-06-01T00:00:00.000Z', // 캔들 마지막보다 뒤 → 이후 가격 없음
      symbol: 'AAA',
      mode: 'scalp',
      action: 'BUY',
      confidence: 90,
      scalpBias: 'LONG',
    },
    { ts: '2026-01-02T00:00:00.000Z', symbol: 'BBB', mode: 'algo', action: 'BUY', confidence: 75 },
  ]);
  const s = await buildStats({
    priceLookup: async (sym) => {
      if (sym === 'BBB') throw new Error('조회 실패');
      return CANDLES_AAA;
    },
  });
  assert.equal(s.total, 3);
  assert.equal(s.overall.evaluated, 1);
  assert.equal(s.overall.pending, 2);
  const b90 = s.byConfidence.find((b) => b.bucket === '90-100');
  assert.equal(b90.pending, 1);
  assert.equal(b90.hitRate, null);
  const rec = s.recent.find((r) => r.symbol === 'BBB');
  assert.equal(rec.outcome, 'pending');
  assert.ok(rec.reason, '왜 평가 못 했는지 사유가 있어야 한다');
});
