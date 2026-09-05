import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sc = require('../server/scorecard.js');

// ---------------------------------------------------------------------------
// 성적표 — 이 시스템이 학습하기 시작하는 지점.
//
// 여기서 숫자가 한 칸이라도 유리하게 세어지면, 회의에서 그 성적을 근거로
// 판정에 가중치를 주게 된다. 부풀려진 성적표는 성적표가 없는 것보다 나쁘다.
// ---------------------------------------------------------------------------

const DAY = 86400000;

// t 는 거래일 UTC 자정 epoch(ms) — ki.candles/1 의 계약과 같다.
function candle(dayOffset, { h, l, c = null }) {
  return {
    t: Date.UTC(2026, 8, 1) + dayOffset * DAY,
    o: c ?? l,
    h,
    l,
    c: c ?? h,
    v: 1000,
  };
}

function run(decision, tsOffset = 0) {
  return {
    schema: 'floor.run/1',
    ts: new Date(Date.UTC(2026, 8, 1) + tsOffset * DAY).toISOString(),
    display: '462350',
    krCode: '462350',
    nameKo: '검증사',
    decision,
  };
}

// ------------------------------------------------------------- 레벨 도달

test('매수 판정에서 목표가에 먼저 닿으면 target', () => {
  const r = run({ action: 'BUY', target: 120, stop: 90 });
  const candles = [
    candle(1, { h: 105, l: 100 }),
    candle(2, { h: 125, l: 110 }), // 목표 도달
  ];
  assert.deepEqual(sc.evaluateLevels(r, candles), { outcome: 'target', days: 2 });
});

test('매수 판정에서 손절가에 먼저 닿으면 stop', () => {
  const r = run({ action: 'BUY', target: 120, stop: 90 });
  const candles = [
    candle(1, { h: 105, l: 88 }), // 손절 도달
    candle(2, { h: 125, l: 110 }),
  ];
  assert.deepEqual(sc.evaluateLevels(r, candles), { outcome: 'stop', days: 1 });
});

test('매도 판정은 방향이 뒤집힌다 — 아래가 목표, 위가 손절', () => {
  const r = run({ action: 'SELL', target: 90, stop: 120 });
  const down = [candle(1, { h: 105, l: 88 })];
  assert.equal(sc.evaluateLevels(r, down).outcome, 'target');
  const up = [candle(1, { h: 125, l: 110 })];
  assert.equal(sc.evaluateLevels(r, up).outcome, 'stop');
});

test('같은 날 둘 다 닿으면 어느 쪽으로도 세지 않는다', () => {
  // 일봉으로는 순서를 알 수 없다. 유리한 쪽으로 세면 성적이 조용히 부풀려진다.
  const r = run({ action: 'BUY', target: 120, stop: 90 });
  const candles = [candle(1, { h: 125, l: 85 })];
  assert.deepEqual(sc.evaluateLevels(r, candles), { outcome: 'ambiguous', days: 1 });
});

test('아직 어느 쪽에도 안 닿았으면 open', () => {
  const r = run({ action: 'BUY', target: 120, stop: 90 });
  const candles = [candle(1, { h: 105, l: 100 }), candle(2, { h: 110, l: 95 })];
  const ev = sc.evaluateLevels(r, candles);
  assert.equal(ev.outcome, 'open');
  assert.equal(ev.days, 2);
});

test('판정 이후의 봉이 없으면 pending — 지어내지 않는다', () => {
  const r = run({ action: 'BUY', target: 120, stop: 90 }, 10); // 봉보다 나중에 판정
  const candles = [candle(1, { h: 125, l: 85 })];
  assert.equal(sc.evaluateLevels(r, candles).outcome, 'pending');
  assert.equal(sc.evaluateLevels(r, []).outcome, 'pending');
  assert.equal(sc.evaluateLevels(r, null).outcome, 'pending');
});

test('관망 판정에는 도달할 레벨이 없다', () => {
  const r = run({ action: 'HOLD', target: 120, stop: 90 });
  assert.equal(sc.evaluateLevels(r, [candle(1, { h: 125, l: 85 })]).outcome, 'flat');
});

test('레벨이 아예 없으면 no_levels', () => {
  assert.equal(
    sc.evaluateLevels(run({ action: 'BUY' }), [candle(1, { h: 125, l: 85 })]).outcome,
    'no_levels'
  );
});

test('목표가만 있고 손절가가 없어도 판정한다', () => {
  const r = run({ action: 'BUY', target: 120 });
  assert.equal(sc.evaluateLevels(r, [candle(1, { h: 125, l: 10 })]).outcome, 'target');
});

