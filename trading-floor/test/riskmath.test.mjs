import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parsePrice, computeRR, positionSize, liquidationPrice, evaluatePlan } = require('../server/riskmath.js');

// ---------------------------------------------------------------- parsePrice

test('parsePrice: 원화 표기와 천단위 콤마', () => {
  assert.equal(parsePrice('1,341,000원'), 1341000);
});

test('parsePrice: 달러 기호와 소수점', () => {
  assert.equal(parsePrice('$1,111.5'), 1111.5);
});

test('parsePrice: 한글이 섞인 서술형 문장에서 첫 가격', () => {
  assert.equal(parsePrice('약 64,500 부근 돌파 시'), 64500);
});

test('parsePrice: 지표 이름에 붙은 숫자(SMA20)는 가격으로 보지 않는다', () => {
  assert.equal(parsePrice('SMA20(64,515) 상향 돌파'), 64515);
  assert.equal(parsePrice('RSI14 과매도, 61,200 지지 확인'), 61200);
});

test('parsePrice: 퍼센트만 있는 문자열은 가격이 아니다', () => {
  assert.equal(parsePrice('+2.35% 상승'), null);
  assert.equal(parsePrice('-1.2%'), null);
});

test('parsePrice: 배수·시간 단위는 건너뛰고 진짜 가격을 찾는다', () => {
  assert.equal(parsePrice('20배 레버리지로 64,500 진입'), 64500);
  assert.equal(parsePrice('15분봉 종가 61,800 이탈 시 손절'), 61800);
});

test('parsePrice: 값이 없거나 입력이 문자열이 아니면 null', () => {
  assert.equal(parsePrice('데이터 없음'), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice({}), null);
  assert.equal(parsePrice('0원'), null); // 0은 가격이 아니다
});

test('parsePrice: 숫자 입력과 소액 코인 가격', () => {
  assert.equal(parsePrice(1341000), 1341000);
  assert.equal(parsePrice(-5), null);
  assert.equal(parsePrice('0.00001234 USDT'), 0.00001234);
});

test('parsePrice: 한글 바로 뒤에 붙은 숫자도 가격으로 읽는다', () => {
  assert.equal(parsePrice('진입가64,500'), 64500);
});

// ----------------------------------------------------------------- computeRR

test('computeRR: 롱 정상 케이스', () => {
  const r = computeRR({ entry: 100, stop: 95, target: 115, side: 'LONG' });
  assert.equal(r.valid, true);
  assert.equal(r.reason, null);
  assert.equal(r.rr, 3);
  assert.equal(r.riskPct, 5);
  assert.equal(r.rewardPct, 15);
});

test('computeRR: 숏 정상 케이스 (문자열 입력도 파싱)', () => {
  const r = computeRR({ entry: '100,000원', stop: '105,000원', target: '90,000원', side: 'SHORT' });
  assert.equal(r.valid, true);
  assert.equal(r.rr, 2);
  assert.equal(r.riskPct, 5);
  assert.equal(r.rewardPct, 10);
});

test('computeRR: 롱인데 손절가가 진입가 위 → 방향 모순', () => {
  const r = computeRR({ entry: 100, stop: 105, target: 115, side: 'LONG' });
  assert.equal(r.valid, false);
  assert.equal(r.rr, null);
  assert.match(r.reason, /롱/);
  assert.match(r.reason, /손절가/);
});

test('computeRR: 숏인데 목표가가 진입가 위 → 방향 모순', () => {
  const r = computeRR({ entry: 100, stop: 105, target: 110, side: 'SHORT' });
  assert.equal(r.valid, false);
  assert.equal(r.rr, null);
  assert.match(r.reason, /숏/);
  assert.match(r.reason, /목표가/);
});

test('computeRR: 가격을 못 읽으면 valid:false + 한국어 사유', () => {
  const r = computeRR({ entry: '데이터 없음', stop: 95, target: 115, side: 'LONG' });
  assert.equal(r.valid, false);
  assert.match(r.reason, /진입가/);
});

// ----------------------------------------------------------- liquidationPrice

test('liquidationPrice: 20배 롱 (유지증거금 0.5%)', () => {
  // 100000 × (1 − 1/20 + 0.005) = 95,500
  const liq = liquidationPrice({ entry: 100000, side: 'LONG', leverage: 20, maintenanceMarginPct: 0.5 });
  assert.equal(liq, 95500);
});

test('liquidationPrice: 20배 숏 (유지증거금 0.5%)', () => {
  // 100000 × (1 + 1/20 − 0.005) = 104,500
  const liq = liquidationPrice({ entry: 100000, side: 'SHORT', leverage: 20, maintenanceMarginPct: 0.5 });
  assert.equal(liq, 104500);
});

test('liquidationPrice: 원화 문자열 진입가도 처리', () => {
  const liq = liquidationPrice({ entry: '64,500원', side: 'LONG', leverage: 20, maintenanceMarginPct: 0.5 });
  assert.equal(liq, 61597.5);
});

test('liquidationPrice: 계산 불가 입력은 null', () => {
  assert.equal(liquidationPrice({ entry: '없음', side: 'LONG', leverage: 20, maintenanceMarginPct: 0.5 }), null);
  assert.equal(liquidationPrice({ entry: 100000, side: 'HOLD', leverage: 20, maintenanceMarginPct: 0.5 }), null);
  assert.equal(liquidationPrice({ entry: 100000, side: 'LONG', leverage: 0, maintenanceMarginPct: 0.5 }), null);
});

// --------------------------------------------------------------- positionSize

