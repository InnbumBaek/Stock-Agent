import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// agents.js는 CommonJS(module.exports)이므로 ESM 테스트에서 createRequire로 로드한다.
const require = createRequire(import.meta.url);
const { AGENTS, extractJson, runAgent, buildPrompt } = require('../server/agents.js');

// ---------------------------------------------------------------------------
// AGENTS 메타
// ---------------------------------------------------------------------------
test('AGENTS: 17종 id·순서·필드 존재', () => {
  // 통합으로 네 역할이 늘었다 — QUANT 가 맨 앞이다 (방법론 제안).
  // 통합으로 세 역할이 늘었다 — FLOW(유동성·체결) · FILING(공시·자본구조) ·
  // RED(가정 반대심문). 셋 다 원장 실측이 있어야만 도는 역할이라 requiresKi 다.
  // 기존 13인의 id·상대순서는 그대로여야 한다.
  const ids = AGENTS.map((a) => a.id);
  assert.deepEqual(ids, [
    'quant',
    'taro',
    'diana',
    'flow',
    'filing',
    'nova',
    'vibe',
    'bull',
    'bear',
    'blitz',
    'guard',
    'risky',
    'neutral',
    'safe',
    'red',
    'ace',
    'pm',
  ]);
  // 기존 13인은 원장 없이도 도는 역할 그대로다
  const legacy = ids.filter((id) => !['quant', 'flow', 'filing', 'red'].includes(id));
  assert.deepEqual(legacy, [
    'taro', 'diana', 'nova', 'vibe', 'bull', 'bear', 'blitz', 'guard',
    'risky', 'neutral', 'safe', 'ace', 'pm',
  ]);
  for (const a of AGENTS) {
    assert.ok(typeof a.name === 'string' && a.name === a.name.toUpperCase(), `${a.id} name 대문자`);
    assert.ok(typeof a.nameKo === 'string' && a.nameKo.length > 0, `${a.id} nameKo`);
    assert.ok(typeof a.role === 'string' && a.role.length > 0, `${a.id} role`);
    assert.ok(typeof a.roomKo === 'string' && a.roomKo.length > 0, `${a.id} roomKo`);
  }
});

// ---------------------------------------------------------------------------
// extractJson 3케이스
// ---------------------------------------------------------------------------
test('extractJson: 정상 JSON', () => {
  const r = extractJson('{"bubble":"안녕하세요","report":"상세 리포트"}');
  assert.equal(r.bubble, '안녕하세요');
  assert.equal(r.report, '상세 리포트');
});

test('extractJson: 앞뒤 잡문 섞임', () => {
  const raw = '분석 결과입니다:\n```json\n{"action":"BUY","confidence":80,"bubble":"매수"}\n```\n이상입니다.';
  const r = extractJson(raw);
  assert.equal(r.action, 'BUY');
  assert.equal(r.confidence, 80);
  assert.equal(r.bubble, '매수');
});

