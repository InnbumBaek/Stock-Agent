import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveSymbol, KR_STOCKS } = require('../server/market.js');
const { Engine } = require('../server/engine.js');
const { DEFAULTS } = require('../server/config.js');
const ki = require('../server/ki-bridge.js');

// ---------------------------------------------------------------------------
// KR_STOCKS 밖의 한국 종목 — 포트폴리오사처럼 무기한 선물이 없는 상장사.
// 원장(ki.sqlite)에 시세가 있으면 분석할 수 있어야 한다.
// ---------------------------------------------------------------------------

test('KRX 6자리 코드는 한국 주식으로 해석된다', () => {
  const r = resolveSymbol('000250');
  assert.equal(r.kind, 'krstock');
  assert.equal(r.symbol, '000250');
  assert.equal(r.generic, true, 'KR_STOCKS 밖 종목임이 표시돼야 한다');
  assert.equal(r.yahoo, null, '접미사를 모르면 null — 수집 단계가 .KS → .KQ 로 찾는다');
  assert.equal(r.tapbitPair, null, '무기한 선물이 없다');
});

test('시장 접미사를 주면 그대로 쓴다', () => {
  assert.equal(resolveSymbol('000250.KQ').yahoo, '000250.KQ');
  assert.equal(resolveSymbol('035420.KS').yahoo, '035420.KS');
  assert.equal(resolveSymbol('035420.ks').yahoo, '035420.KS');
});

test('KR_STOCKS 등재 종목은 기존 경로를 그대로 탄다 (회귀 방지)', () => {
  for (const [sym, meta] of Object.entries(KR_STOCKS)) {
    const r = resolveSymbol(sym);
    assert.equal(r.kind, 'krstock');
    assert.equal(r.symbol, sym);
    assert.equal(r.generic, undefined, `${sym} 은 generic 이 아니어야 한다`);
    assert.equal(r.tapbitPair, meta.tapbitPair, '무기한 선물 페어가 유지돼야 한다');
    assert.equal(r.yahoo, meta.yahoo);
  }
  // 코드로 불러도 마찬가지다 (KR_ALIASES 가 우선한다)
  assert.equal(resolveSymbol('000660').symbol, 'SKHYNIX');
  assert.equal(resolveSymbol('005930').symbol, 'SAMSUNG');
});

test('6자리가 아니면 한국 주식으로 보지 않는다', () => {
  assert.notEqual(resolveSymbol('12345').kind, 'krstock');
  assert.notEqual(resolveSymbol('1234567').kind, 'krstock');
  assert.notEqual(resolveSymbol('TSLA').kind, 'krstock');
  assert.notEqual(resolveSymbol('BTC').kind, 'krstock');
});

// ---------------------------------------------------------------------------
// 사이드카 — 회의 자료에는 코드가 아니라 회사명이 찍혀야 한다
// ---------------------------------------------------------------------------

test('종목명은 원장이 채워 준 market.nameKo 를 우선한다', () => {
  const engine = new Engine();
  const rec = engine._runRecord(
    // resolved 에는 이름이 없다 — KR_STOCKS 밖 종목은 코드만 들고 온다
    { symbol: '000250', display: '000250', kind: 'krstock', nameKo: null },
    { krCode: '000250', nameKo: '삼천당제약' }, // 수집 단계에서 원장이 채워 준 이름
    true,
    'algo',
    'x.md',
    [],
    [],
    [],
    [],
    null,
    [],
    { action: 'HOLD' },
    new Date('2026-09-04T00:00:00Z')
  );
  assert.equal(rec.nameKo, '삼천당제약');
  assert.equal(rec.krCode, '000250');
});

test('원장도 이름을 모르면 null — 지어내지 않는다', () => {
  const engine = new Engine();
  const rec = engine._runRecord(
    { symbol: '999999', display: '999999', kind: 'krstock', nameKo: null },
    { krCode: '999999' },
    true,
    'algo',
    'x.md',
    [],
    [],
    [],
    [],
    null,
    [],
    { action: 'HOLD' },
    new Date('2026-09-04T00:00:00Z')
  );
  assert.equal(rec.nameKo, null);
});

// ---------------------------------------------------------------------------
// 실측을 받을 에이전트
// ---------------------------------------------------------------------------

test('최종 판정자(ACE)도 원장 실측을 직접 받는다', () => {
  // 처분에 몇 영업일이 걸리는가는 목표가만큼이나 회수 판단을 좌우한다.
  // 애널리스트를 거친 해석만 받으면 그 숫자가 중간에 사라질 수 있다.
  assert.ok(DEFAULTS.ki.injectInto.includes('ace'));
  assert.ok(ki.DEFAULT_KI.injectInto.includes('ace'));
  assert.deepEqual(DEFAULTS.ki.injectInto, ki.DEFAULT_KI.injectInto);
});

// ---------------------------------------------------------------------------
// 신형 단축코드 — 2024년 이후 신규 상장분은 영문자가 섞인다 (예: 1234A5)
//
// 숫자 6자리만 받으면 그런 종목이 조용히 크립토 티커로 해석돼 엉뚱한 곳을
// 조회한다. 실패가 아니라 **잘못된 성공**이라 더 위험하다.
// ---------------------------------------------------------------------------

test('영문자가 섞인 KRX 신형 코드도 국내 주식으로 해석한다', () => {
  for (const code of ['1234A5', '0000Z9']) {
    const r = resolveSymbol(code);
    assert.equal(r.kind, 'krstock', `${code} 는 krstock 이어야 한다`);
    assert.equal(r.symbol, code);
    assert.equal(r.generic, true);
    assert.equal(ki.krCodeOf(code), code, `${code} 는 원장 조회 코드여야 한다`);
  }
});

test('숫자 6자리 코드는 종전과 똑같이 해석된다 (회귀 방지)', () => {
  const r = resolveSymbol('000250');
  assert.equal(r.kind, 'krstock');
  assert.equal(r.symbol, '000250');
  assert.equal(ki.krCodeOf('000250.KQ'), '000250');
});

test('KRX 코드가 아닌 6글자 티커는 종전대로 국내 주식이 아니다', () => {
  for (const s of ['BTCUSD', 'AAPL', 'ABCDEF']) {
    assert.notEqual(resolveSymbol(s).kind, 'krstock', `${s} 가 krstock 이면 안 된다`);
    assert.equal(ki.krCodeOf(s), null);
  }
});
