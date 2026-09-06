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
  assert.equal(AGENTS.length, 17);
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

// ---------------------------------------------------------------------------
// 실시간 호가 — 분업의 연장
//
// 실시간 '현재가'는 시세 줄로 전원이 본다(그게 신선도의 문제라서). 하지만
// 호가·잔량·스프레드는 '지금 이 가격에 실제로 얼마나 나가는가'를 보는 값이라
// 유동성·체결을 맡은 FLOW 의 재료다. 여러 명이 같은 것을 보면 의견이 상관된다.
// ---------------------------------------------------------------------------

function quoteFixture(over = {}) {
  return {
    ok: true,
    schema: 'ki.quote/1',
    code: '000250',
    market_open: true,
    quote: {
      price: 186200, open: 185000, high: 190000, low: 180000, prev_close: 185000,
      bid: 186100, ask: 186300, bid_qty: 1200, ask_qty: 800,
      change_pct: 0.65, spread_bp: 10.74, queue_imbalance: 0.2,
      ts: '2026-09-04T13:20:00',
    },
    ...over,
  };
}

test('실시간 호가는 FLOW 만 본다', () => {
  const ctx = CTX();
  ctx.market.kiQuote = quoteFixture();
  const seen = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, ctx).includes('[실시간 호가 —')
  );
  assert.deepEqual(seen, ['flow'], `호가를 본 역할: ${seen.join(',')}`);
});

test('실시간이 없으면 아무에게도 호가 블록이 붙지 않는다', () => {
  const ctx = CTX(); // kiQuote 없음
  for (const a of AGENTS) {
    assert.ok(
      !hasBlock(buildPrompt(a.id, ctx), '[실시간 호가'),
      `${a.id} 에 호가 블록이 붙으면 안 된다`
    );
  }
});

test('FLOW 는 호가와 실행 시뮬레이션을 함께 본다', () => {
  const ctx = CTX();
  ctx.market.kiQuote = quoteFixture();
  const p = buildPrompt('flow', ctx);
  assert.ok(hasBlock(p, '[실시간 호가'));
  assert.ok(hasBlock(p, '[실행 시뮬레이션'));
  assert.ok(p.includes('1호가만 본 값'), '한계도 함께 가야 한다');
});

// ---------------------------------------------------------------------------
// 출처 규율 — 무엇을 근거로 삼을 수 있는가
//
// 공공기관 API 로 잰 값과 언론사 제목이 같은 무게로 프롬프트에 들어가면,
// 리포트에서 "뉴스에서 봤다"가 "실측했다"처럼 읽힌다. 회의에서 그 구분이
// 사라지는 것이 이 시스템의 가장 조용한 실패다.
// ---------------------------------------------------------------------------

function newsCtx() {
  const ctx = CTX();
  ctx.market.news = { headlines: [{ title: '검증용 기사 제목', age: '1시간 전' }] };
  ctx.market.sentiment = { lines: ['공포탐욕지수 45'] };
  return ctx;
}

test('17명 전원이 출처 규율을 받는다 (ACE 포함)', () => {
  const ctx = newsCtx();
  const missing = AGENTS.map((a) => a.id).filter(
    (id) => !buildPrompt(id, ctx).includes('[출처 규율')
  );
  assert.deepEqual(missing, [], `규율이 빠진 역할: ${missing.join(', ')}`);
});

test('출처 규율이 1차와 참고를 나눈다', () => {
  const p = buildPrompt('ace', newsCtx());
  assert.ok(p.includes('1차 (근거로 삼아도 된다)'));
  assert.ok(p.includes('참고 (근거로 삼지 마라)'));
  // 1차에는 공공기관·중앙은행만 온다
  for (const s of ['KRX 한국거래소', 'DART 금융감독원', '한국은행 ECOS', '한국투자증권 KIS']) {
    assert.ok(p.includes(s), `1차 출처에 ${s} 가 없다`);
  }
});

test('기억에서 숫자를 꺼내 쓰지 말라고 지시한다', () => {
  // 언어모델이 학습 시점의 값을 꺼내 쓰면 아무도 추적할 수 없다.
  const p = buildPrompt('diana', newsCtx());
  assert.ok(p.includes('네 기억에서 꺼내 쓰지 마라'));
  assert.ok(p.includes('재료에 없다'));
});

