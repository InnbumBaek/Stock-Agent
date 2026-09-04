'use strict';

// riskmath.js — 손익비·포지션 사이징·청산가 계산 (리스크 게이트의 수학부)
//
// 계약: module.exports = { parsePrice, computeRR, positionSize, liquidationPrice, evaluatePlan }
//
// 원칙
// - 외부 의존성 0. Node 내장만.
// - 데이터에 없는 수치를 만들지 않는다. 계산 불가는 전부 null.
// - 반환되는 사유 문자열은 전부 한국어다. 화면·리포트에 그대로 나간다.
// - 이 모듈은 모드(algo/scalp/attack)를 모른다. attack 모드에서 강등을 건너뛰는 판단은
//   engine.js의 몫이다(계약서 "판정 파이프라인 변경" 2번).

const { DEFAULTS } = require('./config.js');

// --- 숫자 유틸 -----------------------------------------------------------

// 부동소수 찌꺼기 제거. 95500.00000000001 → 95500, 소액 코인 가격도 유효숫자 12자리까지 보존.
function clean(n) {
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 0;
  return Number(n.toPrecision(12));
}

function round(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return clean(Math.round(n * f) / f);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 양수만 통과시키는 숫자 변환 (문자열도 허용)
function positiveNumber(v) {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '').trim()) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 화면용 숫자 포맷 (indicators.js와 같은 감각)
function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '데이터 없음';
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString('en-US');
  if (abs >= 1) return Number(n.toFixed(2)).toLocaleString('en-US');
  if (abs >= 0.01) return n.toFixed(4);
  return String(Number(n.toPrecision(4)));
}

// --- parsePrice ----------------------------------------------------------

// 숫자 바로 뒤에 붙으면 "가격이 아님"으로 보는 단위들.
// '원'·'달러'는 통화이므로 절대 넣지 않는다. 공백이 끼면 단위로 보지 않는다("64,500 시장가" → 가격).
const UNIT_AFTER_RE = /^(시간|분|초|시|일|주일|주|개월|월|년|배|봉|틱|회|차|턴|명|[xX]\b)/;
// 퍼센트는 가격이 아니다. 공백 한 칸까지는 허용("1.5 %").
const PERCENT_AFTER_RE = /^(\s?[%％]|퍼센트|퍼)/;
// 콤마·소수점을 포함한 숫자 덩어리
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

// 문자열에서 첫 번째 "유효 가격"을 뽑는다. 없으면 null.
//   '1,341,000원'          → 1341000
//   '$1,111.5'             → 1111.5
//   '약 64,500 부근 돌파 시' → 64500
//   'SMA20(64,515) 상향 돌파' → 64515  (SMA20의 20은 지표 이름의 일부라 건너뜀)
//   '+2.35% 상승'          → null      (퍼센트만 있으면 가격이 아님)
function parsePrice(text) {
  if (typeof text === 'number') {
    return Number.isFinite(text) && text > 0 ? clean(text) : null;
  }
  if (typeof text !== 'string' || !text) return null;

  const re = new RegExp(NUMBER_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const before = start > 0 ? text[start - 1] : '';
    // SMA20·RSI14·H4처럼 영문자에 붙은 숫자는 지표/타임프레임 이름이지 가격이 아니다.
    if (/[A-Za-z]/.test(before)) continue;

    const raw = m[0].replace(/,+$/, ''); // 후행 콤마("64,500, ...")는 값에서 제외
    const rest = text.slice(start + raw.length);
    if (PERCENT_AFTER_RE.test(rest)) continue;
    if (UNIT_AFTER_RE.test(rest)) continue; // 20배·15분·3일 …

    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return clean(n);
  }
  return null;
}

// --- 방향 정규화 ---------------------------------------------------------

// 'LONG'|'SHORT'로 정규화. 판정 액션(BUY/SELL)과 한국어도 받아준다. 모르면 null.
function normalizeSide(side) {
  if (typeof side !== 'string') return null;
  const s = side.trim().toUpperCase();
  if (!s) return null;
  if (['LONG', 'BUY', 'L', '롱', '매수'].includes(s)) return 'LONG';
  if (['SHORT', 'SELL', 'S', '숏', '매도', '공매도'].includes(s)) return 'SHORT';
  return null;
}