test('extractJson: 불량 → null', () => {
  assert.equal(extractJson('그냥 평문이고 JSON은 없습니다'), null);
  assert.equal(extractJson('{망가진 json 없음'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

// ---------------------------------------------------------------------------
// mock runAgent — 9개 id 전부 bubble·report 반환
// ---------------------------------------------------------------------------
const mockContext = {
  market: {
    kind: 'crypto',
    symbol: 'BTCUSDT',
    display: 'BTC',
    candles: [],
    indicators: { price: 60000, summaryLines: ['가격 60000', 'RSI 55'] },
    fundamentals: { lines: ['시총 1위'] },
    news: { headlines: [{ title: 'BTC 관련 뉴스', age: '1시간 전' }] },
    sentiment: { lines: ['공포탐욕지수 70'] },
    priceLine: 'BTC $60,000 (+1.2%)',
  },
  analystReports: {
    taro: '기술적으로 지지 확인',
    diana: '펀더멘털 양호',
    nova: '뉴스 혼조',
    vibe: '심리 과열',
  },
  debateLog: [{ id: 'bull', bubble: '매수 유효', report: '상방 여력 큼' }],
};

test('mock runAgent: 전원 bubble·긴 report 존재', async () => {
  for (const a of AGENTS) {
    const res = await runAgent(a.id, mockContext, { mock: true });
    assert.ok(typeof res.bubble === 'string' && res.bubble.length > 0, `${a.id} bubble`);
    assert.ok(typeof res.report === 'string' && res.report.length > 0, `${a.id} report`);
    // 데모가 실제 연출의 기준이므로 브리핑 분량(200자 이상)을 강제한다
    assert.ok(res.report.length >= 200, `${a.id} report 분량(${res.report.length}자)`);
  }
});

test('mock runAgent: pm에 verdict·sizing 존재', async () => {
  const res = await runAgent('pm', { ...mockContext, traderPlan: { action: 'BUY', confidence: 60 } }, { mock: true });
  assert.ok(['APPROVE', 'AMEND', 'REJECT'].includes(res.verdict), 'verdict 값');
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(res.action), 'action 값');
  assert.equal(typeof res.confidence, 'number');
  assert.ok(typeof res.sizing === 'string' && res.sizing.length > 0, 'sizing');
  assert.ok(typeof res.rationale === 'string' && res.rationale.length > 0, 'rationale');
});

// ---------------------------------------------------------------------------
// buildPrompt — 신규 역할에 traderPlan·riskReports·memory가 실제로 주입되는지
// ---------------------------------------------------------------------------
test('buildPrompt: risky에 traderPlan과 앞선 리스크 의견이 주입된다', () => {
  const p = buildPrompt('risky', {
    ...mockContext,
    traderPlan: { action: 'BUY', confidence: 61, entry: '지지 확인 후', stop: '저점 이탈', target: '저항' },
    riskReports: { safe: '비중을 줄여야 한다' },
  });
  assert.ok(p.includes('1차 계획'), 'traderPlan 섹션');
  assert.ok(p.includes('확신도: 61%'), '계획 수치');
  assert.ok(p.includes('앞선 리스크 심사 의견'), '앞선 의견 섹션');
  assert.ok(p.includes('비중을 줄여야 한다'), 'safe 의견 본문');
  assert.ok(p.includes('청산'), '청산 경고 지시');
});

test('buildPrompt: pm에 riskReports 3인과 memory가 주입되고 PM 출력 규칙이 붙는다', () => {
  const p = buildPrompt('pm', {
    ...mockContext,
    traderPlan: { action: 'HOLD', confidence: 55 },
    riskReports: { risky: '더 실어라', safe: '줄여라', neutral: '조건부' },
    memory: ['2026-07-28 HOLD(62%) → 이후 3일간 -4.1%'],
  });
  assert.ok(p.includes('리스크 위원회 심사 의견'), '리스크 섹션');
  assert.ok(p.includes('더 실어라') && p.includes('줄여라') && p.includes('조건부'), '3인 의견 본문');
  assert.ok(p.includes('과거 판정 회고'), 'memory 섹션');
  assert.ok(p.includes('이후 3일간 -4.1%'), 'memory 본문');
  assert.ok(p.includes('APPROVE|AMEND|REJECT'), 'PM 출력 규칙');
  assert.ok(p.includes('sizing'), 'sizing 요구');
});

test('buildPrompt: memory가 없으면 회고 섹션을 넣지 않는다', () => {
  const p = buildPrompt('ace', mockContext);
  assert.ok(!p.includes('과거 판정 회고'), '회고 섹션 없음');
});

test('buildPrompt: 브리핑 분량 규칙이 모든 역할에 붙는다', () => {
  for (const id of ['taro', 'bull', 'risky', 'pm', 'ace']) {
    const p = buildPrompt(id, { ...mockContext, traderPlan: { action: 'BUY' } });
    assert.ok(p.includes('8~14문장'), `${id} 브리핑 분량 규칙`);
  }
});

test('mock runAgent: ace에 action·부가 필드·scalp 존재', async () => {
  const res = await runAgent('ace', mockContext, { mock: true });
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(res.action), 'action 값');
  assert.equal(typeof res.confidence, 'number');
  assert.ok(typeof res.entry === 'string' && res.entry.length > 0, 'entry');
  assert.ok(typeof res.stop === 'string' && res.stop.length > 0, 'stop');
  assert.ok(typeof res.target === 'string' && res.target.length > 0, 'target');
  assert.ok(typeof res.rationale === 'string' && res.rationale.length > 0, 'rationale');
  assert.ok(res.scalp && typeof res.scalp === 'object', 'scalp 객체');
  assert.ok(['LONG', 'SHORT', 'PASS'].includes(res.scalp.bias), 'scalp.bias 값');
});
