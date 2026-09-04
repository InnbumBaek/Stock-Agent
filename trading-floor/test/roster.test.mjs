import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { AGENTS, buildPrompt } = require('../server/agents.js');

// ---------------------------------------------------------------------------
// 에이전트를 늘릴 때의 규칙 — **새 역할에는 새 업무를 준다.**
//
// 같은 재료를 여러 명이 보면 (1) 의견이 서로 상관돼 앙상블의 이점이 사라지고,
// (2) 전담이 없어 아무도 깊이 보지 않는다. 아래 테스트가 그 분업을 강제한다.
// ---------------------------------------------------------------------------

const NEW_IDS = ['flow', 'filing', 'red'];

// 원장 실측을 흉내 낸 최소 페이로드 (ki.facts/1)
function kiFixture() {
  return {
    ok: true,
    schema: 'ki.facts/1',
    assumptions: ['처분 소요일수 — 거래량의 10%만 소화한다고 가정합니다.'],
    units: { days_3pct: '영업일' },
    markets: { KOSDAQ: { as_of: '2026-08-12', n_days: 243, regime: {} } },
    stocks: {
      '000250': {
        found: true,
        code: '000250',
        name: '검증사',
        market: 'KOSDAQ',
        as_of: '2026-08-12',
        stale_days: 1,
        close: 186200,
        measures: { days_3pct: 22.9, pbr: 3.1, beta: null, te: null },
        observations: {
          liq: ['시가총액 3% 처분 소요 — 22.9영업일'],
          px: ['20일 VWAP 190,000원'],
          cap: ['상장 2000-01-01'],
          fin: ['PER 363.08'],
          events: ['희석 공시: 전환사채 발행결정'],
        },
        volume_profile: [
          { price: 180000, share: 0.31 },
          { price: 190000, share: 0.22 },
          { price: 200000, share: 0.11 },
        ],
        execution: {
          ok: true,
          target_pct: 3,
          horizon: 20,
          starts: 17,
          ranked_by_shortfall: ['immediate', 'equal'],
          rules: {
            immediate: {
              label: '즉시 전량',
              shortfall_med: -420,
              shortfall_p25: -1217,
              shortfall_p75: 760,
              vs_vwap_med: -148,
              fill_med: 1,
              days_med: 11,
            },
            equal: {
              label: '균등 분할',
              shortfall_med: -527,
              shortfall_p25: -1593,
              shortfall_p75: 1039,
              vs_vwap_med: -205,
              fill_med: 0.99,
              days_med: 20,
            },
          },
        },
        capital: {
          year: '2025',
          bond_outstanding: 30000000000,
          cb_to_mktcap: 0.06,
          shares_total: 23000000,
          treasury: 100000,
          top_holder_pct: 41.2,
          holders: [{ name: '홍길동', relate: '본인', shares: 9000000, pct: 39.1 }],
          refix: {
            floor_assumed_pct: 0.7,
            floor_price: 130340,
            scenarios: [
              { price: 167580, conv_price: 167580, potential_shares: 179019, dilution_pct: 0.0078 },
            ],
          },
        },
      },
    },
    missing: [],
  };
}

function marketFixture() {
  return {
    kind: 'krstock',
    symbol: '000250',
    display: '000250',
    nameKo: '검증사',
    krCode: '000250',
    ki: kiFixture(),
    priceLine: '검증사 ₩186,200',
    fundamentals: { lines: ['x'] },
    news: { headlines: [] },
    sentiment: { lines: [] },
    indicators: {},
    candles: [],
  };
}

const CTX = () => ({
  market: marketFixture(),
  mode: 'algo',
  analystReports: {},
  debateLog: [],
  scalpReports: {},
  riskReports: {},
  traderPlan: {},
  memory: null,
});

// ------------------------------------------------------------------- 명단

test('신규 역할은 원장 실측이 있어야 하는 역할로 표시된다', () => {
  for (const id of NEW_IDS) {
    const meta = AGENTS.find((a) => a.id === id);
    assert.ok(meta, `${id} 가 명단에 있어야 한다`);
    assert.equal(meta.requiresKi, true, `${id} 는 requiresKi 여야 한다`);
  }
});

test('기존 13인은 원장 없이도 도는 역할 그대로다 (회귀 방지)', () => {
  const legacy = ['taro', 'diana', 'nova', 'vibe', 'bull', 'bear', 'blitz', 'guard',
    'risky', 'neutral', 'safe', 'ace', 'pm'];
  for (const id of legacy) {
    const meta = AGENTS.find((a) => a.id === id);
    assert.ok(meta, `${id} 가 사라지면 안 된다`);
    assert.ok(!meta.requiresKi, `${id} 는 원장 없이도 돌아야 한다`);
  }
  assert.equal(AGENTS.length, 16);
});