// --- computeRR -----------------------------------------------------------

// 손익비 계산. 방향이 논리적으로 어긋나면 valid:false + 한국어 reason.
// 성공 시 reason은 null이다(호출부에서 `if (reason)`으로 문제 유무를 판별할 수 있게).
function computeRR({ entry, stop, target, side } = {}) {
  const fail = (reason) => ({ rr: null, riskPct: null, rewardPct: null, valid: false, reason });

  const e = parsePrice(entry);
  const s = parsePrice(stop);
  const t = parsePrice(target);
  const dir = normalizeSide(side);

  const missing = [];
  if (e == null) missing.push('진입가');
  if (s == null) missing.push('손절가');
  if (t == null) missing.push('목표가');
  if (missing.length) return fail(`${missing.join('·')}를 숫자로 해석하지 못했습니다`);
  if (!dir) return fail('포지션 방향(LONG/SHORT)을 확인할 수 없습니다');

  let risk;
  let reward;
  if (dir === 'LONG') {
    if (s >= e) return fail(`롱인데 손절가(${fmt(s)})가 진입가(${fmt(e)})보다 높거나 같습니다`);
    if (t <= e) return fail(`롱인데 목표가(${fmt(t)})가 진입가(${fmt(e)})보다 낮거나 같습니다`);
    risk = e - s;
    reward = t - e;
  } else {
    if (s <= e) return fail(`숏인데 손절가(${fmt(s)})가 진입가(${fmt(e)})보다 낮거나 같습니다`);
    if (t >= e) return fail(`숏인데 목표가(${fmt(t)})가 진입가(${fmt(e)})보다 높거나 같습니다`);
    risk = s - e;
    reward = e - t;
  }

  if (!(risk > 0)) return fail('손절가와 진입가가 같아 위험 거리가 0입니다');

  return {
    rr: round(reward / risk, 2),
    riskPct: round((risk / e) * 100, 3),
    rewardPct: round((reward / e) * 100, 3),
    valid: true,
    reason: null,
  };
}

// --- positionSize --------------------------------------------------------

const EMPTY_SIZING = {
  qty: null,
  notional: null,
  marginRequired: null,
  riskAmount: null,
  notionalPctOfAccount: null,
  marginPctOfAccount: null,
};

// 1회 허용 손실(계좌 대비 %)에서 역산한 수량·명목가·증거금.
// accountSize가 0(미설정)이면 금액은 전부 null이고 계좌 대비 비율만 채운다.
function positionSize({ accountSize, accountRiskPct, entry, stop, leverage } = {}) {
  const e = parsePrice(entry);
  const s = parsePrice(stop);
  const riskPct = positiveNumber(accountRiskPct);
  const lev = positiveNumber(leverage) || 1;

  if (e == null || s == null || riskPct == null) return { ...EMPTY_SIZING };
  const dist = Math.abs(e - s);
  if (!(dist > 0)) return { ...EMPTY_SIZING };

  // 계좌 규모와 무관하게 결정되는 비율: 명목가 = 허용손실% × (진입가 / 손절거리)
  const notionalPctOfAccount = round(riskPct * (e / dist), 2);
  const marginPctOfAccount = round(notionalPctOfAccount / lev, 2);

  const acct = Number(accountSize);
  if (!Number.isFinite(acct) || acct <= 0) {
    return {
      qty: null,
      notional: null,
      marginRequired: null,
      riskAmount: null,
      notionalPctOfAccount,
      marginPctOfAccount,
    };
  }

  const riskAmount = (acct * riskPct) / 100;
  const qty = riskAmount / dist;
  const notional = qty * e;

  return {
    qty: round(qty, 8),
    notional: round(notional, 2),
    marginRequired: round(notional / lev, 2),
    riskAmount: round(riskAmount, 2),
    notionalPctOfAccount,
    marginPctOfAccount,
  };
}

