'use strict';

// PIXEL TRADING FLOOR — 에이전트 모듈
// 역할별 프롬프트 빌더 + `claude -p --model opus` 스폰 + 데모(mock) 응답.
// 외부 npm 의존성 없음(Node 24 내장만). CommonJS.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// 주가 모니터링 원장(KRX·DART 공식 API) 브리지 — 설정에서 켜야만 동작한다.
const kiBridge = require('./ki-bridge.js');

// ---------------------------------------------------------------------------
// 에이전트 메타 (순서 고정: 애널리스트 4 → 리서치 2 → 스캘핑 2 → 수석 1)
// name: 영문 대문자 / nameKo: 한국어 표기 / role: 한국어 역할 배지 / roomKo: 방 이름
// ---------------------------------------------------------------------------
const AGENTS = [
  { id: 'taro', name: 'TARO', nameKo: '타로', role: '기술적 분석', roomKo: '애널리스트 룸' },
  { id: 'diana', name: 'DIANA', nameKo: '다이애나', role: '기본적 분석', roomKo: '애널리스트 룸' },
  // requiresKi — 원장 실측이 없으면 볼 것이 없는 역할이다. 엔진이 알아서 건너뛴다.
  // (코인·해외주식 런에서는 명단에 오르지 않으므로 비용이 늘지 않는다)
  { id: 'flow', name: 'FLOW', nameKo: '플로우', role: '유동성·체결', roomKo: '애널리스트 룸', requiresKi: true },
  { id: 'filing', name: 'FILING', nameKo: '파일링', role: '공시·자본구조', roomKo: '애널리스트 룸', requiresKi: true },
  { id: 'nova', name: 'NOVA', nameKo: '노바', role: '뉴스 분석', roomKo: '애널리스트 룸' },
  { id: 'vibe', name: 'VIBE', nameKo: '바이브', role: '센티먼트', roomKo: '애널리스트 룸' },
  { id: 'bull', name: 'BULL', nameKo: '불', role: '매수 논거', roomKo: '리서치 룸' },
  { id: 'bear', name: 'BEAR', nameKo: '베어', role: '매도 논거', roomKo: '리서치 룸' },
  { id: 'blitz', name: 'BLITZ', nameKo: '블리츠', role: '스캘퍼', roomKo: '스캘핑 데스크' },
  { id: 'guard', name: 'GUARD', nameKo: '가드', role: '리스크 관리', roomKo: '스캘핑 데스크' },
  // 논문(TradingAgents)의 Risk Management team — 성향이 다른 3인이 트레이더 계획을 놓고 논쟁한다
  { id: 'risky', name: 'RISKY', nameKo: '리스키', role: '공격적 리스크', roomKo: '리스크 위원회' },
  { id: 'neutral', name: 'NEUTRAL', nameKo: '뉴트럴', role: '중립적 리스크', roomKo: '리스크 위원회' },
  { id: 'safe', name: 'SAFE', nameKo: '세이프', role: '보수적 리스크', roomKo: '리스크 위원회' },
  // 판정이 아니라 판정의 토대를 심문한다 — 원장의 가정이 이 종목에 맞는가
  { id: 'red', name: 'RED', nameKo: '레드', role: '가정 반대심문', roomKo: '리스크 위원회', requiresKi: true },
  { id: 'ace', name: 'ACE', nameKo: '에이스', role: '수석 트레이더', roomKo: '트레이딩 룸' },
  // 논문의 Portfolio Manager — 트레이더 계획을 승인/수정/기각하는 최종 관문
  { id: 'pm', name: 'PM', nameKo: '피엠', role: '포트폴리오 매니저', roomKo: '트레이딩 룸' },
];

const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

const SPAWN_TIMEOUT_MS = 180000; // 180초

// ---------------------------------------------------------------------------
// extractJson: 첫 '{' 부터 마지막 '}' 까지 잘라 JSON.parse. 실패 시 null.
// ---------------------------------------------------------------------------
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 프롬프트 빌더 헬퍼
// ---------------------------------------------------------------------------
// 주가 모니터링 원장의 실측값을 이 에이전트가 받아야 하는가.
//
// market.ki 는 ki.enabled 이고 한국 주식일 때만 존재한다. 어느 에이전트에게
// 줄지는 config 의 ki.injectInto 가 정한다(기본: diana·guard·safe).
// 실측을 판단으로 바꾸지 않는다 — 측정값과 그 가정을 그대로 옮길 뿐이다.
// 실측을 얼마나 자세히 줄 것인가. FLOW 는 유동성·체결 전담이라 전 구간을 본다.
const KI_DETAIL = { flow: 'full' };

// 누가 원장의 어느 부분을 보는가 — **겹치지 않게** 나눈다.
//
// 같은 재료를 여러 명이 보면 (1) 의견이 서로 상관돼 앙상블의 이점이 사라지고,
// (2) 전담이 없어 아무도 깊이 보지 않는다. 그래서 새 역할에는 새 재료를 준다.
//
//   FLOW   ← 실행 시뮬레이션·매물대. **이 둘은 지금까지 아무도 못 보던 값이다.**
//   FILING ← 자본구조(미상환 사채·최대주주 지분)·공시. 역시 새로 내보낸 값이다.
//   RED    ← 가정과 '재지 못한 것'. 값이 아니라 값의 한계를 심문한다.
//   기존 4인은 원래 보던 것에서 위 셋을 뺀 만큼만 본다.
const KI_SECTIONS = {
  flow: ['liq', 'px', 'extras', 'profile', 'exec'],
  filing: ['cap', 'fin', 'events', 'capital'],
  red: ['assumptions', 'limits', 'regime'],
  diana: ['fin', 'px', 'extras', 'regime'],
  guard: ['liq', 'px'],
  safe: ['liq', 'px', 'cap'],
  ace: ['liq', 'px', 'fin', 'events'],
};

// 실시간 호가는 FLOW 만 본다.
//
// 실시간 '현재가'는 시세 줄로 전원이 보지만, 호가·잔량·스프레드는 방향이 아니라
// '지금 이 가격에 실제로 얼마나 나가는가'를 보는 값이다. 유동성·체결을 맡은
// 역할의 재료이고, 여러 명이 같은 것을 보면 의견이 상관되고 전담이 사라진다.
const KI_MICRO_IDS = new Set(['flow']);

// 거시 지표는 DIANA·RED 만 본다.
//
// DIANA 는 밸류에이션을 맡는다 — 금리는 할인율이라 그 계산에 직접 들어간다.
// RED 는 가정을 심문한다 — "이 판정이 어떤 금리 국면을 전제하고 있는가"가
// 정확히 그 역할이다. 둘은 같은 숫자를 다른 일에 쓴다.
//
// 나머지에게 주지 않는 이유는 분업이다. 매크로는 모두에게 그럴듯하게 읽히는
// 재료라, 전원에게 주면 16명이 같은 거시 서사를 반복하고 앙상블이 무너진다.
// ACE 는 DIANA 의 리포트로 그 판단을 받는다.
const KI_MACRO_IDS = new Set(['diana', 'red']);

function kiMacroLines(market, agentId) {
  if (!KI_MACRO_IDS.has(agentId) || !market || !market.kiMacro) return [];
  try {
    return kiBridge.formatKiMacroLines(market.kiMacro);
  } catch (_) {
    return []; // 서식이 깨져도 프롬프트 생성을 막지 않는다
  }
}

function kiMicroLines(market, agentId) {
  if (!KI_MICRO_IDS.has(agentId) || !market || !market.kiQuote) return [];
  try {
    return kiBridge.formatKiMicroLines(market.kiQuote);
  } catch (_) {
    return []; // 서식이 깨져도 프롬프트 생성을 막지 않는다
  }
}

// 출처 규율 — 무엇을 근거로 삼을 수 있는가.
//
// 이 데스크의 재료는 등급이 다르다. 공공기관 API 로 잰 값과 언론사 제목을
// 같은 무게로 읽으면, 리포트에서 "뉴스에서 봤다"가 "실측했다"처럼 읽힌다.
// 회의에서 그 구분이 사라지는 것이 이 시스템의 가장 조용한 실패다.
//
// 등급을 프롬프트에 명시하고, 주장마다 어느 등급에 기댔는지 밝히게 한다.
const SOURCE_RULE = [
  '[출처 규율 — 반드시 지켜라]',
  '  네가 받은 재료는 신뢰 등급이 다르다.',
  '',
  '  1차 (근거로 삼아도 된다)',
  '    · KRX 한국거래소 공식 API — 시세·거래량·시가총액',
  '    · DART 금융감독원 전자공시 — 재무·지분·사채·공시 원문',
  '    · 한국은행 ECOS — 금리·환율·경기 등 중앙은행 공식 통계',
  '    · 한국투자증권 KIS — 실시간 현재가·호가',
  '',
  '  참고 (근거로 삼지 마라)',
  '    · 언론 헤드라인 — 제목만 받은 것이고 본문·사실관계를 확인하지 않았다.',
  '      "이런 이야기가 돌고 있다"까지만 말할 수 있다.',
  '    · 센티먼트 지수 — 군중 심리의 대리지표일 뿐 사실이 아니다.',
  '',
  '  규칙',
  '    · 숫자를 말할 때는 어디서 온 값인지 함께 적어라.',
  '    · 재료에 없는 숫자를 네 기억에서 꺼내 쓰지 마라. 학습 시점에 멈춘 값이고,',
  '      그것이 틀렸을 때 아무도 추적할 수 없다. 모르면 "재료에 없다"고 적어라.',
  '    · 헤드라인만 근거인 주장에는 반드시 "미확인"이라고 붙여라.',
].join('\n');

function kiLines(market, agentId) {
  if (!market || !market.ki || !market.krCode) return [];
  let cfg;
  try {
    cfg = kiBridge.kiConfig();
  } catch (_) {
    return [];
  }
  // requiresKi 역할은 실측을 보라고 만든 자리다 — injectInto 목록과 무관하게 항상 받는다.
  const meta = AGENT_BY_ID[agentId];
  const always = !!(meta && meta.requiresKi);
  if (!always && (!Array.isArray(cfg.injectInto) || !cfg.injectInto.includes(agentId))) return [];
  try {
    return kiBridge.formatKiLines(market.ki, market.krCode, {
      staleWarnDays: cfg.staleWarnDays,
      detail: KI_DETAIL[agentId] || 'standard',
      sections: KI_SECTIONS[agentId],
    }).concat(kiMicroLines(market, agentId), kiMacroLines(market, agentId));
  } catch (_) {
    return []; // 서식이 깨져도 프롬프트 생성을 막지 않는다
  }
}

function lines(arr, fallback = '데이터 없음') {
  if (!Array.isArray(arr) || arr.length === 0) return fallback;
  return arr.map((s) => String(s)).join('\n');
}

function formatRecentCandles(candles, n = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return '데이터 없음';
  return candles
    .slice(-n)
    .map((c) => {
      const d = new Date(c.t);
      const day = Number.isNaN(d.getTime()) ? String(c.t) : d.toISOString().slice(0, 10);
      return `${day}  시가 ${c.o}  고가 ${c.h}  저가 ${c.l}  종가 ${c.c}  거래량 ${c.v}`;
    })
    .join('\n');
}

// 15분봉(인트라데이) — 날짜+시각(MM-DD HH:MM)까지 표기
function formatIntradayCandles(candles, n = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return '데이터 없음';
  return candles
    .slice(-n)
    .map((c) => {
      const d = new Date(c.t);
      const tm = Number.isNaN(d.getTime())
        ? String(c.t)
        : d.toISOString().slice(5, 16).replace('T', ' ');
      return `${tm}  시가 ${c.o}  고가 ${c.h}  저가 ${c.l}  종가 ${c.c}  거래량 ${c.v}`;
    })
    .join('\n');
}