test('언론 헤드라인은 참고 등급으로 강등돼 있다', () => {
  const nova = buildPrompt('nova', newsCtx());
  assert.ok(nova.includes('참고 등급'), 'NOVA 의 뉴스 블록에 등급 라벨이 없다');
  assert.ok(nova.includes('제목만 받은 것'), '무엇을 못 봤는지 밝혀야 한다');
  assert.ok(nova.includes('사실로 단정하지 마라'));
  // 공시와 어긋나면 공시를 믿으라는 우선순위가 있어야 한다
  assert.ok(nova.includes('DART 공시가 1차 출처'));

  const vibe = buildPrompt('vibe', newsCtx());
  assert.ok(vibe.includes('참고 등급'));
  assert.ok(vibe.includes('사실이 아니고'), '심리 지표의 성격을 밝혀야 한다');
});

test('뉴스를 지우지는 않는다 — 여론의 온도는 그 자체로 정보다', () => {
  const nova = buildPrompt('nova', newsCtx());
  assert.ok(nova.includes('검증용 기사 제목'), '헤드라인 자체는 그대로 실려야 한다');
});

test('헤드라인만 근거인 주장에는 미확인을 붙이라고 한다', () => {
  const p = buildPrompt('bull', newsCtx());
  assert.ok(p.includes('미확인'));
});

// ---------------------------------------------------------------------------
// 거시 지표 — 한국은행 ECOS
//
// 매크로는 모두에게 그럴듯하게 읽히는 재료다. 전원에게 주면 17명이 같은 거시
// 서사를 반복하고 앙상블이 무너진다. DIANA(할인율)와 RED(가정 심문)만 본다.
// ---------------------------------------------------------------------------

function macroFixture() {
  return {
    ok: true,
    schema: 'ki.macro/1',
    source: '한국은행 경제통계시스템(ECOS) — 100대 통계지표',
    n: 3,
    stats: [
      { group: '물가', name: '소비자물가지수', value: 116.2, unit: '2020=100', as_of: '202608' },
      { group: '통화/금리', name: '한국은행 기준금리', value: 2.5, unit: '연%', as_of: '202608' },
      { group: '국제수지/환율', name: '원/달러 환율', value: 1382.5, unit: '원', as_of: '20260904' },
    ],
  };
}

test('거시 지표는 DIANA 와 RED 만 본다', () => {
  const ctx = CTX();
  ctx.market.kiMacro = macroFixture();
  const seen = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, ctx).includes('[거시 지표 —')
  );
  assert.deepEqual(seen.sort(), ['diana', 'red'], `거시를 본 역할: ${seen.join(',')}`);
});

test('거시가 없으면 아무에게도 블록이 붙지 않는다', () => {
  const ctx = CTX(); // kiMacro 없음
  for (const a of AGENTS) {
    assert.ok(!hasBlock(buildPrompt(a.id, ctx), '[거시 지표'), `${a.id} 에 붙으면 안 된다`);
  }
});

test('금리가 물가보다 먼저 온다 — 회수 판단에 더 직접적이다', () => {
  const ctx = CTX();
  ctx.market.kiMacro = macroFixture();
  const p = buildPrompt('diana', ctx);
  const rate = p.indexOf('한국은행 기준금리');
  const cpi = p.indexOf('소비자물가지수');
  assert.ok(rate > 0 && cpi > 0);
  assert.ok(rate < cpi, '금리가 물가보다 뒤에 왔다');
});

test('한국은행이 준 통계명·단위·시점을 그대로 싣는다', () => {
  const ctx = CTX();
  ctx.market.kiMacro = macroFixture();
  const p = buildPrompt('red', ctx);
  assert.ok(p.includes('한국은행 기준금리 2.5 연% (기준 202608)'), p.slice(p.indexOf('[거시'), p.indexOf('[거시') + 300));
  assert.ok(p.includes('네 기억이 아니라 실측이다'));
});

test('값이 없는 통계는 싣지 않는다 (0 으로 둔갑시키지 않는다)', () => {
  const ctx = CTX();
  const m = macroFixture();
  m.stats.push({ group: '통화/금리', name: '값 없는 통계', value: null, unit: '%', as_of: '202608' });
  ctx.market.kiMacro = m;
  const p = buildPrompt('diana', ctx);
  assert.ok(!p.includes('값 없는 통계'), '결측 통계가 프롬프트에 실렸다');
});