// --- liquidationPrice ----------------------------------------------------

// 격리 마진 청산가 근사.
//   LONG  : entry × (1 − 1/leverage + mmr)
//   SHORT : entry × (1 + 1/leverage − mmr)
// mmr = maintenanceMarginPct / 100. 수수료·펀딩은 무시한 근사값이다.
function liquidationPrice({ entry, side, leverage, maintenanceMarginPct } = {}) {
  const e = parsePrice(entry);
  const dir = normalizeSide(side);
  const lev = positiveNumber(leverage);
  if (e == null || !dir || lev == null) return null;

  const mmrRaw = Number(maintenanceMarginPct);
  const mmr = Number.isFinite(mmrRaw) && mmrRaw >= 0 ? mmrRaw / 100 : 0;

  const factor = dir === 'LONG' ? 1 - 1 / lev + mmr : 1 + 1 / lev - mmr;
  const liq = e * factor;
  if (!Number.isFinite(liq) || liq <= 0) return null; // 1배 이하 등으로 청산가가 사라지는 경우
  return clean(liq);
}

// --- evaluatePlan --------------------------------------------------------

// riskCfg를 DEFAULTS.risk 기준으로 보정 (이상값은 기본값으로 되돌린다)
function normalizeRiskCfg(riskCfg) {
  const d = DEFAULTS.risk;
  const c = isPlainObject(riskCfg) ? riskCfg : {};
  const num = (v, fallback, { allowZero = false } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (n < 0) return fallback;
    if (n === 0 && !allowZero) return fallback;
    return n;
  };
  return {
    minRR: num(c.minRR, d.minRR),
    accountRiskPct: num(c.accountRiskPct, d.accountRiskPct),
    accountSize: num(c.accountSize, d.accountSize, { allowZero: true }),
    leverage: num(c.leverage, d.leverage),
    maintenanceMarginPct: num(c.maintenanceMarginPct, d.maintenanceMarginPct, { allowZero: true }),
  };
}