function formatHeadlines(headlines, withAge = true) {
  if (!Array.isArray(headlines) || headlines.length === 0) return '데이터 없음';
  return headlines
    .map((h, i) => {
      const age = withAge && h.age ? ` (${h.age})` : '';
      return `${i + 1}. ${h.title}${age}`;
    })
    .join('\n');
}

function formatAnalystReports(reports) {
  const r = reports || {};
  return [
    `TARO(기술적 분석): ${r.taro || '(없음)'}`,
    `DIANA(기본적 분석): ${r.diana || '(없음)'}`,
    `NOVA(뉴스 분석): ${r.nova || '(없음)'}`,
    `VIBE(센티먼트): ${r.vibe || '(없음)'}`,
  ].join('\n');
}

function formatScalpReports(reports) {
  const r = reports || {};
  return [
    `BLITZ(스캘퍼): ${r.blitz || '(없음)'}`,
    `GUARD(리스크 관리): ${r.guard || '(없음)'}`,
  ].join('\n');
}

// ACE의 1차 판정을 리스크 위원회·PM에게 넘길 때의 문자열화.
// 엔진이 객체를 주지만 문자열로 줘도 그대로 통과시킨다.
function formatTraderPlan(plan) {
  if (!plan) return '(없음)';
  if (typeof plan === 'string') return plan;
  const p = plan || {};
  const out = [
    `액션: ${p.action || '-'}`,
    `확신도: ${p.confidence != null ? p.confidence + '%' : '-'}`,
    `진입: ${p.entry || '-'}`,
    `손절: ${p.stop || '-'}`,
    `목표: ${p.target || '-'}`,
  ];
  if (p.rationale) out.push(`근거: ${p.rationale}`);
  if (p.scalp && typeof p.scalp === 'object') {
    out.push(
      `스캘핑(20x): ${p.scalp.bias || '-'} / 진입 ${p.scalp.entry || '-'} / ` +
        `손절 ${p.scalp.stop || '-'} / 목표 ${p.scalp.target || '-'}`
    );
  }
  return out.join('\n');
}

// 리스크 위원회 의견 모음. exceptId를 주면 그 심사자 본인 의견은 뺀다(아직 안 낸 상태).
function formatRiskReports(reports, exceptId) {
  const r = reports || {};
  const order = [
    ['risky', 'RISKY(공격적)'],
    ['safe', 'SAFE(보수적)'],
    ['neutral', 'NEUTRAL(중립)'],
  ];
  const out = order
    .filter(([k]) => k !== exceptId && r[k])
    .map(([k, label]) => `${label}: ${r[k]}`);
  return out.length ? out.join('\n') : '';
}

// 과거 판정 회고(reflection) — 엔진이 decisions.json에서 만들어 넣는다.
function formatMemory(memory) {
  if (!memory) return '';
  if (Array.isArray(memory)) {
    const arr = memory.filter(Boolean).map((s) => String(s));
    return arr.length ? arr.join('\n') : '';
  }
  return String(memory);
}

const MEMORY_RULE =
  '위는 같은 심볼에 대한 과거 판정과 그 이후 가격 흐름이다. 같은 실수를 반복하지 마라. ' +
  '과거와 판단이 달라졌다면 무엇이 달라졌는지 rationale에 한 줄로 밝혀라. ' +
  '과거 판정에 끌려 현재 데이터를 왜곡해서도 안 된다.';

// krstock이면 "탭비트 <tapbitPair> 20배 무기한 관점" 지시 한 줄을 생성(아니면 빈 문자열)
function tapbitLine(market) {
  const m = market || {};
  if (m.kind === 'krstock' && m.tapbitPair) {
    const nm = m.nameKo ? `${m.nameKo} ` : '';
    return (
      `※ 이 종목(${nm}${m.display || m.symbol || ''})은 국내주식이지만 ` +
      `탭비트 ${m.tapbitPair} 무기한 선물 20배 관점으로 판단하라.`
    );
  }
  return '';
}

function formatDebateLog(debateLog) {
  if (!Array.isArray(debateLog) || debateLog.length === 0) return '(아직 발언 없음)';
  return debateLog
    .map((d) => {
      const meta = AGENT_BY_ID[d.id];
      const who = meta ? meta.name : String(d.id || '?');
      const bubble = d.bubble ? `[${d.bubble}] ` : '';
      return `${who}: ${bubble}${d.report || ''}`;
    })
    .join('\n');
}

// 스캘핑 데스크가 읽어야 할 차트를 고른다. KR 주식에는 탭비트와 동일한 계약의
// 24시간 USDT 무기한 데이터(market.perp)가 붙는데, KRX 정규장 원화 차트와는
// ATR·레인지가 크게 다르므로(정규장 폭락일엔 ATR이 몇 배로 부풀려진다) 20배
// 레버리지 판단은 반드시 실제 체결이 일어나는 이쪽을 봐야 한다.
function scalpSource(market) {
  const perp = market.perp;
  if (perp && perp.intraday && Array.isArray(perp.intraday.summaryLines)) {
    return {
      label: `체결 차트 — ${perp.source || 'USDT 무기한'}`,
      priceLine: perp.priceLine || '',
      indicatorLines: (perp.indicators || {}).summaryLines || [],
      intradayLines: perp.intraday.summaryLines,
      candles15m: perp.intraday.candles15m,
      fx: perp.krwPerUsd || null,
      isPerp: true,
    };
  }
  return {
    label: '체결 차트 — 정규장',
    priceLine: market.priceLine || '',
    indicatorLines: (market.indicators || {}).summaryLines || [],
    intradayLines: (market.intraday || {}).summaryLines || [],
    candles15m: (market.intraday || {}).candles15m,
    fx: null,
    isPerp: false,
  };
}

// 스캘핑 프롬프트 앞머리 — 어떤 차트를 보는지와 통화 기준을 못박는다.
function scalpChartBlock(market) {
  const src = scalpSource(market);
  const parts = [`[${src.label}]`];
  if (src.priceLine) parts.push(src.priceLine);
  if (src.isPerp) {
    parts.push(
      '이 계약이 실제 주문이 체결되는 차트다. 모든 진입·손절·목표는 이 USDT 가격으로 제시하라.' +
        (src.fx ? ` 원화 환산이 필요하면 환율 ${src.fx}을 쓰고 괄호로 병기하라.` : '')
    );
  }
  parts.push('');
  parts.push('[체결 차트 기술 지표]');
  parts.push(lines(src.indicatorLines));
  parts.push('');
  parts.push('[체결 차트 인트라데이 요약]');
  parts.push(lines(src.intradayLines));
  const board = market.board && Array.isArray(market.board.lines) ? market.board.lines : null;
  if (board) {
    parts.push('');
    parts.push('[멀티 거래소 전광판]');
    parts.push(lines(board));
  }
  return { parts, src };
}

// 브리핑 분량 공통 규칙 — 화면 우측 콘솔에 전문이 흐르므로 길고 구조적으로 쓰게 한다.
const BRIEFING_RULE =
  '[브리핑 분량] report는 8~14문장의 본격 브리핑이다. 소제목 없이 자연스러운 단락 2~3개로 쓰고, ' +
  '① 관찰한 수치를 구체적으로 인용 ② 그 수치의 해석 ③ 반대 시나리오와 리스크 ' +
  '④ 판단이 바뀌는 트리거(가격·레벨·이벤트)를 반드시 담아라. ' +
  '제공된 데이터에 없는 수치는 절대 만들지 말고, 없으면 "데이터 없음"이라고 밝혀라. ' +
  'bubble은 말풍선에 여러 줄로 표시되므로 2~3문장(60~120자)으로 결론과 핵심 근거를 담아라.';

const BUBBLE_SPEC = '"bubble":"말풍선 2~3문장(한국어, 60~120자)"';
const REPORT_SPEC = '"report":"상세 브리핑(한국어, 8~14문장)"';

// bubble/report만 요구하는 공통 JSON 출력 규칙
const OUTPUT_BASIC =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  `{${BUBBLE_SPEC},${REPORT_SPEC}}`;

// pm 전용 — 트레이더 계획에 대한 최종 승인/수정/기각
const OUTPUT_PM =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  `{${BUBBLE_SPEC},${REPORT_SPEC},` +
  '"verdict":"APPROVE|AMEND|REJECT 중 하나","action":"BUY|SELL|HOLD 중 하나","confidence":0-100 사이 정수,' +
  '"entry":"진입가 또는 진입 조건","stop":"손절가","target":"목표가",' +
  '"sizing":"권장 포지션 비중 한 줄(한국어)","rationale":"승인/수정/기각 근거 2-3문장(한국어)"}';

// ace 전용 확장 JSON 출력 규칙 — 스캘핑 데스크가 없는 런(알고리즘 모드)용
const OUTPUT_ACE_CORE =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  '{"bubble":"말풍선 2~3문장(한국어, 60~120자)","report":"상세 브리핑(한국어, 8~14문장)",' +
  '"action":"BUY|SELL|HOLD 중 하나","confidence":0-100 사이 정수,' +
  '"entry":"진입가 또는 진입 조건","stop":"손절가","target":"목표가","rationale":"판정 근거 2-3문장(한국어)"}';

// ace 전용 확장 JSON 출력 규칙 — 스캘핑 데스크 포함 런용
const OUTPUT_ACE =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  '{"bubble":"말풍선 2~3문장(한국어, 60~120자)","report":"상세 브리핑(한국어, 8~14문장)",' +
  '"action":"BUY|SELL|HOLD 중 하나","confidence":0-100 사이 정수,' +
  '"entry":"진입가 또는 진입 조건","stop":"손절가","target":"목표가","rationale":"판정 근거 2-3문장(한국어)",' +
  '"scalp":{"bias":"LONG|SHORT|PASS 중 하나","entry":"진입 트리거 가격/조건","stop":"무효화(손절) 레벨",' +
  '"target":"1차 청산 목표","note":"20배 리스크 한 줄(한국어)"}}';

// ace 전용 — 공격 모드(PASS 금지, 반드시 방향을 고른다)
const OUTPUT_ACE_ATTACK =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  '{"bubble":"말풍선 2~3문장(한국어, 60~120자)","report":"상세 브리핑(한국어, 8~14문장)",' +
  '"action":"BUY|SELL 중 하나(HOLD 금지)","confidence":0-100 사이 정수,' +
  '"entry":"진입가 또는 진입 조건","stop":"손절가","target":"목표가","rationale":"판정 근거 2-3문장(한국어)",' +
  '"scalp":{"bias":"LONG 또는 SHORT (PASS 절대 금지)","entry":"진입 트리거 가격/조건","stop":"무효화(손절) 레벨",' +
  '"target":"1차 청산 목표","note":"20배 리스크 한 줄(한국어)"}}';

// ---------------------------------------------------------------------------
// 레벨·손익비 규칙 (ACE·PM·BLITZ)
// "지지선 이탈" 같은 서술형 레벨은 riskmath가 숫자로 파싱하지 못해 손익비 계산이
// 통째로 죽는다. 그래서 숫자를 강제하고, 최소 손익비도 프롬프트 단계에서 못박는다.
// ---------------------------------------------------------------------------
const DEFAULT_MIN_RR = 1.5;

// config.js는 v2에서 새로 붙는 모듈이라 없을 수 있다 — 없으면 기본값 1.5를 쓴다.
function minRRValue() {
  try {
    const { loadConfig } = require('./config');
    const cfg = loadConfig();
    const v = cfg && cfg.risk ? cfg.risk.minRR : null;
    if (Number.isFinite(v) && v > 0) return v;
  } catch (_) {
    /* 설정 모듈 없음 — 기본값 사용 */
  }
  return DEFAULT_MIN_RR;
}