test('OHLC 가 결측인 봉은 건너뛴다 (0으로 읽지 않는다)', () => {
  // 결측을 0으로 읽으면 저가 0 이 되어 모든 손절가에 닿은 것이 된다.
  const r = run({ action: 'BUY', target: 120, stop: 90 });
  const candles = [
    { t: Date.UTC(2026, 8, 2), o: null, h: null, l: null, c: null, v: 0 },
    candle(2, { h: 125, l: 110 }),
  ];
  assert.equal(sc.evaluateLevels(r, candles).outcome, 'target');
});

// ------------------------------------------------------------- 조립

function tmpReports(decisions, runs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-'));
  fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify(decisions));
  runs.forEach((r, i) => {
    fs.writeFileSync(path.join(dir, `2026-09-0${i + 1}-X-1200.json`), JSON.stringify(r));
  });
  return dir;
}

test('성적표는 원장이 없어도 서지 않는다 (전부 평가 대기)', async () => {
  const dir = tmpReports(
    [{ ts: '2026-09-01T00:00:00Z', symbol: '462350', action: 'BUY', confidence: 70 }],
    [run({ action: 'BUY', target: 120, stop: 90 })]
  );
  const out = await sc.buildScorecard({ dir, priceLookup: async () => null });
  assert.equal(out.ok, true);
  assert.equal(out.total, 1);
  assert.equal(out.overall.evaluated, 0, '가격이 없으면 채점하지 않는다');
  assert.ok(out.note.includes('평가할 수 있는 판정이 아직 없다'));
});

test('못 재는 것을 못 잰다고 적는다', async () => {
  const dir = tmpReports([], []);
  const out = await sc.buildScorecard({ dir, priceLookup: async () => null });
  const limits = out.limits.join(' ');
  assert.ok(limits.includes('개별 에이전트'), '개인별 적중률의 한계를 밝혀야 한다');
  assert.ok(limits.includes('지어내는'), '왜 안 내는지도 적어야 한다');
  assert.ok(limits.includes('일봉'), '목표가 도달의 측정 한계도 밝혀야 한다');
});

test('표본이 적으면 경향으로 읽지 말라고 적는다', async () => {
  const decisions = [];
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    decisions.push({
      ts: new Date(Date.UTC(2026, 8, 1) + i * DAY).toISOString(),
      symbol: '462350',
      action: 'BUY',
      confidence: 70,
    });
    runs.push(run({ action: 'BUY', target: 120, stop: 90 }, i));
  }
  const dir = tmpReports(decisions, runs);
  const candles = [candle(1, { h: 105, l: 100, c: 104 }), candle(9, { h: 130, l: 120, c: 128 })];
  const out = await sc.buildScorecard({ dir, priceLookup: async () => ({ candles }) });
  assert.ok(out.note.includes('30건 미만') || out.note.includes('아직 없다'), out.note);
});

test('같은 날 둘 다 닿은 건이 있으면 한계에 적는다', async () => {
  const dir = tmpReports([], [run({ action: 'BUY', target: 120, stop: 90 })]);
  const candles = [candle(1, { h: 125, l: 85 })];
  const out = await sc.buildScorecard({ dir, priceLookup: async () => ({ candles }) });
  assert.equal(out.levels.ambiguous, 1);
  assert.equal(out.levels.target_hit, 0, '유리한 쪽으로 세면 안 된다');
  assert.ok(out.limits.join(' ').includes('순서를 알 수 없어'));
});

test('목표가 도달률은 목표·손절이 갈린 건으로만 낸다', async () => {
  const runs = [
    run({ action: 'BUY', target: 120, stop: 90 }, 0),
    run({ action: 'BUY', target: 120, stop: 90 }, 1),
  ];
  const dir = tmpReports([], runs);
  // 1건은 목표 도달, 1건은 아직 열려 있음 → 도달률은 1/1 = 100%
  const candles = [candle(5, { h: 125, l: 110 })];
  const out = await sc.buildScorecard({ dir, priceLookup: async () => ({ candles }) });
  assert.equal(out.levels.target_hit, 2);
  assert.equal(out.levels.stop_hit, 0);
  assert.equal(out.levels.target_rate, 100);
});

test('원장 조회가 실패해도 성적표가 예외를 올리지 않는다', async () => {
  const dir = tmpReports([{ ts: '2026-09-01T00:00:00Z', symbol: '462350', action: 'BUY' }], []);
  const out = await sc.buildScorecard({
    dir,
    priceLookup: async () => {
      throw new Error('원장 없음');
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.overall.evaluated, 0);
});