// ---------------------------------------------------------------------------
// 리스크 위원회 — 성향 심사는 서로를 기다리지 않는다
//
// 셋을 줄 세우면 뒤 사람이 앞 사람 리포트를 읽고 시작해 의견이 상관된다.
// 그건 FLOW·FILING·RED 를 나눌 때 쓴 것과 같은 논리다. 독립된 세 의견을
// NEUTRAL 이 중재하는 쪽이 빠르면서 판정으로도 낫다.
// ---------------------------------------------------------------------------

const { RISK_ORDER, RISK_ARBITER_IDS } = require('../server/engine.js');

test('중재자는 NEUTRAL 하나뿐이다', () => {
  assert.deepEqual([...RISK_ARBITER_IDS], ['neutral']);
});

test('NEUTRAL 만 앞선 심사를 인용하라고 지시받는다', () => {
  // 이 지시문이 있는 역할만 뒤에 와야 한다. 근거와 구현이 어긋나면
  // 병렬화가 판정을 조용히 바꾼다.
  const ctx = CTX();
  const cites = ['risky', 'safe', 'red', 'neutral'].filter((id) =>
    buildPrompt(id, ctx).includes('앞선 심사자들의 주장을 각각 인용')
  );
  assert.deepEqual(cites, ['neutral']);
  for (const id of cites) assert.ok(RISK_ARBITER_IDS.has(id), `${id} 는 중재자여야 한다`);
});

test('명단 순서는 그대로다 — 회의 자료의 위원 순서가 바뀌면 비교가 안 된다', () => {
  assert.deepEqual(RISK_ORDER, ['risky', 'safe', 'red', 'neutral']);
  const independents = RISK_ORDER.filter((id) => !RISK_ARBITER_IDS.has(id));
  const arbiters = RISK_ORDER.filter((id) => RISK_ARBITER_IDS.has(id));
  assert.deepEqual(independents, ['risky', 'safe', 'red'], '동시에 돌 셋');
  assert.deepEqual(arbiters, ['neutral'], '뒤에 올 중재자');
});

// ---------------------------------------------------------------------------
// 모델 계층 — 정리하는 일과 판정하는 일은 요구가 다르다
// ---------------------------------------------------------------------------

const { modelFor } = require('../server/agents.js');

test('판정·토론은 깊은 모델, 재료 정리는 빠른 모델', () => {
  for (const id of ['ace', 'pm', 'red', 'bull', 'bear']) {
    assert.equal(modelFor(id), 'opus', `${id} 는 판정에 직결된다`);
  }
  for (const id of ['taro', 'diana', 'flow', 'filing', 'nova', 'vibe',
    'risky', 'safe', 'neutral', 'blitz', 'guard']) {
    assert.equal(modelFor(id), 'sonnet', `${id} 는 재료 정리다`);
  }
});

test('17명 전원이 모델을 배정받는다 — 빠뜨리면 조용히 기본값이 된다', () => {
  for (const a of AGENTS) {
    assert.ok(['opus', 'sonnet'].includes(modelFor(a.id)), `${a.id}: ${modelFor(a.id)}`);
  }
});

// ---------------------------------------------------------------------------
// 퀀트 데스크 — 논문을 읽고 **제안**한다. 판정하지 않는다.
//
// 이 자리의 실패 방식은 하나다. 논문이 말한 적 없는 것을 말했다고 읽고,
// 그것을 숫자의 권위로 데스크에 넘기는 것. 아래가 그 경로를 막는다.
// ---------------------------------------------------------------------------

const { formatKiFactorLines } = require('../server/ki-bridge.js');

function factorFixture() {
  return {
    ok: true,
    schema: 'ki.factors/1',
    factors: [
      {
        key: 'amihud', name: 'Amihud 비유동성', unit: '×1e6', value: 0.1234, n: 60,
        paper: 'amihud2002',
        citation: 'Amihud, Y. (2002) Illiquidity and stock returns. Journal of Financial Markets 5(1), 31-56.',
        claim: '비유동적일수록 요구수익률이 높다',
        limits: '일별 집계라 장중 충격은 못 본다', reason: null,
      },
      {
        key: 'ivol', name: '고유변동성 (연율)', unit: '%', value: null, n: 0,
        paper: 'ahxz2006', citation: 'Ang, A. et al. (2006) ...',
        claim: '고유변동성이 높으면 이후 수익률이 낮았다',
        limits: '시장모형 잔차다', reason: '원장에 시장지수가 없습니다',
      },
    ],
    impact_model: {
      assumption: '가격 충격은 주문량의 제곱근에 비례',
      paper: 'athl2005', citation: 'Almgren, R. et al. (2005) ...',
      limits: '미국 대형주 자료다',
    },
  };
}