const NUMERIC_LEVEL_RULE =
  '[레벨 표기 규칙] 진입·손절·목표는 반드시 구체적 숫자를 포함해 제시하라' +
  '(예: "1,341,000 이탈 시 손절"). 숫자 없이 "지지선 이탈" 같은 서술만 쓰면 안 된다.';

// 최소 손익비 요구. 공격 모드는 관망을 출력할 수 없으므로 대안을 준다.
function minRRRule(attack) {
  const n = minRRValue();
  const head = `[손익비 기준] 목표까지의 거리는 손절까지 거리의 ${n}배 이상이어야 한다. `;
  return (
    head +
    (attack
      ? '그 조건을 만족하는 자리가 없으면 손절 위치와 목표를 다시 잡아 손익비를 맞춰라. ' +
        '그래도 맞출 수 없으면 확신도를 크게 낮추고 그 사실을 rationale에 밝혀라 ' +
        '(이번 런은 공격 모드라 관망을 출력할 수 없다).'
      : '그 조건을 만족하는 자리가 없으면 억지로 만들지 말고 관망(HOLD/PASS)을 택하라.')
  );
}

// 엔진이 riskmath로 계산해 넣어주는 청산 컨텍스트(context.riskInfo)를 프롬프트용
// 문자열로 만든다. 없으면 빈 문자열 — 프롬프트에 아무것도 붙지 않는다.
function formatRiskInfo(info) {
  if (!info) return '';
  if (typeof info === 'string') return info.trim();
  if (Array.isArray(info)) return lines(info, '');
  if (typeof info !== 'object') return '';
  if (Array.isArray(info.lines) && info.lines.length) {
    return info.lines.filter(Boolean).map((s) => String(s)).join('\n');
  }
  // lines가 없으면 숫자 필드에서 직접 만든다.
  const out = [];
  const lev = Number.isFinite(info.leverage) ? info.leverage : null;
  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : null);
  if (Number.isFinite(info.price)) out.push(`기준가 ${info.price}${info.source ? ` — ${info.source}` : ''}`);
  if (Number.isFinite(info.longLiq)) {
    out.push(`${lev != null ? `${lev}배 ` : ''}롱 청산가 ${info.longLiq}${pct(info.longBufferPct) ? ` (${pct(info.longBufferPct)})` : ''}`);
  }
  if (Number.isFinite(info.shortLiq)) {
    out.push(`${lev != null ? `${lev}배 ` : ''}숏 청산가 ${info.shortLiq}${pct(info.shortBufferPct) ? ` (${pct(info.shortBufferPct)})` : ''}`);
  }
  if (Number.isFinite(info.planLiq)) {
    out.push(`계획 진입가 기준 청산가 ${info.planLiq}${pct(info.planLiqDistPct) ? ` (${pct(info.planLiqDistPct)})` : ''}`);
  }
  return out.join('\n');
}

// 공격 모드 공통 지시 — 방향은 강제하되 리스크 고지는 강제로 남긴다.
const ATTACK_RULE =
  '[공격 모드] 이번 런은 반드시 방향을 고르는 모드다. "관망"·"중립"·"판단 보류"는 금지이며 ' +
  'PASS/HOLD를 출력할 수 없다. 근거가 팽팽하면 조금이라도 우위인 쪽을 골라 확신도로 그 애매함을 표현하라 ' +
  '(우위가 미약하면 confidence를 낮게 준다). 단, 방향을 골랐다고 해서 리스크를 숨기지 마라 — ' +
  '무효화(손절) 레벨과 20배 청산 위험 경고는 반드시 그대로 제시한다.';

function header(meta) {
  return (
    `너는 픽셀 트레이딩 플로어의 ${meta.name}(${meta.role})이다. ` +
    '아래 제공된 데이터만 사용하고 도구·검색을 쓰지 마라.'
  );
}