// 핵심 게이트. 계획(진입/손절/목표/방향)과 리스크 설정을 받아 강등 여부를 판정한다.
//
// plan: { entry, stop, target, side|action, leverage? } — 값은 문자열이어도 된다(parsePrice 통과).
// 강등 조건: rr < minRR, stopBeyondLiq, entry/stop/target 파싱 불가 중 하나라도 해당.
// 방향·가격을 못 읽으면 안전하게 강등(fail-closed)한다.
function evaluatePlan(plan, riskCfg) {
  const p = isPlainObject(plan) ? plan : {};
  const cfg = normalizeRiskCfg(riskCfg);
  const leverage = positiveNumber(p.leverage) || cfg.leverage;

  const entry = parsePrice(p.entry);
  const stop = parsePrice(p.stop);
  const target = parsePrice(p.target);
  const side = normalizeSide(p.side != null ? p.side : p.action);

  const reasons = []; // 화면·리포트에 그대로 노출되는 전체 사유(정보성 포함)
  const downgradeReasons = []; // 그중 강등을 유발한 사유만 — engine의 [리스크 게이트] 문구용
  let downgrade = false;

  // 강등 사유는 두 배열에 함께 담는다
  const fail = (msg) => {
    reasons.push(msg);
    downgradeReasons.push(msg);
    downgrade = true;
  };

  // 1) 파싱 — 숫자를 못 읽으면 나머지 계산이 전부 무의미하다
  const missing = [];
  if (entry == null) missing.push('진입가');
  if (stop == null) missing.push('손절가');
  if (target == null) missing.push('목표가');
  if (missing.length) {
    fail(`${missing.join('·')}를 숫자로 읽지 못했습니다 — 리스크 검증 불가`);
  }
  if (!side) {
    fail('포지션 방향(LONG/SHORT)을 확인할 수 없어 리스크 검증을 못 했습니다');
  }

  // 2) 손익비
  const rrDetail = computeRR({ entry, stop, target, side });
  const rr = rrDetail.valid ? rrDetail.rr : null;
  if (!rrDetail.valid) {
    // 파싱·방향 실패는 위에서 이미 사유를 남겼으므로 중복 기재하지 않는다
    if (!missing.length && side) fail(rrDetail.reason);
    else downgrade = true;
  } else if (rr < cfg.minRR) {
    fail(
      `손익비 ${rr.toFixed(2)}가 최소 기준 ${cfg.minRR}에 미달합니다 (위험 ${rrDetail.riskPct}% / 보상 ${rrDetail.rewardPct}%)`
    );
  } else {
    reasons.push(
      `손익비 ${rr.toFixed(2)} — 최소 기준 ${cfg.minRR} 충족 (위험 ${rrDetail.riskPct}% / 보상 ${rrDetail.rewardPct}%)`
    );
  }

  // 3) 청산가 — 손절보다 청산이 먼저 오면 치명적이다
  const liq = liquidationPrice({
    entry,
    side,
    leverage,
    maintenanceMarginPct: cfg.maintenanceMarginPct,
  });

  let stopBeyondLiq = false;
  let liqBufferPct = null;
  if (entry != null && stop != null && liq != null && side) {
    // 손절과 청산 사이 거리(진입가 대비 %). 양수면 손절이 먼저 작동한다.
    liqBufferPct = round((((side === 'LONG' ? stop - liq : liq - stop) / entry) * 100), 3);
    stopBeyondLiq = side === 'LONG' ? stop < liq : stop > liq;
    if (stopBeyondLiq) {
      fail(
        `손절가 ${fmt(stop)}가 청산가 ${fmt(liq)} 너머에 있습니다 — ${leverage}배에서는 손절 전에 청산됩니다 (${Math.abs(liqBufferPct)}%p 초과)`
      );
    } else {
      reasons.push(
        `${leverage}배 청산가 ${fmt(liq)} — 손절가가 청산가보다 ${liqBufferPct}%p 앞에 있습니다`
      );
    }
  } else if (liq != null) {
    reasons.push(`${leverage}배 청산가 ${fmt(liq)} — 손절가를 못 읽어 청산 여유는 계산하지 못했습니다`);
  } else {
    reasons.push('청산가를 계산할 수 없습니다 (진입가·방향·레버리지 확인 필요)');
  }

  // 4) 사이징
  const sizing = positionSize({
    accountSize: cfg.accountSize,
    accountRiskPct: cfg.accountRiskPct,
    entry,
    stop,
    leverage,
  });
  if (sizing.notionalPctOfAccount != null) {
    if (sizing.qty == null) {
      reasons.push(
        `계좌 규모 미설정 — 비중만 표기합니다: 명목 ${sizing.notionalPctOfAccount}% · 증거금 ${sizing.marginPctOfAccount}% (1회 허용손실 ${cfg.accountRiskPct}%)`
      );
    } else {
      reasons.push(
        `사이징: 수량 ${sizing.qty} · 명목 ${fmt(sizing.notional)} (계좌의 ${sizing.notionalPctOfAccount}%) · 증거금 ${fmt(sizing.marginRequired)} · 최대손실 ${fmt(sizing.riskAmount)}`
      );
    }
  } else {
    reasons.push('진입가·손절가가 없어 포지션 크기를 계산하지 못했습니다');
  }

  return {
    ok: !downgrade,
    rr,
    liq,
    stopBeyondLiq,
    downgrade,
    reasons,
    sizing,
    // --- 계약서 필수 항목 외 추가 제공 (읽기 전용 보조 정보) ---
    downgradeReasons, // reasons 중 강등을 유발한 것만. engine의 `[리스크 게이트] <사유>`에 쓴다
    liqBufferPct, // 손절~청산 거리(진입가 대비 %p). GUARD·SAFE 프롬프트 주입용
    rrDetail, // computeRR 원본 { rr, riskPct, rewardPct, valid, reason }
    parsed: { entry, stop, target, side, leverage, minRR: cfg.minRR },
  };
}

module.exports = { parsePrice, computeRR, positionSize, liquidationPrice, evaluatePlan };