// --------------------------------------------------------- 분업 (핵심 계약)

test('실행 시뮬레이션은 FLOW 만 본다', () => {
  const ctx = CTX();
  const seen = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, ctx).includes('[실행 시뮬레이션 —')
  );
  assert.deepEqual(seen, ['flow'], `실행 시뮬레이션을 본 역할: ${seen.join(',')}`);
});

test('매물대는 FLOW 만 본다', () => {
  const ctx = CTX();
  const seen = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, ctx).includes('[매물대 —')
  );
  assert.deepEqual(seen, ['flow']);
});

test('자본구조는 FILING 만 본다', () => {
  const ctx = CTX();
  const seen = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, ctx).includes('[자본구조 — DART')
  );
  assert.deepEqual(seen, ['filing']);
});

test('가정과 측정 한계는 RED 만 본다', () => {
  const ctx = CTX();
  const assume = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, ctx).includes('[위 숫자가 서 있는 가정]')
  );
  const limits = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, ctx).includes('[이 원장이 재지 못한 것]')
  );
  assert.deepEqual(assume, ['red']);
  assert.deepEqual(limits, ['red']);
});

test('FLOW 는 매물대 전 구간을, 남들은 안 본다 (detail: full)', () => {
  const ctx = CTX();
  const p = buildPrompt('flow', ctx);
  assert.ok(!p.includes('상위 3개 구간'), 'FLOW 는 요약본이 아니라 전 구간을 본다');
  assert.ok(p.includes('180,000원 부근'));
});

// ------------------------------------------------------------- 업무의 구분

test('FLOW 는 방향 판정을 하지 말라고 지시받는다', () => {
  const p = buildPrompt('flow', CTX());
  assert.ok(p.includes('실행 가능성'));
  assert.ok(p.includes('방향(매수·매도) 판정은 네 일이 아니다'));
});

test('FILING 은 모르는 것을 모른다고 적으라고 지시받는다', () => {
  const p = buildPrompt('filing', CTX());
  assert.ok(p.includes('주식수와 물량'));
  assert.ok(p.includes('없는 것과 안 본 것은 다르다'));
});

test('RED 는 판정이 아니라 판정의 토대를 심문하라고 지시받는다', () => {
  const p = buildPrompt('red', CTX());
  assert.ok(p.includes('가정 반대심문관'));
  assert.ok(p.includes('매수·매도 방향을 제시하지 마라'));
  // 억지로 흠을 만드는 것도 막는다
  assert.ok(p.includes('억지로 흠을 만들지 마라'));
});

test('세 역할의 지시문이 서로 다르다 (같은 일을 시키지 않는다)', () => {
  const ctx = CTX();
  const prompts = NEW_IDS.map((id) => buildPrompt(id, ctx));
  for (let i = 0; i < prompts.length; i += 1) {
    for (let j = i + 1; j < prompts.length; j += 1) {
      assert.notEqual(prompts[i], prompts[j]);
    }
  }
});

// ----------------------------------------------------------- 원장이 없을 때

// 블록이 '붙었는지'는 그 줄이 헤더로 시작하는지로 본다.
// (지시문 안에서 블록 이름을 언급하는 것과 블록 자체가 붙는 것은 다르다)
function hasBlock(prompt, header) {
  return prompt.split('\n').some((l) => l.startsWith(header));
}

test('원장 실측이 없으면 신규 역할의 프롬프트에 실측 블록이 붙지 않는다', () => {
  const ctx = {
    ...CTX(),
    market: {
      kind: 'crypto', symbol: 'BTC', display: 'BTC', indicators: {},
      fundamentals: { lines: [] }, news: { headlines: [] }, sentiment: { lines: [] },
    },
  };
  for (const id of NEW_IDS) {
    const p = buildPrompt(id, ctx);
    for (const h of ['[매물대', '[자본구조', '[이 원장이 재지 못한 것]',
      '[실행 시뮬레이션', '[위 숫자가 서 있는 가정]']) {
      assert.ok(!hasBlock(p, h), `${id} 에 ${h} 블록이 붙으면 안 된다`);
    }
  }
});

test('실측이 있을 때만 블록이 붙는다 (헤더 기준 재확인)', () => {
  const ctx = CTX();
  assert.ok(hasBlock(buildPrompt('flow', ctx), '[실행 시뮬레이션'));
  assert.ok(hasBlock(buildPrompt('filing', ctx), '[자본구조'));
  assert.ok(hasBlock(buildPrompt('red', ctx), '[이 원장이 재지 못한 것]'));
});