// ---------------------------------------------------------------------------
// buildPrompt(id, context) — 역할별 데이터 주입
// context: { market, analystReports?, debateLog? }
// ---------------------------------------------------------------------------
function buildPrompt(id, context = {}) {
  const meta = AGENT_BY_ID[id];
  const market = context.market || {};
  const ind = market.indicators || {};
  const symLine = `대상: ${market.display || market.symbol || '심볼'} (${market.symbol || ''})\n${market.priceLine || '가격 정보 없음'}`;
  const attack = context.mode === 'attack';
  // 원장 실측값. 비어 있으면(꺼짐·비한국주식·조회 실패) 아무 데도 붙지 않는다.
  const kiFacts = kiLines(market, id);
  let kiUsed = false;

  const parts = [header(meta), '', symLine, ''];

  if (id === 'taro') {
    // 스캘핑·공격 모드에서는 실제 체결이 일어나는 차트(USDT 무기한)를 주 재료로 쓰고,
    // 정규장 지표는 참고로만 붙인다.
    const scalping = context.mode === 'scalp' || attack;
    const src = scalping ? scalpSource(market) : null;
    if (src && src.isPerp) {
      parts.push(`[${src.label}]`);
      parts.push(src.priceLine);
      parts.push('');
      parts.push('[체결 차트 기술 지표]');
      parts.push(lines(src.indicatorLines));
      parts.push('');
      parts.push('[체결 차트 인트라데이 요약]');
      parts.push(lines(src.intradayLines));
      parts.push('');
      parts.push('[참고 — 정규장 지표]');
      parts.push(lines(ind.summaryLines));
      parts.push('');
      parts.push(
        '위 데이터를 근거로 추세·모멘텀·지지저항을 분석하라. ' +
          '레벨은 체결 차트 가격으로 제시하고, 정규장 지표는 참고로만 언급하라.'
      );
    } else {
      parts.push('[기술 지표 요약]');
      parts.push(lines(ind.summaryLines));
      parts.push('');
      parts.push('[최근 20일 캔들]');
      parts.push(formatRecentCandles(market.candles, 20));
      parts.push('');
      parts.push('위 기술적 데이터를 근거로 추세·모멘텀·지지저항을 분석하라.');
    }
  } else if (id === 'diana') {
    parts.push('[기본적 데이터]');
    parts.push(lines((market.fundamentals || {}).lines));
    if (kiFacts.length) {
      parts.push('');
      parts.push('[KRX·DART 실측 — 주가 모니터링 원장]');
      parts.push(kiFacts.join('\n'));
      kiUsed = true;
    }
    parts.push('');
    parts.push('위 기본적 데이터를 근거로 밸류에이션과 펀더멘털을 분석하라.');
  } else if (id === 'flow') {
    // 유동성·체결 전담. "팔 수 있는가"가 아니라 **"어떻게 팔면 얼마에 팔리는가"**.
    parts.push('[원장 실측 — 유동성·체결]');
    parts.push(kiFacts.length ? kiFacts.join('\n') : '데이터 없음');
    kiUsed = true;
    parts.push('');
    parts.push(
      '너는 유동성·체결 담당(FLOW)이다. 다른 애널리스트는 방향을 보지만 너는 ' +
        '**실행 가능성**만 본다. 세 가지에 답하라.\n' +
        '1) 이 물량을 정규장에서 소화하는 데 현실적으로 며칠이 걸리는가 — ' +
        '평균 기준과 중앙값 기준이 갈리면 어느 쪽을 믿어야 하는지 근거를 대라.\n' +
        '2) 매도 규칙 4종 중 과거 실현단가가 가장 나았던 것과 가장 나빴던 것의 ' +
        '차이는 몇 bp인가. 그 차이가 유의미한 크기인가, 아니면 시작일 운에 묻히는가 ' +
        '(사분위 폭을 근거로).\n' +
        '3) 매물대상 어느 가격에서 대기 물량이 나올 가능성이 큰가.\n' +
        '체결률이 1 미만인 규칙은 물량을 다 못 판 것이다 — 실현단가만 보고 좋다고 하지 마라. ' +
        '방향(매수·매도) 판정은 네 일이 아니다. 그건 다른 사람이 한다.'
    );
  } else if (id === 'filing') {
    // 공시·자본구조 전담. 엑싯 '단가'를 좌우하는 희석·물량 쪽.
    parts.push('[원장 실측 — 공시·자본구조]');
    parts.push(kiFacts.length ? kiFacts.join('\n') : '데이터 없음');
    kiUsed = true;
    parts.push('');
    parts.push(
      '너는 공시·자본구조 담당(FILING)이다. 가격이 아니라 **주식수와 물량**을 본다. ' +
        '세 가지에 답하라.\n' +
        '1) 미상환 전환사채가 전부 전환되면 지분과 주가가 얼마나 눌리는가. ' +
        '주가가 더 내렸을 때 희석이 가속되는 구간이 어디인가.\n' +
        '2) 최대주주·특수관계인 지분은 우리와 같은 창구로 나올 수 있는 물량이다. ' +
        '그 규모가 우리 처분 계획에 어떤 제약을 거는가.\n' +
        '3) 보호예수·희석·위험 공시 중 회수 시점을 미루거나 앞당길 사유가 있는가.\n' +
        '자본구조가 미조회 상태면 "모른다"고 명확히 적어라 — 없는 것과 안 본 것은 다르다. ' +
        '리픽싱 하한은 가정값이다. 그 가정에 기대는 결론에는 반드시 단서를 달아라.'
    );
  } else if (id === 'nova') {
    parts.push('[언론 헤드라인 — 구글 뉴스 RSS · 참고 등급]');
    parts.push(formatHeadlines((market.news || {}).headlines, true));
    parts.push('');
    parts.push(
      '위 뉴스 흐름이 가격에 미칠 영향을 분석하라. 다만 이것은 **제목만 받은 것**이다. ' +
        '본문도, 원 출처도, 사실관계도 확인하지 않았다. 그러므로 ' +
        '"이런 이야기가 돌고 있다"까지만 말하고, 사실로 단정하지 마라.\n' +
        '기업에 실제로 무슨 일이 있었는지는 DART 공시가 1차 출처다 — ' +
        '헤드라인이 공시와 어긋나면 공시를 믿어라.\n' +
        '헤드라인에 없는 사건을 네 기억에서 꺼내 보태지 마라. 그 순간 이 절은 ' +
        '추적할 수 없는 문장이 된다.'
    );
  } else if (id === 'vibe') {
    parts.push('[센티먼트 지표]');
    parts.push(lines((market.sentiment || {}).lines));
    parts.push('');
    parts.push('[언론 헤드라인 — 제목만 · 참고 등급]');
    parts.push(formatHeadlines((market.news || {}).headlines, false));
    parts.push('');
    parts.push(
      '위 심리·여론 데이터로 투자 심리를 분석하라. 이 재료는 전부 참고 등급이다 — ' +
        '심리 지표는 군중의 온도이지 사실이 아니고, 헤드라인은 제목뿐이다.\n' +
        '심리를 근거로 가격의 방향을 단정하지 마라. 네가 낼 수 있는 것은 ' +
        '"지금 시장이 이 종목을 어떻게 느끼고 있는가"까지다.'
    );
  } else if (id === 'bull' || id === 'bear') {
    const stance =
      id === 'bull'
        ? '너는 강세론자(BULL)다. 위 데이터로 매수 논거를 강하게 제시하라.'
        : '너는 약세론자(BEAR)다. 위 데이터로 매도 논거를 강하게 제시하라.';
    const rival = id === 'bull' ? '약세론자(BEAR)' : '강세론자(BULL)';
    parts.push('[애널리스트 4인 리포트]');
    parts.push(formatAnalystReports(context.analystReports));
    parts.push('');
    parts.push('[진행된 토론]');
    parts.push(formatDebateLog(context.debateLog));
    parts.push('');
    parts.push(stance);
    parts.push(
      `[진행된 토론]의 가장 최근 ${rival} 발언을 구체적으로 지목해 반박하라. ` +
        'bubble과 report 모두에 반박 논지를 담아라.'
    );
  } else if (id === 'blitz') {
    const tl = tapbitLine(market);
    if (tl) {
      parts.push(tl);
      parts.push('');
    }
    const { parts: chart } = scalpChartBlock(market);
    parts.push(...chart);
    parts.push('');
    parts.push('[15분봉 최근 20개]');
    parts.push(formatIntradayCandles(scalpSource(market).candles15m, 20));
    parts.push('');
    parts.push('[TARO 기술적 분석 리포트]');
    parts.push((context.analystReports || {}).taro || '(없음)');
    parts.push('');
    if (attack) {
      parts.push(ATTACK_RULE);
      parts.push(
        '너는 스캘퍼(BLITZ)다. 단기(수시간 내) 스캘핑 관점에서 판단하라. ' +
          '방향 편향은 반드시 롱 또는 숏 중 하나를 고르고("관망" 금지), ' +
          '진입 트리거 가격, 1차 청산 목표, 무효화 레벨을 구체적 숫자로 제시하라. ' +
          '고른 방향의 근거와 함께, 그 방향이 틀렸다고 판명되는 지점(무효화 레벨)도 반드시 밝혀라.'
      );
    } else {
      parts.push(
        '너는 스캘퍼(BLITZ)다. 단기(수시간 내) 스캘핑 관점에서 판단하라. ' +
          '방향 편향(롱/숏/관망), 진입 트리거 가격, 1차 청산 목표, 무효화 레벨을 ' +
          '반드시 구체적 숫자로 제시하라.'
      );
    }
    parts.push(NUMERIC_LEVEL_RULE);
    parts.push(minRRRule(attack));
  } else if (id === 'guard') {
    const tl = tapbitLine(market);
    if (tl) {
      parts.push(tl);
      parts.push('');
    }
    const { parts: chart } = scalpChartBlock(market);
    parts.push(...chart);
    parts.push('');
    parts.push('[BLITZ 스캘핑 리포트]');
    parts.push((context.scalpReports || {}).blitz || '(없음)');
    parts.push('');
    // 엔진이 riskmath로 계산해 넣어준 청산가·청산까지 거리(없으면 이 블록 자체가 없다)
    const guardRisk = formatRiskInfo(context.riskInfo);
    if (guardRisk) {
      parts.push('[청산 계산 — 엔진이 riskmath로 계산한 값]');
      parts.push(guardRisk);
      parts.push('');
      parts.push('위 청산가와 청산까지 거리는 계산된 값이다. 그대로 인용하고 다시 지어내지 마라.');
      parts.push('');
    }
    parts.push(
      '너는 리스크 관리자(GUARD)다. 20배 레버리지 리스크를 점검하라. ' +
        (guardRisk
          ? '청산 버퍼는 위 [청산 계산] 블록의 숫자를 그대로 쓴다. '
          : '격리 20배 기준 청산까지 역행 여유는 약 -4.7~-5.0%다. ') +
        'BLITZ의 무효화 레벨이 이 청산 버퍼 안에 있는지, 체결 차트의 15분봉 ATR% 기준으로 ' +
        '청산까지 몇 ATR인지, 계좌 대비 권장 베팅 비중(리스크 2% 룰)을 구체적 숫자로 짚어라.'
    );
    if (attack) {
      parts.push(
        '[공격 모드] 이번 런에서는 "진입하지 마라"로 결론내지 마라. 대신 이 방향을 ' +
          '살아남게 만드는 조건 — 손절 위치 조정, 비중 축소 배수, 레버리지 하향 필요 여부, ' +
          '즉시 정리해야 할 상황 — 을 제시하라. 청산 위험 경고 자체는 절대 생략하지 마라.'
      );
    } else {
      parts.push(
        '진입 금지 조건(뉴스 이벤트·스프레드 확대·저유동성)도 구체적으로 짚어라.'
      );
    }
  } else if (id === 'risky' || id === 'neutral' || id === 'safe' || id === 'red') {
    // 논문의 Risk Management team — 트레이더 계획을 성향별로 심사하고 서로 반박한다.
    const STANCE = {
      risky:
        '너는 공격적 리스크 심사자(RISKY)다. 기회를 놓치는 비용(기회비용)을 최우선으로 본다. ' +
        '이 계획이 지나치게 보수적이지 않은지, 비중을 키우거나 목표를 더 멀리 잡을 근거가 있는지 주장하라. ' +
        '다만 손실 한도를 무시하라는 뜻은 아니다 — 감당 가능한 최대 리스크를 명시하라.',
      safe:
        '너는 보수적 리스크 심사자(SAFE)다. 자본 보존과 꼬리위험(tail risk)을 최우선으로 본다. ' +
        '이 계획에서 최악의 시나리오가 무엇이고 그때 손실이 얼마인지 계산해 제시하고, ' +
        '비중 축소·손절 상향·진입 보류 중 무엇이 필요한지 분명히 주장하라.',
      neutral:
        '너는 중립적 리스크 심사자(NEUTRAL)다. 앞선 심사자들의 주장을 각각 인용해 어디까지 타당하고 ' +
        '어디서 과장인지 가르고, 양쪽을 절충한 조건부 승인안(어떤 조건이면 진행, 어떤 조건이면 축소·기각)을 제시하라. ' +
        'RED 가 제기한 가정 문제도 함께 판정하라 — 그 지적이 계획을 바꿔야 할 만큼 큰가, 단서로 족한가.',
      // RED 는 계획을 심사하지 않는다. 계획이 딛고 선 **숫자의 토대**를 심문한다.
      red:
        '너는 가정 반대심문관(RED)이다. 다른 심사자들이 계획의 좋고 나쁨을 다툴 때, ' +
        '너는 그 계획이 딛고 선 **숫자가 성립하는지**를 공격한다. 이것만 한다.\n' +
        '1) 위 [위 숫자가 서 있는 가정] 각 항목이 **이 종목에** 맞는가. 처분 참여율 가정, ' +
        '보호예수 추정, 업종 표본 기준, 가격충격 모형 — 어느 것이 이 종목에서 가장 먼저 깨지는가.\n' +
        '2) [이 원장이 재지 못한 것] 중 계획이 **암묵적으로 있다고 전제한** 값이 있는가. ' +
        '없는 값을 0 이나 평균으로 대체해 읽고 있지는 않은가.\n' +
        '3) 관측기간이 짧아 분위(pctile)의 의미가 약한데도 그것을 근거로 쓴 대목이 있는가.\n' +
        '4) 가정 하나를 바꾸면 판정이 뒤집히는가 — 뒤집힌다면 어느 가정을 어디까지 바꿔야 하는지 숫자로 대라.\n' +
        '**매수·매도 방향을 제시하지 마라. 비중도 손절도 네 일이 아니다.** ' +
        '공격할 것이 없으면 "이 판정은 가정 측면에서 견고하다"고 명확히 적어라 — ' +
        '억지로 흠을 만들지 마라.',
    };
    parts.push('[애널리스트 리포트]');
    parts.push(formatAnalystReports(context.analystReports));
    parts.push('');
    if (context.debateLog && context.debateLog.length) {
      parts.push('[리서치 토론 로그]');
      parts.push(formatDebateLog(context.debateLog));
      parts.push('');
    }
    parts.push('[수석 트레이더의 1차 계획]');
    parts.push(formatTraderPlan(context.traderPlan));
    parts.push('');
    const priorRisk = formatRiskReports(context.riskReports, id);
    if (priorRisk) {
      parts.push('[앞선 리스크 심사 의견]');
      parts.push(priorRisk);
      parts.push('');
      parts.push('위 의견을 반드시 직접 인용해 동의 또는 반박하라.');
      parts.push('');
    }
    const tlr = tapbitLine(market);
    if (tlr) {
      parts.push(tlr);
      parts.push('');
    }
    // 엔진이 riskmath로 계산해 넣어준 청산가·청산까지 거리.
    // SAFE가 최악 시나리오를 숫자로 계산해야 하므로 위원회 전원에게 같은 값을 준다
    // (심사자마다 다른 숫자를 지어내면 토론 자체가 성립하지 않는다).
    const riskRisk = formatRiskInfo(context.riskInfo);
    if (riskRisk) {
      parts.push('[청산 계산 — 엔진이 riskmath로 계산한 값]');
      parts.push(riskRisk);
      parts.push('');
      parts.push('위 청산가와 청산까지 거리는 계산된 값이다. 그대로 인용하고 다시 지어내지 마라.');
      parts.push('');
    }
    parts.push(STANCE[id]);
    parts.push(
      '20배 레버리지가 걸린 계획이라면 청산 위험(격리 20배는 약 -5% 역행에 증거금 전액 청산)을 ' +
        '반드시 언급하라. 공격적 심사자라도 이 경고는 생략할 수 없다.'
    );
  } else if (id === 'pm') {
    // 논문의 Portfolio Manager — 최종 관문.
    parts.push('[애널리스트 리포트]');
    parts.push(formatAnalystReports(context.analystReports));
    parts.push('');
    if (context.debateLog && context.debateLog.length) {
      parts.push('[리서치 토론 로그]');
      parts.push(formatDebateLog(context.debateLog));
      parts.push('');
    }
    parts.push('[수석 트레이더의 1차 계획]');
    parts.push(formatTraderPlan(context.traderPlan));
    parts.push('');
    parts.push('[리스크 위원회 심사 의견]');
    parts.push(formatRiskReports(context.riskReports) || '(없음)');
    parts.push('');
    const mem = formatMemory(context.memory);
    if (mem) {
      parts.push('[과거 판정 회고]');
      parts.push(mem);
      parts.push('');
      parts.push(MEMORY_RULE);
      parts.push('');
    }
    const tlp = tapbitLine(market);
    if (tlp) {
      parts.push(tlp);
      parts.push('');
    }
    parts.push(
      '너는 포트폴리오 매니저(PM)다. 리스크 위원회 의견을 종합해 트레이더의 계획을 ' +
        '승인(APPROVE)·수정승인(AMEND)·기각(REJECT) 중 하나로 판정하는 최종 관문이다. ' +
        'AMEND라면 원래 계획의 무엇을 어떻게 바꿨는지(진입·손절·목표·비중) rationale에 분명히 밝혀라. ' +
        'REJECT라면 action을 HOLD로 두고 기각 사유를 밝혀라. ' +
        'sizing에는 계좌 대비 권장 비중을 한 줄로 제시하라(리스크 2% 룰 기준).'
    );
    parts.push(NUMERIC_LEVEL_RULE);
    parts.push(minRRRule(attack));
  } else if (id === 'ace') {
    const tl = tapbitLine(market);
    const mem = formatMemory(context.memory);
    if (mem) {
      parts.push('[과거 판정 회고]');
      parts.push(mem);
      parts.push('');
      parts.push(MEMORY_RULE);
      parts.push('');
    }
    // 스캘핑 데스크가 돌지 않은 런(알고리즘 모드)에서는 scalp 관련 주입·요구를 생략한다.
    const hasScalp = !!(
      context.scalpReports &&
      (context.scalpReports.blitz || context.scalpReports.guard)
    );
    parts.push('[애널리스트 리포트]');
    parts.push(formatAnalystReports(context.analystReports));
    parts.push('');
    // 최종 판정자에게는 애널리스트를 거친 해석이 아니라 원본 실측도 함께 준다.
    // 처분에 몇 영업일이 걸리는가는 목표가만큼이나 회수 판단을 좌우한다.
    if (kiFacts.length) {
      parts.push('[KRX·DART 실측 — 주가 모니터링 원장]');
      parts.push(kiFacts.join('\n'));
      parts.push('');
      kiUsed = true;
    }
    if (context.debateLog && context.debateLog.length) {
      parts.push('[전체 토론 로그]');
      parts.push(formatDebateLog(context.debateLog));
      parts.push('');
    }
    if (hasScalp) {
      parts.push('[스캘핑 데스크 리포트 (20x)]');
      parts.push(formatScalpReports(context.scalpReports));
      parts.push('');
    }
    if (tl) {
      parts.push(tl);
      parts.push('');
    }
    if (hasScalp) {
      const { parts: chart, src } = scalpChartBlock(market);
      parts.push(...chart);
      parts.push('');
      if (src.isPerp) {
        parts.push(
          'scalp 레벨은 위 체결 차트(USDT)의 가격으로 내고, action/entry/stop/target(스윙)은 ' +
            '정규장 원화 기준으로 낸다 — 두 축을 섞지 마라.'
        );
        parts.push('');
      }
    }
    if (attack) parts.push(ATTACK_RULE);
    parts.push(
      '너는 수석 트레이더(ACE)다. 위 모든 분석과 토론을 종합해 최종 매매 판정을 내려라. ' +
        (attack
          ? 'action은 반드시 BUY 또는 SELL 중 하나다(HOLD 금지). confidence는 0~100 정수이며, ' +
            '근거가 팽팽할수록 낮게 준다.'
          : 'action은 반드시 BUY, SELL, HOLD 중 하나여야 하고 confidence는 0~100 정수다.')
    );
    if (hasScalp) {
      parts.push(
        'action/confidence/entry/stop/target/rationale는 현물·스윙(중장기) 관점의 판정이다. ' +
          '이와 별도로 scalp 필드에는 탭비트 20배 무기한 선물 단타 관점의 판정을 담아라. ' +
          (attack
            ? 'scalp.bias는 LONG 또는 SHORT 중 하나다 — PASS는 출력할 수 없다. '
            : 'scalp.bias는 LONG, SHORT, PASS 중 하나이고, ') +
          'entry(진입 트리거)·stop(무효화 레벨)·' +
          'target(1차 청산 목표)은 스캘핑 데스크(BLITZ·GUARD) 리포트를 반영한 구체적 숫자로, ' +
          'note는 20배 리스크를 한 줄로 요약하라.'
      );
    }
    parts.push(NUMERIC_LEVEL_RULE);
    parts.push(minRRRule(attack));
    parts.push('');
    parts.push(SOURCE_RULE);
    parts.push('');
    parts.push(BRIEFING_RULE);
    parts.push('');
    parts.push(hasScalp ? (attack ? OUTPUT_ACE_ATTACK : OUTPUT_ACE) : OUTPUT_ACE_CORE);
    return parts.join('\n');
  }

  if (kiFacts.length && !kiUsed) {
    parts.push('');
    parts.push('[KRX·DART 실측 — 주가 모니터링 원장]');
    parts.push(kiFacts.join('\n'));
  }

  parts.push('');
  parts.push(SOURCE_RULE);
  parts.push('');
  parts.push(BRIEFING_RULE);
  parts.push('');
  parts.push(id === 'pm' ? OUTPUT_PM : OUTPUT_BASIC);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// claude 스폰
// ---------------------------------------------------------------------------
// claude를 어느 폴더에서 실행할지.
// 프로젝트 폴더에서 실행하면 "이 폴더의 파일을 신뢰합니까?" 게이트에 걸릴 수 있는데,
// -p(비대화형)에는 답할 사람이 없어 출력이 통째로 비어버린다.
// 에이전트는 프롬프트를 stdin으로만 받으므로 작업 폴더가 필요 없다 →
// 사용자가 처음 로그인하며 이미 승인했을 홈 디렉터리에서 실행한다.
const CLAUDE_CWD = require('node:os').homedir();

// claude 실행 파일 위치.
// 흔한 함정: Claude Code를 설치한 뒤 PATH가 갱신되기 전에 열려 있던 창(탐색기 포함)에서
// 서버를 켜면, 그 프로세스는 claude를 영영 못 찾는다. 터미널에서는 잘 되는데 앱만 안 되는
// 상태가 이것이다. 그래서 PATH에서 못 찾으면 표준 설치 경로들을 직접 뒤진다.
const CLAUDE_CANDIDATES = [
  path.join(CLAUDE_CWD, '.local', 'bin', 'claude.exe'), // 네이티브 설치
  path.join(CLAUDE_CWD, '.local', 'bin', 'claude'),
  path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), // npm -g
  path.join(process.env.APPDATA || '', 'npm', 'claude'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'), // winget
];

// 에이전트 모델 — 역할에 따라 나눈다.
//
// 16명이 전부 최상위 모델을 쓸 이유가 없다. 재료를 읽어 정리하는 일과,
// 그 정리를 받아 **판정을 내리는 일**은 요구하는 것이 다르다. 전자까지
// 최상위로 돌리면 한 종목에 10~20분이 걸리고, 그 시간의 대부분은 판정
// 품질에 기여하지 않는다.
//
//   깊게 (기본 opus)
//     ACE  최종 판정 — 여기서 틀리면 전부 틀린다
//     PM   승인 — 비중과 게이트를 최종 결정한다
//     RED  가정 반대심문 — 반례를 찾는 일이라 추론 깊이가 곧 품질이다
//     BULL·BEAR  4턴 토론 — 상대 논리의 허점을 짚어야 한다
//
//   빠르게 (기본 sonnet)
//     애널리스트 6명 — 주어진 재료를 성향대로 읽어 정리한다
//     RISKY·SAFE·NEUTRAL — 정해진 성향으로 심사한다
//     BLITZ·GUARD — 스캘핑 데스크
//
// 되돌리는 법 — FLOOR_MODEL 을 명시하면 **전원 그 모델**을 쓴다.
// 통합 이전처럼 전부 opus 로 돌리려면 FLOOR_MODEL=opus 를 주면 된다.
const _clean = (s) => String(s || '').replace(/[^a-z0-9.-]/gi, '');
const FLOOR_MODEL = _clean(process.env.FLOOR_MODEL);          // 있으면 전원 고정
const MODEL_DEEP = _clean(process.env.FLOOR_MODEL_DEEP) || 'opus';
const MODEL_FAST = _clean(process.env.FLOOR_MODEL_FAST) || 'sonnet';
const DEEP_IDS = new Set(['ace', 'pm', 'red', 'bull', 'bear']);

function modelFor(id) {
  if (FLOOR_MODEL) return FLOOR_MODEL;      // 명시했으면 그것만 쓴다
  return DEEP_IDS.has(id) ? MODEL_DEEP : MODEL_FAST;
}

let claudeBin = null; // 확정된 실행 경로(따옴표 포함) 또는 'claude'

function quoted(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}

// PATH의 claude가 동작하면 그대로, 아니면 후보 경로 중 실제로 존재하는 것을 쓴다.
function resolveClaudeBin() {
  if (claudeBin) return claudeBin;
  for (const c of CLAUDE_CANDIDATES) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) {
        claudeBin = quoted(c);
        return claudeBin;
      }
    } catch {
      /* 무시 */
    }
  }
  claudeBin = 'claude';
  return claudeBin;
}