test('팩터 줄은 값·근거·주장·유보를 한 덩어리로 낸다', () => {
  const lines = formatKiFactorLines(factorFixture()).join('\n');
  // 값 옆에 출처와 유보가 같이 있어야 셋이 떨어지지 않는다.
  assert.match(lines, /Amihud 비유동성: 0\.1234/);
  assert.match(lines, /근거\s+Amihud, Y\. \(2002\)/);
  assert.match(lines, /주장\s+비유동적일수록/);
  assert.match(lines, /유보\s+일별 집계라/);
  // §3 이 쓰는 가정도 출처와 함께 나간다.
  assert.match(lines, /제곱근에 비례/);
  assert.match(lines, /Almgren, R\. et al\. \(2005\)/);
});

test('못 낸 팩터는 숨기지 않고 사유를 적는다', () => {
  const lines = formatKiFactorLines(factorFixture()).join('\n');
  // 빠진 줄은 아무도 묻지 않는다. 없으면 왜 없는지가 보여야 한다.
  assert.match(lines, /고유변동성 \(연율\): 계산 불가 — 원장에 시장지수가 없습니다/);
  assert.doesNotMatch(lines, /고유변동성 \(연율\): 0/);
});

test('팩터는 QUANT 에게만 간다', () => {
  const market = { symbol: 'TEST', display: '테스트', kiFactors: factorFixture() };
  const seen = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, { market }).includes('Amihud 비유동성')
  );
  assert.deepEqual(seen, ['quant'], `팩터를 본 역할: ${seen.join(',')}`);
});

test('QUANT 는 판정하지 말라는 지시를 받는다', () => {
  const market = { symbol: 'TEST', display: '테스트', kiFactors: factorFixture() };
  const p = buildPrompt('quant', { market });
  assert.match(p, /판정을 내리는 자리가 아니다/);
  assert.match(p, /매수·매도·목표가를 말하지 마라/);
  // 팩터를 스스로 다시 계산하거나, 기억에서 논문을 꺼내 오면 추적이 끊긴다.
  assert.match(p, /팩터를 네가 다시 계산하지 마라/);
  assert.match(p, /논문을 네 기억에서 새로 꺼내 인용하지 마라/);
});

test('퀀트 제안은 판단을 바꾸는 다섯 자리에만 간다', () => {
  const ctx = { market: { symbol: 'TEST', display: '테스트' }, quantReport: '제안 본문' };
  const got = AGENTS.map((a) => a.id).filter((id) =>
    buildPrompt(id, ctx).includes('퀀트 데스크 제안')
  );
  assert.deepEqual(got, ['diana', 'flow', 'red', 'ace', 'pm']);
});

test('퀀트 제안은 제안이지 판정이 아니라고 명시된다', () => {
  const ctx = { market: { symbol: 'TEST', display: '테스트' }, quantReport: '제안 본문' };
  for (const id of ['ace', 'pm', 'flow']) {
    const p = buildPrompt(id, ctx);
    assert.match(p, /판정 아님/, `${id}`);
    assert.match(p, /동의하지 않으면 그렇게 적어라/, `${id}`);
  }
});

test('제안이 없으면 어디에도 붙지 않는다', () => {
  const ctx = { market: { symbol: 'TEST', display: '테스트' } };
  for (const a of AGENTS) {
    assert.ok(!buildPrompt(a.id, ctx).includes('퀀트 데스크 제안'), a.id);
  }
});

// ---------------------------------------------------------------------------
// 문헌 심사 — 연도별로 훑어 온 후보를 읽고 **제안**한다.
//
// 여기서 막아야 하는 것은 하나다. 심사 결과가 저장소를 스스로 고치는 것.
// 검산되지 않은 계산이 회의 자료에 조용히 실리는 것이 이 프로젝트가 막으려는
// 실패이고, 그 경로가 여기서 열린다.
// ---------------------------------------------------------------------------

const scan = require('../server/paper-scan.js');
const { buildPaperScanPrompt, LEDGER_COLUMNS } = require('../server/agents.js');