test('positionSize: 계좌 규모가 있으면 수량·명목·증거금을 낸다', () => {
  const s = positionSize({ accountSize: 1000, accountRiskPct: 2, entry: 100000, stop: 99000, leverage: 20 });
  assert.equal(s.riskAmount, 20); // 1000 × 2%
  assert.equal(s.qty, 0.02); // 20 / 1000(손절거리)
  assert.equal(s.notional, 2000);
  assert.equal(s.marginRequired, 100);
  assert.equal(s.notionalPctOfAccount, 200);
  assert.equal(s.marginPctOfAccount, 10);
});

test('positionSize: 계좌 규모 0이면 금액은 null, 비율만 채운다', () => {
  const s = positionSize({ accountSize: 0, accountRiskPct: 2, entry: 100000, stop: 99000, leverage: 20 });
  assert.equal(s.qty, null);
  assert.equal(s.notional, null);
  assert.equal(s.marginRequired, null);
  assert.equal(s.riskAmount, null);
  assert.equal(s.notionalPctOfAccount, 200);
  assert.equal(s.marginPctOfAccount, 10);
});

test('positionSize: 손절거리가 0이면 전부 null', () => {
  const s = positionSize({ accountSize: 1000, accountRiskPct: 2, entry: 100000, stop: 100000, leverage: 20 });
  assert.equal(s.qty, null);
  assert.equal(s.notionalPctOfAccount, null);
});

// --------------------------------------------------------------- evaluatePlan

const RISK_CFG = {
  minRR: 1.5,
  accountRiskPct: 2.0,
  accountSize: 1000,
  leverage: 20,
  maintenanceMarginPct: 0.5,
};

test('evaluatePlan: 정상 통과 (강등 없음)', () => {
  const r = evaluatePlan(
    { entry: '100,000', stop: '99,000', target: '103,000', side: 'LONG' },
    RISK_CFG
  );
  assert.equal(r.ok, true);
  assert.equal(r.downgrade, false);
  assert.equal(r.rr, 3);
  assert.equal(r.liq, 95500);
  assert.equal(r.stopBeyondLiq, false);
  assert.equal(r.sizing.qty, 0.02);
  assert.ok(r.reasons.length > 0);
  for (const line of r.reasons) assert.equal(typeof line, 'string');
  assert.ok(r.reasons.some((l) => l.includes('손익비')));
  assert.deepEqual(r.downgradeReasons, []); // 통과했으므로 강등 사유는 없다
});

test('evaluatePlan: 손익비 미달 → 강등', () => {
  const r = evaluatePlan({ entry: 100000, stop: 99000, target: 101000, side: 'LONG' }, RISK_CFG);
  assert.equal(r.rr, 1);
  assert.equal(r.downgrade, true);
  assert.equal(r.ok, false);
  assert.equal(r.stopBeyondLiq, false);
  assert.ok(r.reasons.some((l) => l.includes('손익비') && l.includes('미달')));
  // 강등 사유는 손익비 한 줄만 — 청산 여유 같은 정보성 문장이 섞이면 안 된다
  assert.equal(r.downgradeReasons.length, 1);
  assert.match(r.downgradeReasons[0], /손익비/);
});

test('evaluatePlan: 손절이 청산가 너머 → 강등 (청산이 먼저)', () => {
  // 20배 롱 청산가 95,500 인데 손절이 95,000 → 손절 전에 청산
  const r = evaluatePlan({ entry: 100000, stop: 95000, target: 110000, side: 'LONG' }, RISK_CFG);
  assert.equal(r.rr, 2); // 손익비 자체는 기준 통과
  assert.equal(r.stopBeyondLiq, true);
  assert.equal(r.downgrade, true);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((l) => l.includes('청산')));
});

test('evaluatePlan: 숏에서도 청산 우선 판정이 방향에 맞게 뒤집힌다', () => {
  // 20배 숏 청산가 104,500 인데 손절이 105,000 → 손절 전에 청산
  const r = evaluatePlan({ entry: 100000, stop: 105000, target: 90000, side: 'SHORT' }, RISK_CFG);
  assert.equal(r.liq, 104500);
  assert.equal(r.stopBeyondLiq, true);
  assert.equal(r.downgrade, true);
});

test('evaluatePlan: 가격 파싱 실패 → 강등', () => {
  const r = evaluatePlan(
    { entry: '데이터 없음', stop: '추세선 아래', target: '전고점', side: 'LONG' },
    RISK_CFG
  );
  assert.equal(r.rr, null);
  assert.equal(r.downgrade, true);
  assert.equal(r.ok, false);
  assert.equal(r.stopBeyondLiq, false);
  assert.ok(r.reasons.some((l) => l.includes('읽지 못했습니다')));
  assert.ok(r.downgradeReasons.length >= 1);
  assert.ok(r.downgradeReasons.every((l) => typeof l === 'string' && l.length > 0));
});

test('evaluatePlan: riskCfg가 비어도 DEFAULTS.risk로 동작한다', () => {
  const r = evaluatePlan({ entry: 100000, stop: 99000, target: 103000, action: 'BUY' });
  assert.equal(r.parsed.side, 'LONG'); // BUY → LONG 정규화
  assert.equal(r.parsed.minRR, 1.5);
  assert.equal(r.liq, 95500); // 기본 20배 · 유지증거금 0.5%
  assert.equal(r.ok, true);
  assert.equal(r.sizing.qty, null); // 기본 accountSize 0 → 비율만
  assert.equal(r.sizing.notionalPctOfAccount, 200);
});