function spawnClaude(prompt, model) {
  const m = _clean(model) || MODEL_DEEP;
  return new Promise((resolve) => {
    const child = spawn(`${resolveClaudeBin()} -p --model ${m}`, { shell: true, cwd: CLAUDE_CWD });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 무시 */
      }
      finish({ stdout, stderr, timedOut: true, code: null });
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err && err.message ? err.message : String(err)}`;
      finish({ stdout, stderr, code: null, error: err });
    });
    child.on('close', (code) => {
      finish({ stdout, stderr, code });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      stderr += `\n[stdin error] ${err && err.message ? err.message : String(err)}`;
      finish({ stdout, stderr, code: null, error: err });
    }
  });
}

// 파싱 결과를 표준화: bubble/report 문자열 보장, 나머지 필드(action 등)는 그대로 통과
function normalizeResult(parsed) {
  const out = { ...parsed };
  out.bubble = typeof parsed.bubble === 'string' && parsed.bubble.trim() ? parsed.bubble.trim() : '분석 완료';
  out.report = typeof parsed.report === 'string' ? parsed.report : '';
  return out;
}

// 실전 런 직전 1회 점검 — claude CLI가 실제로 응답하는지 확인한다.
// 없거나 막혀 있으면 에이전트 열여섯을 헛돌리는 대신 즉시 원인을 알려준다.
let claudeCheck = null; // { ok, message, ts }
const CHECK_TTL_MS = 5 * 60 * 1000;

function checkClaudeAvailable() {
  const now = Date.now();
  if (claudeCheck && now - claudeCheck.ts < CHECK_TTL_MS && claudeCheck.ok) {
    return Promise.resolve(claudeCheck);
  }
  return new Promise((resolve) => {
    const child = spawn(`${resolveClaudeBin()} --version`, { shell: true, cwd: CLAUDE_CWD });
    let out = '';
    let err = '';
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      claudeCheck = { ...res, ts: Date.now() };
      resolve(claudeCheck);
    };
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* 무시 */ }
      finish({ ok: false, message: 'claude 응답이 없습니다(15초 초과). 터미널에서 `claude --version`을 직접 실행해 확인하세요.' });
    }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => {
      finish({ ok: false, message: 'claude 명령을 실행할 수 없습니다. Claude Code가 설치돼 있고 PATH에 있는지 확인하세요.' });
    });
    child.on('close', (code) => {
      if (code === 0 && /\d+\.\d+/.test(out)) {
        finish({ ok: true, message: out.trim() });
      } else {
        finish({
          ok: false,
          message:
            'claude를 찾지 못했거나 실행에 실패했습니다(종료코드 ' + code + '). ' +
            `Claude Code 설치 후 서버를 새 터미널에서 다시 켜세요. (시도한 실행 경로: ${resolveClaudeBin()})` +
            (err.trim() ? ` [${err.trim().slice(0, 200)}]` : ''),
        });
      }
    });
  });
}

// 실패 원인을 사람이 읽을 수 있는 한 줄로 추정한다.
// (화면에서 말풍선을 클릭하면 이 진단이 그대로 보인다)
function diagnose({ stdout, stderr, code, timedOut }) {
  const err = String(stderr || '');
  const out = String(stdout || '');
  const all = err + '\n' + out;
  if (timedOut) {
    return 'claude 응답이 180초를 넘겨 중단됐습니다. 네트워크가 느리거나 모델이 과부하일 수 있습니다.';
  }
  if (/not recognized|command not found|ENOENT|찾을 수 없습니다/i.test(all)) {
    return 'claude 명령을 찾지 못했습니다. Claude Code를 설치했는지, 설치 후 서버를 새 터미널에서 다시 켰는지 확인하세요.';
  }
  if (/login|log in|authenticat|Unauthorized|401|credit balance|api key/i.test(all)) {
    return 'claude 인증 문제로 보입니다. 터미널에서 `claude` 실행 후 로그인 상태(/status)를 확인하세요.';
  }
  if (/trust|신뢰|permission|권한/i.test(all)) {
    return '폴더 신뢰·권한 승인 단계에서 막힌 것으로 보입니다. 해당 폴더에서 `claude`를 한 번 직접 실행해 신뢰를 승인하세요.';
  }
  if (/rate limit|usage limit|quota|한도/i.test(all)) {
    return '사용량 한도에 걸린 것으로 보입니다. 잠시 후 다시 시도하거나 /model 로 가벼운 모델을 선택하세요.';
  }
  if (!out.trim()) {
    return `claude가 아무 응답도 내지 않았습니다(종료코드 ${code == null ? '없음' : code}). 터미널에서 \`echo hi | claude -p\` 로 직접 확인해 보세요.`;
  }
  return 'claude는 응답했지만 JSON 형식이 아니었습니다. 아래 원문을 확인하세요.';
}