function scanFixture() {
  return {
    year: 2025,
    papers: [{
      doi: '10.1111/jofi.99001', title: 'Liquidity and the Exit Decision',
      journal: 'The Journal of Finance', year: 2025, authors: 'Kim, M.',
      pages: '1-30', question: 'q2', matched: 'stock illiquidity measure',
      adopted: false,
    }],
    adopted: [{ authors: 'Amihud, Y.', year: 2002, title: 'Illiquidity...', question: 'q2' }],
  };
}

test('연도 구간을 읽는다', () => {
  assert.deepEqual(scan.yearRange('2024-2026'), [2024, 2025, 2026]);
  assert.equal(scan.yearRange('2026-2024'), null);   // 거꾸로면 거부
  assert.equal(scan.yearRange('24-26'), null);
  assert.equal(scan.yearRange(''), null);
});

test('--run 없이는 심사하지 않는다', () => {
  // 연도 하나가 곧 claude 호출 하나다. 실수로 도는 경로를 두지 않는다.
  assert.equal(scan.parseArgs(['--years', '2024-2026']).run, false);
  assert.equal(scan.parseArgs(['--years', '2024-2026', '--run']).run, true);
});

test('심사 프롬프트는 네 질문과 원장 열을 함께 준다', () => {
  const p = buildPaperScanPrompt(scanFixture());
  for (const q of ['q1 얼마나 왔는가', 'q2 팔 수 있는가', 'q3 어떻게 팔 것인가',
                   'q4 지금이 그 때인가']) {
    assert.ok(p.includes(q), q);
  }
  // 원장에 없는 데이터를 요구하는 제안은 구현할 수 없다. 그 목록을 같이 준다.
  assert.ok(p.includes('shares(상장주식수)'));
  assert.ok(LEDGER_COLUMNS.includes('index_daily'));
  // 이미 채택된 것을 다시 제안하면 심사가 아니다.
  assert.match(p, /이미 채택된 것 — 중복 제안 금지/);
  assert.match(p, /Amihud, Y\. \(2002\)/);
});

test('심사 프롬프트는 지어내기를 막는다', () => {
  const p = buildPaperScanPrompt(scanFixture());
  assert.match(p, /제목만 보고 주장을 지어내지 마라/);
  assert.match(p, /네 기억에서 이 논문의 결과를 꺼내지 마라/);
  // 전부 채택하면 심사한 것이 아니다.
  assert.match(p, /채택제안은 \*\*많아야 두 편\*\*이다/);
  // 이 데스크의 성격을 못 박는다 — 진입 신호를 찾는 곳이 아니다.
  assert.match(p, /진입 신호를 찾는 곳이 아니다/);
});

test('심사는 시장 데이터를 요구하지 않는다', () => {
  // 재료가 논문이라 경로가 통째로 다르다. 시세가 없어도 돌아야 한다.
  const p = buildPrompt('quant', { paperScan: scanFixture() });
  assert.ok(p.includes('문헌 심사 담당'));
  assert.ok(!p.includes('가격 정보 없음'));
});

// ---------------------------------------------------------------------------
// 구현까지 — 에이전트가 쓴 코드를 꺼내 관문 앞에 놓는다.
//
// 여기서 통과 여부를 판단하면 관문을 우회하는 셈이다. 이쪽이 하는 일은
// "형식이 맞는 블록만 꺼내 파일로 놓기"까지다. 실을지 말지는 파이썬의
// 정적·연기·검산·인용 네 관문이 정한다.
// ---------------------------------------------------------------------------

test('factor 블록을 꺼낸다', () => {
  const r = [
    '앞말',
    '```factor:my_key',
    '# META: {"name":"x"}',
    'def compute(df, mkt, list_date, win):',
    '    return 1.0, 1, None',
    '```',
    '뒷말',
  ].join('\n');
  const got = scan.extractFactors(r);
  assert.equal(got.length, 1);
  assert.equal(got[0].key, 'my_key');
  assert.match(got[0].src, /def compute\(df, mkt, list_date, win\):/);
});

test('META 나 compute 가 없으면 꺼내지 않는다', () => {
  // 관문에서 어차피 막히지만, 쓰레기 파일을 만들 이유가 없다.
  const noMeta = '```factor:a\ndef compute(df, mkt, list_date, win):\n    pass\n```';
  const noFn = '```factor:b\n# META: {"name":"x"}\nprint(1)\n```';
  assert.equal(scan.extractFactors(noMeta).length, 0);
  assert.equal(scan.extractFactors(noFn).length, 0);
});