async function runAgentReal(id, prompt) {
  let last = { stdout: '', stderr: '', code: null, timedOut: false };
  const model = modelFor(id);
  // 최초 시도 + 실패 시 1회 재시도 = 최대 2회
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await spawnClaude(prompt, model);
    last = res;
    if (res.stderr && res.stderr.trim()) {
      console.error(`[agent:${id}] stderr: ${res.stderr.trim()}`);
    }
    const parsed = extractJson(res.stdout || '');
    if (parsed) return normalizeResult(parsed);
    console.error(
      `[agent:${id}] 파싱 실패 (시도 ${attempt + 1}/2, 종료코드 ${res.code}, stdout ${String(res.stdout || '').length}자)`
    );
  }
  // 화면·리포트에서 바로 원인을 볼 수 있도록 진단 + 원문을 함께 남긴다
  const hint = diagnose(last);
  const detail = [
    `원인 추정: ${hint}`,
    '',
    `종료코드: ${last.code == null ? '(없음)' : last.code}${last.timedOut ? ' · 타임아웃' : ''}`,
    `stderr: ${String(last.stderr || '(없음)').trim().slice(0, 600)}`,
    `stdout: ${String(last.stdout || '(없음)').trim().slice(0, 600)}`,
  ].join('\n');
  return { bubble: '분석 실패 — 말풍선을 클릭해 원인을 확인하세요', report: detail };
}

// ---------------------------------------------------------------------------
// mock 응답 (데모용 고정 한국어 문구, 심볼 치환)
//
// 데모라도 진입·손절·목표에 숫자가 없으면 리스크 게이트가 손익비를 계산하지 못해
// 화면 절반이 "데이터 없음"으로 비어버린다. 그래서 레벨은 실제로 수집된 현재가에서
// ±%로 만든다(데모 모드에서도 market 수집은 진짜로 돈다).
// 가격을 못 구하면 null을 돌려주고 기존 서술형 문구를 그대로 쓴다 — 숫자를 지어내지 않는다.
// ---------------------------------------------------------------------------