test('키가 파일 이름이 되므로 좁게 받는다', () => {
  // 경로 탈출·대문자·점이 파일 이름에 들어가면 그 자체가 구멍이다.
  for (const bad of ['../evil', 'UPPER', 'a b', '.hidden', 'x/y', '1start']) {
    const r = '```factor:' + bad + '\n# META: {"name":"x"}\n'
      + 'def compute(df, mkt, list_date, win):\n    pass\n```';
    assert.equal(scan.extractFactors(r).length, 0, bad);
  }
});

test('심사 프롬프트는 구현 규칙과 검산을 요구한다', () => {
  const p = buildPaperScanPrompt(scanFixture());
  assert.match(p, /```factor:<영문소문자_키>/);
  assert.match(p, /관문을 통과해야만 실린다/);
  assert.match(p, /import 금지/);
  // 검산이 핵심이다 — 기댓값을 못 적으면 채택제안하지 말라고 시킨다.
  assert.match(p, /check\.expect 가 가장 중요하다/);
  assert.match(p, /검산되지 않은 계산은 싣지 않는다/);
});

test('목업도 관문을 통과할 형식의 코드를 낸다', async () => {
  // 배선만 확인하고 형식은 안 보는 목업은 시험이 아니다.
  const { runAgent } = require('../server/agents.js');
  const res = await runAgent('quant',
    { paperScan: { year: 2025, papers: [{ title: 'T', authors: 'A', year: 2025,
      journal: 'J', question: 'q1', matched: 'm' }], adopted: [] } },
    { mock: true });
  const got = scan.extractFactors(res.report);
  assert.equal(got.length, 1);
  assert.match(got[0].src, /"check":\{"rate":0\.002/);
  assert.match(got[0].src, /"paper":"jt1993"/);
});

test('자동 실행은 비용을 묶는다 — 새 후보가 있는 해만, 한 번에 몇 개만', () => {
  // 평일마다 열 몇 해를 다시 심사하면 결과는 같은데 비용만 늘어난다.
  const a = scan.parseArgs(['--years', '2013-2026', '--run', '--new-only',
                            '--max-years', '1']);
  assert.equal(a.newOnly, true);
  assert.equal(a.maxYears, 1);
  // 기본값은 껐다 — 손으로 돌릴 때는 시킨 것을 전부 해야 한다.
  const b = scan.parseArgs(['--years', '2013-2026']);
  assert.equal(b.newOnly, false);
  assert.equal(b.maxYears, 0);
});

test('후보에 초록·등급·출처가 함께 간다', () => {
  const p = buildPaperScanPrompt({
    year: 2025, adopted: [],
    papers: [{
      authors: 'Kim, M.', year: 2025, title: 'Optimal Liquidation',
      journal: 'arXiv q-fin.TR (거래·시장미시구조)', arxiv_id: '2501.00001v1',
      source: 'arXiv', venue_grade: '프리프린트 (동료심사 전)',
      matched: 'q-fin.TR', abstract: 'We study optimal liquidation.', cited_by: null,
    }],
  });
  assert.match(p, /arXiv:2501\.00001v1/);
  assert.match(p, /등급: 프리프린트 \(동료심사 전\)/);
  assert.match(p, /출처: arXiv/);
  assert.match(p, /초록: We study optimal liquidation\./);
});

test('초록이 없으면 없다고 적는다', () => {
  // 빠진 줄은 아무도 묻지 않는다. 없으면 없다는 것이 보여야 한다.
  const p = buildPaperScanPrompt({
    year: 2025, adopted: [],
    papers: [{ authors: 'A', year: 2025, title: 'T', journal: 'The Journal of Finance',
      doi: '10.1/x', source: 'OpenAlex', venue_grade: '저널 게재 (동료심사)',
      matched: 'm', abstract: '', cited_by: 42 }],
  });
  assert.match(p, /초록: 없음 — 제목과 게재지만 보고 판단해야 한다/);
  assert.match(p, /피인용 42/);
});

test('프리프린트를 저널과 같은 무게로 읽지 말라고 시킨다', () => {
  const p = buildPaperScanPrompt(scanFixture());
  assert.match(p, /등급을 무시하지 마라/);
  assert.match(p, /프리프린트는 동료심사를 거치지 않았다/);
  assert.match(p, /피인용 수는 참고일 뿐이다/);
});