// 사람이 읽는 가격 표기: 1000 이상은 정수+콤마, 작을수록 소수 자리를 늘린다.
function fmtNum(v) {
  if (!Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  const [int, frac] = v.toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

// 기준가. preferPerp면 실제 체결이 일어나는 USDT 무기한을 먼저 본다.
function mockRefPrice(market, preferPerp) {
  const m = market || {};
  if (preferPerp) {
    const p = m.perp && m.perp.indicators ? m.perp.indicators.price : null;
    if (Number.isFinite(p)) return p;
  }
  const i = m.indicators || {};
  if (Number.isFinite(i.price)) return i.price;
  const c = Array.isArray(m.candles) && m.candles.length ? m.candles[m.candles.length - 1] : null;
  if (c && Number.isFinite(c.c)) return c.c;
  return null;
}

// 스윙(정규장) 레벨 — 손절 -2.5%, 목표 +5.0% → 손익비 2.0
function mockSwingLevels(market) {
  const p = mockRefPrice(market, false);
  if (!Number.isFinite(p) || p <= 0) return null;
  return {
    price: p,
    entry: fmtNum(p),
    stop: fmtNum(p * 0.975),
    tightStop: fmtNum(p * 0.982), // PM이 손절을 한 단계 앞당긴 자리 (손익비 2.78)
    target: fmtNum(p * 1.05),
  };
}

// 스캘핑(레버리지 계약) 레벨 — 손절 -1.2%, 목표 +2.4% → 손익비 2.0
// 20배 격리 청산 버퍼(약 -5%)보다 손절이 훨씬 안쪽이라 stopBeyondLiq가 나지 않는다.
function mockScalpLevels(market) {
  const p = mockRefPrice(market, true);
  if (!Number.isFinite(p) || p <= 0) return null;
  return {
    price: p,
    entry: fmtNum(p),
    stop: fmtNum(p * 0.988),
    tightStop: fmtNum(p * 0.991), // GUARD가 손절을 앞당긴 자리 (손익비 2.67)
    target: fmtNum(p * 1.024),
  };
}

function mockResult(id, context = {}) {
  const market = (context && context.market) || {};
  const sym = market.display || market.symbol || '심볼';
  const SW = mockSwingLevels(market);
  const SC = mockScalpLevels(market);
  const table = {
    taro: {
      bubble: `${sym} 20일선에서 지지 시험 중입니다. RSI는 중립, MACD는 축소 국면 — 거래량 붙는 쪽으로 방향이 갈립니다.`,
      report: `${sym}의 단기 추세는 20일 이동평균선 부근에서 지지받는 형태입니다. 종가가 20일선 위를 지키는 동안은 눌림목 구조로 읽히고, 50일선까지의 이격이 크지 않아 중기 추세도 훼손되지 않았습니다. RSI는 중립 구간이라 과매수·과매도 어느 쪽으로도 치우치지 않았고, MACD 히스토그램은 음전환 폭이 줄어드는 축소 국면입니다. 이는 하락 모멘텀이 약해지고는 있으나 아직 상방으로 전환됐다고 확정할 단계는 아니라는 뜻입니다. 최근 20일 고점이 1차 저항, 20일 저점이 1차 지지로 작동하고 있습니다. 반대 시나리오로는 거래량 없는 반등에 그쳐 20일선을 다시 하회하는 경우이며, 그때는 저점 재확인까지 열어둬야 합니다. 판단이 바뀌는 트리거는 명확합니다 — 거래량을 동반한 20일선 상향 회복이면 상방, 20일 저점 종가 이탈이면 하방으로 재설정합니다. 그 전까지는 방향을 확정하지 않고 레벨만 지켜보는 것이 합리적입니다.`,
    },
    diana: {
      bubble: `${sym} 밸류에이션 부담은 제한적입니다. 다만 내재가치 산정이 어려운 자산이라 싸다는 게 하방 보증은 아닙니다.`,
      report: `${sym}의 기본 체력은 양호한 편입니다. 시가총액 대비 거래대금 회전율이 건전한 수준이라 유동성 측면의 문제는 보이지 않습니다. 52주 고점 대비 조정폭을 감안하면 밸류에이션 부담은 과도하지 않은 구간으로 판단됩니다. 다만 이 자산군은 현금흐름 기반 내재가치 산정이 어려워, 밸류에이션 논거만으로 방향을 정하는 것은 위험합니다. 즉 "싸다"는 판단은 하방이 없다는 보증이 아니라 기대수익이 개선됐다는 뜻일 뿐입니다. 반대 시나리오는 거시 긴축이나 업종 수요 둔화가 확인되며 실적 전망 자체가 하향되는 경우이고, 그때는 현재 가격도 비싸질 수 있습니다. 판단이 바뀌는 트리거는 실적·수요 지표의 방향 전환과 자금 유출입 흐름입니다. 결론적으로 펀더멘털은 중립~우호적이나 단기 방향은 수급과 매크로가 좌우한다고 봅니다.`,
    },
    flow: {
      bubble: `${sym} 시총 3% 처분에 37영업일입니다. 규칙을 바꿔도 실현단가 차이는 100bp 안쪽 — 시작일 운에 묻힙니다.`,
      report: `${sym}의 실행 가능성만 봅니다. 시가총액 3% 물량을 정규장에서 소화하는 데 평균 거래량 기준 37영업일, 중앙값 기준 42영업일이 걸립니다. 둘이 갈리면 중앙값을 믿어야 합니다 — 최근 60일 거래대금의 36%가 상위 5일에 몰려 있어 평균은 몇 번의 폭발일에 끌려 올라간 값이기 때문입니다. 즉 '보통 날'의 소화력은 평균이 시사하는 것보다 낮습니다. 매도 규칙 4종을 과거 구간마다 돌린 결과 실현단가가 가장 나았던 규칙과 가장 나빴던 규칙의 중앙값 차이는 약 100bp인데, 같은 규칙 안에서 시작일에 따른 사분위 폭이 2,000bp를 넘습니다. 규칙 선택보다 시작 시점이 결과를 훨씬 크게 좌우한다는 뜻이고, 따라서 '어느 규칙이 우월하다'는 결론은 이 표본에서 지지되지 않습니다. 체결률은 모든 규칙에서 1에 가까워 물량 자체는 소화됩니다. 매물대상 손바뀜이 가장 많았던 구간이 현재가 위쪽에 있어, 반등 시 그 부근에서 대기 물량이 나올 가능성을 열어둬야 합니다. 방향 판정은 제 일이 아닙니다.`,
    },
    filing: {
      bubble: `${sym} 자본구조는 미조회 상태입니다 — 희석 규모를 모르는 채로 판단하고 있다는 뜻입니다.`,
      report: `${sym}의 주식수와 물량 쪽을 봅니다. 먼저 한계부터 밝힙니다 — 이번 런에서 자본구조(미상환 전환사채·최대주주 지분·발행주식총수)가 조회되지 않았습니다. DART 조회를 켜지 않았기 때문이며, 이는 '희석이 없다'가 아니라 '희석 규모를 모른다'는 뜻입니다. 없는 것과 안 본 것은 다르므로 이 상태에서 단가를 논하는 것은 근거가 약합니다. 확인된 범위에서 말하면, 보호예수 관련 관측값이 제시되지 않아 상장 후 확약 물량의 해제 시점을 특정할 수 없습니다. 공시 이벤트도 비어 있어 희석·위험 공시의 유무를 판단할 수 없습니다. 회수 계획에 대한 제 결론은 조건부입니다 — 미상환 사채가 시가총액의 5%를 넘는다면 전환 물량이 우리 처분과 같은 창구로 겹치므로 처분 기간을 늘려 잡아야 하고, 최대주주 지분이 크다면 그쪽 물량이 먼저 나올 때 우리 실현단가가 눌립니다. 두 숫자를 확인하기 전에는 처분 일정을 확정하지 말 것을 권합니다.`,
    },
    red: {
      bubble: `${sym} 처분 소요일수가 참여율 10% 가정 위에 서 있습니다. 이 종목엔 그게 낙관적입니다 — 가정을 5%로 낮추면 계획이 뒤집힙니다.`,
      report: `계획의 좋고 나쁨은 다른 심사자들이 다퉜으므로, 저는 그 계획이 딛고 선 숫자가 성립하는지만 봅니다. 첫째, 처분 소요일수는 '해당 기준 거래량의 10%만 장내에서 소화한다'는 가정 위에 서 있습니다. 그런데 같은 원장이 최근 60일 거래대금의 36%가 상위 5일에 몰려 있다고 말합니다. 거래가 몰리는 날에 우리도 팔면 참여율 10%는 지킬 수 있지만, 그렇지 않은 '보통 날'에는 10%가 곧 호가를 밀어내는 수준입니다. 참여율을 5%로 낮추면 소요일수는 두 배가 되고, 그 순간 '20영업일 안에 처분' 전제가 무너집니다. 이 가정 하나가 계획 전체를 지탱하고 있습니다. 둘째, 보호예수는 상장일에 6개월을 더한 일괄 추정입니다. 실제 확약은 종목마다 다르고 증권신고서로만 확인됩니다 — 계획이 특정 해제 시점을 전제한다면 그 전제는 아직 검증되지 않았습니다. 셋째, 자본구조가 미조회 상태입니다. 미상환 전환사채 규모를 모르는 채로 실현단가를 논하고 있는데, 이는 '희석이 없다'가 아니라 '모른다'입니다. 계획은 암묵적으로 희석을 0으로 놓고 있습니다. 넷째, 가격충격은 제곱근 모형 가정이고 계수는 문헌값입니다. 실제 호가 두께가 얇으면 실현단가는 시뮬레이션보다 나빠집니다. 결론적으로 이 판정은 참여율 가정에 가장 취약합니다. 참여율을 절반으로만 낮춰도 처분 기간 전제가 깨지므로, 계획을 확정하기 전에 이 종목의 실제 체결 가능 참여율을 호가 데이터로 확인할 것을 요구합니다.`,
    },
    nova: {
      bubble: `${sym} 뉴스는 호악재 혼조입니다. 좋은 지표에도 주가가 안 따라오는 게 핵심 — 기대가 선반영됐다는 신호입니다.`,
      report: `${sym}를 둘러싼 최근 뉴스 흐름은 호재와 악재가 뚜렷하게 혼재합니다. 수급 측면의 우호적 재료가 하방을 방어하는 반면, 거시 금리와 규제 관련 헤드라인이 상방을 제한하는 구도입니다. 특징적인 점은 실적이나 지표가 좋게 나와도 주가가 그에 비례해 반응하지 않는다는 것이고, 이는 시장이 이미 기대를 선반영했거나 피크아웃을 경계하고 있다는 신호로 읽힙니다. 헤드라인 민감도가 높아진 국면이라 재료 하나에 일중 변동폭이 크게 벌어질 수 있습니다. 반대 시나리오는 악재가 소멸하면서 눌려 있던 수급이 한 번에 되돌려지는 경우입니다. 판단이 바뀌는 트리거는 금리·정책 이벤트 결과와 기관 자금 흐름의 방향 전환입니다. 이벤트 창 안에서는 포지션을 키우지 않는 것이 안전하다고 봅니다. 재료가 정리된 뒤 첫 방향을 확인하고 따라가는 편이 승률이 높습니다.`,
    },
    vibe: {
      bubble: `${sym} 심리가 한쪽으로 쏠렸습니다. 극단값은 반전 전조지만 타이밍은 주지 않으니 진입 근거는 가격에서 찾아야 합니다.`,
      report: `${sym}에 대한 시장 심리는 한쪽으로 기운 상태입니다. 공포탐욕지수와 헤드라인 톤을 함께 보면 투자자들이 가격 움직임보다 과하게 반응하고 있다는 인상이 강합니다. 심리 지표의 극단값은 반전의 전조가 되기도 하지만, 그 자체로는 타이밍을 주지 않는다는 점이 중요합니다. 즉 과열이라고 곧바로 반대 포지션을 잡는 것은 근거가 약합니다. 지금은 "가격은 버티는데 심리는 위축" 또는 "가격은 오르는데 심리는 과열"처럼 가격과 심리가 어긋나는 국면이며, 이런 구간에서는 변동성이 커지기 쉽습니다. 반대 시나리오는 심리가 극단에서 되돌아오며 가격이 그 방향으로 추세를 이어가는 경우입니다. 판단이 바뀌는 트리거는 심리 지표가 중립 구간으로 회귀하는지, 그리고 그때 가격이 어느 레벨을 지키고 있는지입니다. 심리는 확인 지표로만 쓰고 진입 근거는 가격 레벨에서 찾는 편이 안전합니다.`,
    },
    bull: {
      bubble: `${sym} 눌림목 매수가 유효합니다. 기대수익 대비 리스크가 개선됐고 수급이 하방을 막고 있어 상방 우위로 봅니다.`,
      report: `${sym}는 주요 이동평균선에서 지지를 확인했고, 하방보다 상방 여력이 크다고 봅니다. 첫째, 조정폭이 이미 상당해 기대수익 대비 감수하는 리스크가 개선됐습니다. 둘째, 기관·수급 측면의 우호적 재료가 실시간으로 하방을 방어하고 있어 투매가 연장될 근거가 약합니다. 셋째, 지표상 과매도에 가까운 구간이라 반등 시 매물대가 얇아 상승 속도가 빠를 수 있습니다. 약세론자가 지적하는 과열·모멘텀 훼손은 추세장에서 흔한 되돌림 수준이며, 추세 전환의 증거로 보기엔 아직 부족합니다. 물론 지지선이 종가로 깨지면 제 논거는 무효이고, 그 경우 다음 지지까지 열어둬야 한다는 점은 인정합니다. 그래서 한 번에 전량 진입이 아니라 지지 확인 후 분할 매수로 대응할 것을 제안합니다. 판단 전환 트리거는 지지선 종가 이탈이며, 상방 확인 트리거는 거래량을 동반한 20일선 회복입니다.`,
    },
    bear: {
      bubble: `${sym} 조정폭이 크다는 건 하락 추세의 증거일 뿐입니다. 거래량 없는 지지는 언제든 깨지니 반등은 매도 기회입니다.`,
      report: `강세론의 "싸졌으니 기회"라는 논리를 정면으로 반박합니다. 조정폭이 크다는 사실은 하락 추세가 강하다는 증거이지 바닥의 보증이 아닙니다. 강세론자가 근거로 든 지지선은 거래량 뒷받침이 없으면 언제든 무너지며, 실제로 최근 거래량은 반등 에너지라기보다 방향성 부재에 가깝습니다. 지표상으로도 가격이 단기 이동평균 아래에 머물고 모멘텀 지표가 음의 영역에 있어, 추세는 여전히 아래를 향합니다. 수급 호재라는 재료도 매크로 역풍에 상쇄되는 구도이며, 큰손이 관망으로 돌아선 자리를 소규모 매수가 메운다고 보기엔 규모 차이가 큽니다. 얇은 거래량 장세는 상방만큼 하방으로도 쉽게 미끄러진다는 점이 핵심입니다. 제 논거가 무효가 되는 조건은 분명합니다 — 거래량을 실은 저항 돌파가 나오면 하락 추세는 끝난 것으로 인정합니다. 그 전까지 반등은 차익 실현과 분할 매도의 기회로 봅니다.`,
    },
    blitz: {
      bubble: `${sym} 15분봉 눌림 후 반등 시도입니다. 직전 스윙 고점 돌파를 트리거로 잡고, 저점 이탈이면 논리가 죽습니다.`,
      report: `${sym} 15분봉은 단기 지지 부근에서 눌림 후 반등을 시도하는 형태입니다. 당일 레인지의 중간 아래에 머물러 있어 아직 매수 우위로 확정된 구간은 아닙니다. 방향 편향은 중립에서 소폭 롱 우위로 보고, 직전 스윙 고점의 상향 돌파를 진입 트리거로 잡습니다. 추격 진입은 금지입니다 — 트리거 없이 들어가면 눌림이 한 번 더 나올 때 손절만 맞습니다. 1차 청산 목표는 상단 저항 부근이고, 그 자리에서 절반은 익절해 리스크를 줄이는 것을 원칙으로 합니다. 무효화 레벨은 직전 스윙 저점 이탈이며, 이 레벨이 깨지면 반등 논리가 죽은 것이므로 즉시 전량 정리합니다. 반대 시나리오는 거래량 없이 저항에서 밀려 저점을 다시 시험하는 경우이고, 그때는 방향을 숏으로 재설정해야 합니다. 15분봉 ATR 대비 손절폭이 너무 좁으면 노이즈에 털리므로 ATR 한 배 이상은 확보하십시오. 결론적으로 트리거 확인 후 진입, 미확인 시 관망이 원칙입니다.${
        SC
          ? ` 숫자로 못박으면 진입 트리거 ${SC.entry} 상향 돌파, 무효화 ${SC.stop} 이탈, 1차 목표 ${SC.target}입니다.`
          : ''
      }`,
    },
    guard: {
      bubble: `${sym} 20배 청산 버퍼가 -5%뿐입니다. 무효화 레벨이 그 안쪽이면 손절을 앞당기고 비중을 줄여야 합니다.`,
      report: `${sym}를 20배 격리로 잡으면 청산까지 역행 여유는 약 -4.7~-5.0%에 불과합니다. 이 숫자가 모든 판단의 출발점입니다. 블리츠가 제시한 무효화 레벨이 이 청산 버퍼 안쪽에 있다면 손절이 작동하기 전에 강제 청산될 수 있으므로, 손절을 버퍼보다 한 단계 앞당기고 반드시 지정가로 걸어두어야 합니다. 15분봉 ATR이 청산 버퍼의 절반을 넘는 종목이라면 한 번의 변동성 스파이크에 손절과 청산이 동시에 노출됩니다. 그 경우 선택지는 두 개뿐입니다 — 레버리지를 낮춰 버퍼를 넓히거나, 비중을 줄여 손실 금액을 통제하는 것입니다. 계좌 대비 리스크 2% 룰을 적용하면 손절폭이 클수록 명목 비중은 작아져야 하며, 20배 풀 사이징은 어떤 경우에도 금지입니다. 진입 금지 조건도 분명히 둡니다 — 주요 뉴스·정책 이벤트 직전, 스프레드가 평소보다 벌어진 구간, 거래량이 말라붙은 저유동성 시간대에는 진입하지 않습니다. 기초자산 정규장 개장 직후 갭이 발생하는 구간도 회피 대상입니다. 반대로 이 조건들이 모두 정리되고 트리거가 확인되면, 축소된 비중으로 실행하는 것에는 동의합니다.${
        SC
          ? ` 구체적으로는 손절을 ${SC.stop}에서 ${SC.tightStop}로 앞당기고, 목표는 ${SC.target}를 유지하라는 뜻입니다.`
          : ''
      }`,
    },
    risky: {
      bubble: `${sym} 기회비용도 리스크다. 손절만 지키면 비중을 더 실을 근거는 충분하다고 본다.`,
      report: `트레이더 계획을 공격적 관점에서 심사합니다. 결론부터 말하면 이 계획은 지나치게 방어적입니다. 조정폭이 이미 상당해 기대수익 대비 리스크 비율이 개선된 구간인데, 관망으로 시간을 보내는 것 자체가 기회비용입니다. 진입 트리거를 지지 확인 이후로 늦추면 반등의 초입을 놓치고 결국 더 높은 가격에 따라 들어가게 됩니다. 무효화 레벨이 명확하게 정의돼 있다는 점이 중요합니다 — 손실 한도가 계산 가능하다면 비중을 키워도 파산 위험은 통제됩니다. 목표도 1차 저항에서 끊기보다 절반만 익절하고 나머지는 추세를 태우는 편이 기대값이 높습니다. 다만 감당 가능한 최대 리스크는 명시해야 합니다. 계좌 대비 손실 상한을 정해두고 그 한도 안에서만 공격적으로 태우십시오. 20배 격리라면 약 -5% 역행에 증거금이 전액 청산되므로, 비중 확대는 반드시 레버리지 하향과 함께 가야 합니다. 이 경고를 지키는 전제에서 저는 계획보다 적극적인 실행을 지지합니다.`,
    },
    safe: {
      bubble: `${sym} 최악의 시나리오 손실이 계산 안 된 계획이다. 비중 축소가 먼저다.`,
      report: `보수적 관점에서 이 계획의 취약점을 짚습니다. 가장 큰 문제는 최악의 시나리오가 정량화되지 않았다는 점입니다. 무효화 레벨은 정해져 있지만, 갭이나 급락으로 그 레벨을 건너뛰고 체결될 가능성은 계산에 들어가 있지 않습니다. 공격적 심사자는 "손절이 있으니 비중을 키워도 된다"고 하지만, 손절은 유동성이 있을 때만 손절로 기능합니다. 얇은 거래량 국면에서는 슬리피지가 손실을 손절폭보다 키웁니다. 방향성 근거 자체도 확정적이지 않습니다 — 모멘텀 지표는 아직 아래를 향하고, 심리는 극단이지만 그것이 반전 타이밍을 주지는 않습니다. 따라서 저는 비중 축소, 손절 상향, 그리고 이벤트 창 회피를 요구합니다. 20배 격리는 약 -5% 역행에 전액 청산이며 15분봉 변동성이 그 절반에 가깝다면 한 번의 스파이크로 끝날 수 있습니다. 진입을 아예 보류하고 방향이 확인된 뒤 따라가는 편이 자본 보존에 유리합니다. 최소한 명목 비중을 절반으로 줄이지 않는다면 이 계획에 동의할 수 없습니다.`,
    },
    neutral: {
      bubble: `${sym} 양쪽 다 일부만 맞다. 조건부 승인 — 트리거 확인 후 절반 비중이 답이다.`,
      report: `두 심사자의 주장을 나눠 평가하겠습니다. 공격적 심사자의 "기회비용도 리스크"라는 지적은 타당합니다. 무효화 레벨이 명확하면 손실이 통제 가능하다는 논리도 원칙적으로 맞습니다. 다만 "손절이 있으니 비중을 키워도 된다"는 결론은 과장입니다 — 손절은 유동성 전제 아래에서만 작동하고, 보수적 심사자가 지적한 갭·슬리피지 위험은 실제로 계산에 빠져 있었습니다. 반대로 보수적 심사자의 "진입 보류" 요구도 과도합니다. 트리거가 정의된 계획을 근거 없이 보류하면 어떤 셋업도 실행할 수 없게 됩니다. 절충안은 이렇습니다 — 진입은 하되 트리거 확인 전에는 들어가지 않고, 확인되면 계획 비중의 절반으로 시작해 추가는 목표 절반 달성 이후로 미룹니다. 손절은 무효화 레벨보다 한 단계 앞당기고, 레버리지는 20배 대신 낮춰 청산 여유를 손절폭의 두 배 이상으로 확보합니다. 이벤트 창(정책·실적 발표) 안에서는 신규 진입을 금지합니다. 이 조건들이 지켜지면 조건부 승인, 하나라도 어기면 기각이 제 의견입니다.`,
    },
    pm: {
      bubble: `${sym} 수정 승인. 방향은 유지하되 비중과 손절을 조여서 통과시킨다.`,
      report: `포트폴리오 매니저로서 트레이더 계획과 리스크 위원회 의견을 종합해 최종 판정합니다. 판정은 수정 승인(AMEND)입니다. 방향과 논거 자체는 데이터에 부합하므로 기각할 이유가 없습니다. 다만 원안대로 실행하기에는 보수적 심사자가 지적한 두 가지 구멍이 실재합니다 — 갭 위험이 손절 가정에 반영되지 않았고, 진입 시점이 트리거 확인 전이었습니다. 그래서 세 가지를 수정했습니다. 첫째, 진입은 트리거가 확인된 이후로만 허용합니다. 둘째, 손절을 무효화 레벨보다 한 단계 앞당겨 슬리피지 여유를 확보합니다. 셋째, 명목 비중을 원안의 절반으로 낮추고 추가 진입은 1차 목표 절반 달성 이후로 미룹니다. 목표는 원안을 유지하되 절반 익절 원칙을 명시합니다. 공격적 심사자의 추세 확장 주장은 절반 익절 후 잔여 물량으로 충족되므로 별도 반영하지 않았습니다. 20배 레버리지 구간이라면 레버리지 하향을 조건으로 붙입니다 — 약 -5% 역행에 전액 청산되는 구조에서 원안 비중은 감당 범위를 넘습니다. 이 조건들이 지켜지는 한 실행을 승인합니다.`,
      verdict: 'AMEND',
      action: 'HOLD',
      confidence: 58,
      entry: SW
        ? `${SW.entry} 트리거 확인 후에만 진입 (확인 전 진입 금지)`
        : `${sym} 트리거 확인 후에만 진입 (확인 전 진입 금지)`,
      stop: SW
        ? `${SW.tightStop} 이탈 시 손절 (무효화 레벨보다 한 단계 앞당김)`
        : '무효화 레벨보다 한 단계 앞당긴 지점',
      target: SW
        ? `${SW.target} 유지, 절반 도달 시 분할 익절`
        : '원안 목표 유지, 절반 도달 시 분할 익절',
      sizing: '계좌 리스크 2% 룰 기준 명목 비중의 절반, 20배 시 레버리지 하향 조건',
      rationale: `방향 논거는 타당해 기각하지 않았으나, 갭 위험 미반영과 트리거 이전 진입이라는 두 결함을 수정했습니다. 진입 조건 강화·손절 상향·비중 절반을 조건으로 수정 승인합니다.`,
    },
    ace: {
      bubble: `${sym} 논거가 팽팽해 관망이 우위입니다. 20일선 회복이나 저점 이탈 중 하나가 확인되면 그 방향으로 대응합니다.`,
      report: `${sym}에 대한 애널리스트 네 명의 분석과 강약 토론을 종합하면 논거가 팽팽합니다. 기술적으로는 20일선 부근의 지지 시험 국면이고 모멘텀 지표는 하락 압력이 줄어드는 축소 단계입니다. 펀더멘털은 중립~우호적이지만 이 자산군은 내재가치로 방향을 정하기 어렵다는 한계가 있습니다. 뉴스는 수급 호재와 매크로 역풍이 상쇄되는 구도이고, 심리는 극단으로 기울어 변동성이 커지기 쉬운 상태입니다. 강세론의 "기대수익 대비 리스크가 개선됐다"는 지적과 약세론의 "거래량 없는 반등은 취약하다"는 지적이 모두 데이터에 부합합니다. 어느 쪽도 우위를 증명하지 못했으므로 지금 신규 베팅은 불리한 리스크·리워드입니다. 반대 시나리오는 거래량을 실은 저항 돌파가 나오며 추세가 전환되는 경우이고, 그때는 즉시 상방으로 재설정합니다. 판단이 바뀌는 트리거는 두 개뿐입니다 — 거래량 동반 20일선 회복이면 매수, 20일 저점 종가 이탈이면 매도로 전환합니다. 그 전까지는 관망하며 레벨만 지켜보는 것이 합리적입니다.`,
      action: 'HOLD',
      confidence: 62,
      entry: SW
        ? `${SW.entry} 상향 돌파 확인 시 분할 진입 (20일선 회복 기준)`
        : `${sym} 20일선 상향 돌파 확인 시 분할 진입`,
      stop: SW ? `${SW.stop} 이탈 시 손절 (최근 20일 저점)` : '최근 20일 저점 이탈 시 손절',
      target: SW ? `${SW.target} 1차 목표 (직전 고점 부근)` : '직전 고점 부근을 1차 목표로 설정',
      rationale: `강세와 약세 논거가 균형을 이뤄 우위가 뚜렷하지 않고, 심리 과열이 부담으로 작용하므로 방향이 확인되기 전까지는 관망이 합리적입니다.`,
      scalp: {
        bias: 'PASS',
        entry: SC ? `${SC.entry} 돌파 확인 전에는 진입 금지` : '-',
        stop: SC ? `${SC.stop} 이탈` : '-',
        target: SC ? `${SC.target} 1차 청산` : '-',
        note: '변동성 확인 전 관망 — 트리거 미충족',
      },
    },
  };

  // 공격 모드 데모: 관망 문구를 쓰면 모드 자체가 무의미하므로 방향형으로 갈아끼운다.
  if (context.mode === 'attack') {
    const attackTable = {
      blitz: {
        bubble: `${sym} 눌림 끝, 돌파 방향으로 롱 잡는다`,
        report: `${sym} 15분봉은 단기 지지에서 눌림을 끝내고 반등 초입입니다. 방향 편향은 롱으로 확정하고, 직전 스윙 고점 돌파를 진입 트리거로 잡습니다. 1차 청산 목표는 상단 저항 부근이며, 무효화 레벨은 직전 스윙 저점 이탈입니다. 이 레벨이 깨지면 논리가 죽은 것이므로 즉시 전량 정리합니다.${
          SC
            ? ` 숫자로는 진입 ${SC.entry}, 무효화 ${SC.stop}, 1차 목표 ${SC.target}입니다.`
            : ''
        }`,
      },
      guard: {
        bubble: `${sym} 롱 살리려면 비중 반, 손절 앞당겨라`,
        report: `${sym}를 20배 격리로 잡으면 청산까지 역행 여유는 약 -4.7~-5.0%뿐입니다. BLITZ의 무효화 레벨이 이 버퍼에 근접하면 손절을 버퍼보다 앞당기고, 계좌 리스크 2% 룰로 명목 비중을 계산해 그 절반만 태우십시오. 레버리지를 낮추면 같은 손절폭에서 청산 여유가 배로 늘어납니다. 무효화 레벨 이탈, 급격한 스프레드 확대, 기초자산 정규장 개장 갭 구간에서는 즉시 정리합니다.${
          SC ? ` 손절은 ${SC.stop} 대신 ${SC.tightStop}로 앞당기는 것을 권고합니다.` : ''
        }`,
      },
      ace: {
        bubble: `${sym} 롱, 확신도 낮지만 방향은 위`,
        report: `${sym}에 대한 분석을 종합하면 논거가 팽팽하지만 단기 우위는 근소하게 상방입니다. 공격 모드이므로 관망 없이 방향을 확정하되, 우위가 미약한 만큼 확신도를 낮게 둡니다. 무효화 레벨을 넘기면 즉시 반대로 뒤집는다는 전제 아래의 판정입니다.`,
        action: 'BUY',
        confidence: 54,
        entry: SW
          ? `${SW.entry} 돌파 시 진입 (직전 스윙 고점)`
          : `${sym} 직전 스윙 고점 돌파 시 진입`,
        stop: SW ? `${SW.stop} 이탈 시 손절 (직전 스윙 저점)` : '직전 스윙 저점 이탈 시 손절',
        target: SW ? `${SW.target} 1차 목표 (상단 저항 부근)` : '상단 저항 부근을 1차 목표로 설정',
        rationale: `강세와 약세 논거가 균형에 가깝지만 단기 모멘텀이 근소하게 상방이라 롱을 택했습니다. 우위가 얇으므로 확신도는 낮게 두고, 무효화 레벨 이탈 시 즉시 청산을 전제로 합니다.`,
        scalp: {
          bias: 'LONG',
          entry: SC ? `${SC.entry} 돌파 확인 후 진입` : '직전 스윙 고점 돌파 확인 후 진입',
          stop: SC ? `${SC.stop} 이탈` : '직전 스윙 저점 이탈',
          target: SC ? `${SC.target} 1차 청산` : '상단 저항 부근 1차 청산',
          note: '20배 격리는 -5% 역행이면 증거금 전액 청산 — 손절 필수, 풀사이징 금지',
        },
      },
    };
    if (attackTable[id]) return { ...attackTable[id] };
  }

  if (!table[id]) {
    // 목업이 없는 역할이면 빈 응답 대신 그 사실을 말한다.
    // (조용히 빈 문자열이 나가면 리포트에 근거 없는 공백이 남는다)
    const meta = AGENT_BY_ID[id];
    const label = meta ? `${meta.name}(${meta.role})` : id;
    return {
      bubble: `${label} 데모 응답이 준비돼 있지 않습니다.`,
      report: `이 역할의 데모(목업) 응답이 정의돼 있지 않습니다. 실전 모드에서는 정상 동작합니다.`,
    };
  }
  return { ...table[id] };
}

// ---------------------------------------------------------------------------
// runAgent(id, context, {mock})
// ---------------------------------------------------------------------------
async function runAgent(id, context = {}, opts = {}) {
  const { mock = false } = opts || {};
  const meta = AGENT_BY_ID[id];
  if (!meta) throw new Error(`알 수 없는 에이전트 id: ${id}`);

  if (mock) {
    const delay = 300 + Math.floor(Math.random() * 500); // 300~800ms
    await new Promise((r) => setTimeout(r, delay));
    return mockResult(id, context);
  }

  const prompt = buildPrompt(id, context);
  return runAgentReal(id, prompt);
}

module.exports = { AGENTS, extractJson, runAgent, buildPrompt, checkClaudeAvailable,
                   resolveClaudeBin, modelFor };
