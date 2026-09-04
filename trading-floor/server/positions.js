'use strict';

// PIXEL TRADING FLOOR — 가상 포지션 추적
//
// 판정(decision)을 받아 "실제 주문 없이" 포지션을 장부에만 기록하고,
// 시세를 받아 평가손익을 갱신하고, 청산 시 성적을 남긴다.
// 저장소는 reports/positions.json 하나뿐이며 `{ open: [], closed: [] }` 형태다.
//
// 규칙
// - 파일이 없거나 깨져 있어도 절대 throw 하지 않는다. 빈 장부로 시작한다.
// - 가격 문자열 파싱은 riskmath.parsePrice 하나만 쓴다(중복 구현 금지).
//   riskmath.js가 아직 없을 때만 최소 폴백으로 버틴다.
// - 데이터가 없으면 숫자를 지어내지 않고 null을 넣는다. 0으로 위장하지 않는다.
// - 실주문은 없다. 여기 있는 값은 전부 시뮬레이션이다.

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'reports', 'positions.json');
let overrideFile = null;

// 저장 경로. 테스트는 FLOOR_POSITIONS_FILE 또는 _setStoreFile()로 임시 파일을 쓴다.
function storeFile() {
  if (overrideFile) return overrideFile;
  if (process.env.FLOOR_POSITIONS_FILE) return process.env.FLOOR_POSITIONS_FILE;
  return DEFAULT_FILE;
}

// 테스트 전용 훅 — 실제 reports/positions.json을 건드리지 않게 경로를 갈아끼운다.
function _setStoreFile(p) {
  overrideFile = p || null;
  return storeFile();
}

// --- riskmath 연동 -------------------------------------------------------
// riskmath.js는 별도 모듈로 개발 중이라 아직 없을 수 있다.
// 있으면 반드시 그쪽 계산을 쓰고, 없을 때만 아래 로컬 폴백으로 버틴다.

let _rm; // undefined = 아직 안 불러봄, null = 없음
function riskmath() {
  if (_rm === undefined) {
    try {
      _rm = require('./riskmath');
    } catch (_) {
      _rm = null;
    }
  }
  return _rm;
}

function rmFn(name) {
  const m = riskmath();
  return m && typeof m[name] === 'function' ? m[name] : null;
}

// --- 작은 도구들 ---------------------------------------------------------

function num(v, dflt) {
  const n = fin(v);
  return n == null ? dflt : n;
}

// 유한한 숫자면 그 값, 아니면 null.
// Number(null)이 0이 되는 함정을 막는다 — 여기서 0으로 새면 "데이터 없음"이
// "손익 0"으로 위장돼 성적표가 통째로 거짓이 된다.
function fin(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r; // -0 방지
}

function round6(n) {
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

// riskmath가 없을 때만 쓰는 최소 파서. "1,341,000원" → 1341000
function fallbackParsePrice(text) {
  if (text == null) return null;
  const s = String(text).replace(/,/g, '');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

// 숫자면 그대로, 문자열이면 riskmath.parsePrice로 파싱한다.
function parsePrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const f = rmFn('parsePrice');
  if (f) {
    try {
      const r = f(v);
      return typeof r === 'number' && Number.isFinite(r) ? r : null;
    } catch (_) {
      // riskmath가 던지면 폴백으로 내려간다 (감시·판정 흐름을 막지 않는다)
    }
  }
  return fallbackParsePrice(v);
}

// --- 저장소 --------------------------------------------------------------

// 절대 throw 하지 않는다. 파일 없음·JSON 깨짐·형식 이상 → 빈 장부.
function load() {
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      open: Array.isArray(parsed && parsed.open) ? parsed.open.filter(Boolean) : [],
      closed: Array.isArray(parsed && parsed.closed) ? parsed.closed.filter(Boolean) : [],
    };
  } catch (_) {
    return { open: [], closed: [] };
  }
}

// 저장 실패도 흐름을 막지 않는다 (console.error만 남긴다).
function save(store) {
  const file = storeFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[positions] 저장 실패:', e && e.message ? e.message : e);
    return false;
  }
}

function makeId(symbol, store) {
  const base = `${String(symbol || 'POS').toUpperCase()}-${Date.now().toString(36)}`;
  const used = new Set(
    [].concat(store.open || [], store.closed || []).map((p) => p && p.id)
  );
  let id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  let guard = 0;
  while (used.has(id) && guard++ < 50) {
    id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return id;
}

// --- 판정 → 포지션 -------------------------------------------------------

// 스캘핑 판정(scalp.bias)이 LONG/SHORT면 그것을 우선한다.
// 없으면 action(BUY→LONG, SELL→SHORT).
// 둘 다 방향이 없으면(HOLD + scalp 없음/PASS) null — 포지션을 열지 않는다.
function sideFromDecision(decision) {
  if (!decision || typeof decision !== 'object') return null;
  const scalp = decision.scalp;
  const bias =
    scalp && scalp.bias != null ? String(scalp.bias).toUpperCase().trim() : null;
  if (bias === 'LONG' || bias === 'SHORT') return bias;
  const action = String(decision.action || '').toUpperCase().trim();
  if (action === 'BUY') return 'LONG';
  if (action === 'SELL') return 'SHORT';
  return null;
}

// 이 종목이 어느 가격 축을 쓰는지 판별한다.
// 한국주식은 KRX 원화(₩1,577,000)와 USDT 무기한($1,111) 두 축이 동시에 존재하고,
// 축을 섞어 손익을 계산하면 +140,000% 같은 허구가 장부에 영구 기록된다.
// (CLAUDE.md의 이중 가격 체계 규칙)
function axisOf(market) {
  if (!market || typeof market !== 'object') return 'unknown';
  const perp = market.perp;
  if (perp && typeof perp === 'object') {
    const pi = perp.indicators || {};
    const pc = Array.isArray(perp.candles) ? perp.candles[perp.candles.length - 1] : null;
    if (fin(pi.price) != null || fin(perp.last) != null || (pc && fin(pc.c) != null)) {
      return 'perp'; // USDT 무기한 (실제 체결 축)
    }
  }
  if (market.kind === 'krstock') return 'krx'; // 원화 정규장
  return 'spot';
}

// 현재가 추정. 한국주식은 실제 체결이 일어나는 USDT 무기한(market.perp)을 우선한다.
function marketPrice(market) {
  if (!market || typeof market !== 'object') return null;
  const perp = market.perp;
  if (perp && typeof perp === 'object') {
    const pi = perp.indicators || {};
    if (fin(pi.price) != null) return fin(pi.price);
    if (fin(perp.last) != null) return fin(perp.last);
    const pc = Array.isArray(perp.candles) ? perp.candles[perp.candles.length - 1] : null;
    if (pc && fin(pc.c) != null) return fin(pc.c);
  }
  const i = market.indicators || {};
  if (fin(i.price) != null) return fin(i.price);
  const c = Array.isArray(market.candles) ? market.candles[market.candles.length - 1] : null;
  if (c && fin(c.c) != null) return fin(c.c);
  return null;
}

// 손익비. riskmath.computeRR이 있으면 그것을, 없으면 동일 정의의 로컬 계산.
function computeRR(entry, stop, target, side) {
  if (entry == null || stop == null || target == null) return null;
  const f = rmFn('computeRR');
  if (f) {
    try {
      const r = f({ entry, stop, target, side }) || {};
      // valid:false면(방향 어긋남 등) 손익비를 만들지 않는다
      if (r.valid === false) return null;
      const v = fin(r.rr);
      return v != null && v > 0 ? round2(v) : null;
    } catch (_) {
      // 폴백으로 내려간다
    }
  }
  const dir = side === 'SHORT' ? -1 : 1;
  const risk = (entry - stop) * dir;
  const reward = (target - entry) * dir;
  if (!(risk > 0) || !(reward > 0)) return null; // 방향이 어긋나면 손익비를 만들지 않는다
  return round2(reward / risk);
}

// 청산가(격리 근사). riskmath.liquidationPrice 우선.
function liquidationPrice(entry, side, leverage, maintenanceMarginPct) {
  if (!(entry > 0) || !(leverage > 0)) return null;
  const f = rmFn('liquidationPrice');
  if (f) {
    try {
      const v = fin(f({ entry, side, leverage, maintenanceMarginPct }));
      if (v != null) return round6(v);
    } catch (_) {
      // 폴백으로 내려간다
    }
  }
  const mm = num(maintenanceMarginPct, 0) / 100;
  const v =
    side === 'SHORT'
      ? entry * (1 + 1 / leverage - mm)
      : entry * (1 - 1 / leverage + mm);
  return round6(v);
}

// 수량·명목. riskmath.positionSize 우선. 계좌 크기가 0이면 수량은 null(비율만).
function sizeFor({ accountSize, accountRiskPct, entry, stop, leverage }) {
  const empty = {
    qty: null,
    notional: null,
    marginRequired: null,
    riskAmount: null,
    notionalPctOfAccount: null,
    sizingNote: null,
  };
  const f = rmFn('positionSize');
  if (f) {
    try {
      const r = f({ accountSize, accountRiskPct, entry, stop, leverage }) || {};
      const qty = fin(r.qty);
      return {
        qty: qty,
        notional: fin(r.notional),
        marginRequired: fin(r.marginRequired),
        riskAmount: fin(r.riskAmount),
        notionalPctOfAccount: fin(r.notionalPctOfAccount),
        sizingNote:
          qty != null
            ? null
            : accountSize > 0
            ? '수량 계산에 필요한 값(손절가 등)이 없다'
            : '계좌 크기 미설정 — 수량은 계산하지 않는다',
      };
    } catch (_) {
      // 폴백으로 내려간다
    }
  }
  if (!(accountSize > 0)) {
    return { ...empty, sizingNote: '계좌 크기 미설정 — 수량은 계산하지 않는다' };
  }
  if (stop == null || !(entry > 0)) {
    return { ...empty, sizingNote: '손절가가 없어 수량을 계산할 수 없다' };
  }
  const riskPerUnit = Math.abs(entry - stop);
  if (!(riskPerUnit > 0)) {
    return { ...empty, sizingNote: '진입가와 손절가가 같아 수량을 계산할 수 없다' };
  }
  const riskAmount = accountSize * (num(accountRiskPct, 0) / 100);
  const qty = riskAmount / riskPerUnit;
  const notional = qty * entry;
  const lev = leverage > 0 ? leverage : 1;
  return {
    qty: round6(qty),
    notional: round2(notional),
    marginRequired: round2(notional / lev),
    riskAmount: round2(riskAmount),
    notionalPctOfAccount: round2((notional / accountSize) * 100),
    sizingNote: null,
  };
}

/**
 * 판정에서 가상 포지션을 연다. 방향이 없으면(관망) null.
 * @param {object} decision engine의 decision 객체 ({action, confidence, entry, stop, target, scalp:{bias,entry,stop,target}})
 * @param {object} market   fetchMarket 결과 (symbol/display/perp/indicators 사용)
 * @param {object} cfg      config.js의 설정 객체 (cfg.risk의 leverage/accountSize/accountRiskPct/maintenanceMarginPct)
 * @param {object} [opts]   { mode, source, now } — 계약 밖 부가 인자(생략 가능)
 * @returns {object|null} 저장된 포지션
 */
function openFromDecision(decision, market, cfg, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const side = sideFromDecision(decision);
  if (!side) return null; // HOLD이고 스캘핑이 없거나 PASS → 포지션 없음

  const scalp =
    decision.scalp && typeof decision.scalp === 'object' ? decision.scalp : null;
  const scalpBias = scalp && scalp.bias ? String(scalp.bias).toUpperCase().trim() : null;
  const usedScalp = scalpBias === 'LONG' || scalpBias === 'SHORT';
  // 방향을 준 쪽의 레벨을 먼저 본다. 없는 항목만 다른 쪽에서 채운다.
  const sources = usedScalp ? [scalp, decision] : [decision, scalp];
  const pick = (key) => {
    for (const s of sources) {
      if (!s) continue;
      const v = parsePrice(s[key]);
      if (v != null && v > 0) return v;
    }
    return null;
  };

  const stop = pick('stop');
  const target = pick('target');
  let entry = pick('entry');
  let entrySource = 'plan';
  if (entry == null) {
    entry = marketPrice(market);
    entrySource = 'market'; // 계획에 숫자가 없어 현재가로 잡았다는 표시
  }
  if (!(entry > 0)) return null; // 진입가를 만들어낼 수 없으면 포지션을 열지 않는다

  const risk = (cfg && cfg.risk) || {};
  const leverage = num(risk.leverage, 20);
  const accountSize = num(risk.accountSize, 0);
  const accountRiskPct = num(risk.accountRiskPct, 2);
  const mmPct = num(risk.maintenanceMarginPct, 0.5);

  const sizing = sizeFor({ accountSize, accountRiskPct, entry, stop, leverage });
  let rr = computeRR(entry, stop, target, side);
  if (rr == null && fin(decision.rr) != null) rr = round2(fin(decision.rr));

  const symbol = String(
    (market && market.symbol) || decision.symbol || o.symbol || 'UNKNOWN'
  ).toUpperCase();
  const display = (market && market.display) || decision.display || symbol;

  const store = load();
  const pos = {
    id: makeId(symbol, store),
    symbol,
    display,
    side,
    mode: o.mode || decision.mode || (cfg && cfg.mode) || null,
    entry: round6(entry),
    stop: stop == null ? null : round6(stop),
    target: target == null ? null : round6(target),
    qty: sizing.qty,
    notional: sizing.notional,
    leverage,
    liq: liquidationPrice(entry, side, leverage, mmPct),
    rr,
    openedAt: o.now || new Date().toISOString(),
    source: o.source || 'auto',
    status: 'open',

    // --- 계약 밖 부가 필드 (있으면 화면·리포트에서 쓰고, 없어도 무해) ---
    // priceAxis: 이 포지션의 가격이 어느 축인지. markToMarket이 축이 다른 시세를
    // 반영해 허구의 손익을 만들지 않도록 하는 안전장치다.
    priceAxis: axisOf(market),
    // 리스크 게이트가 불합격시킨 계획인지(공격 모드는 강등하지 않고 열리므로 표시만 한다).
    // stats.js는 이 표본을 승률 계산에서 제외해야 한다.
    gateFailed: !!(o && o.gateFailed),
    entrySource, // 'plan' = 판정이 준 숫자, 'market' = 현재가로 대체
    marginRequired: sizing.marginRequired,
    riskAmount: sizing.riskAmount,
    notionalPctOfAccount: sizing.notionalPctOfAccount != null ? sizing.notionalPctOfAccount : null,
    sizingNote: sizing.sizingNote,
    confidence: fin(decision.confidence),
    lastPrice: null,
    markedAt: null,
    unrealizedPct: null,
    unrealizedAmt: null,
    roePct: null,
    hitStop: false,
    hitTarget: false,
  };

  store.open.push(pos);
  save(store);
  return pos;
}

// --- 평가 ----------------------------------------------------------------

function priceOf(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return fin(raw.price != null ? raw.price : raw.last);
  return fin(raw);
}

/**
 * 시세를 반영해 미실현 손익·손절/목표 도달 여부를 갱신한다.
 * @param {object} prices { SYMBOL: number } — 값이 없는 심볼은 그대로 둔다(추측 금지).
 * @returns {Array} 갱신된 open 배열
 */
function markToMarket(prices) {
  const store = load();
  const map = prices && typeof prices === 'object' ? prices : {};
  const now = new Date().toISOString();
  let changed = false;

  for (const p of store.open) {
    if (!p || !p.symbol) continue;
    const raw = map[p.symbol];
    const price = priceOf(raw);
    if (price == null || !(price > 0)) continue; // 시세 없음 → 이전 값 유지

    // 가격 축 검증 — 진입가와 다른 축의 시세면 반영하지 않는다.
    // 축 표기가 없는 시세는 값의 크기로 판별한다(같은 축이면 배율이 10배를 넘지 않는다).
    const feedAxis = raw && typeof raw === 'object' && raw.axis ? String(raw.axis) : null;
    const posAxis = p.priceAxis || null;
    if (feedAxis && posAxis && feedAxis !== posAxis) {
      p.markSkipped = `가격 축 불일치(포지션 ${posAxis} vs 시세 ${feedAxis}) — 반영하지 않음`;
      changed = true;
      continue;
    }
    if (p.entry > 0) {
      const ratio = price / p.entry;
      if (ratio > 10 || ratio < 0.1) {
        p.markSkipped =
          `시세(${price})가 진입가(${p.entry}) 대비 비정상적으로 벌어져 가격 축이 다른 것으로 판단 — 반영하지 않음`;
        changed = true;
        continue;
      }
    }
    if (p.markSkipped) { p.markSkipped = null; changed = true; }
    const dir = p.side === 'SHORT' ? -1 : 1;
    const entry = fin(p.entry);
    if (!(entry > 0)) continue;

    const pct = ((price - entry) / entry) * 100 * dir;
    const qty = fin(p.qty);
    const stop = fin(p.stop);
    const target = fin(p.target);
    p.lastPrice = round6(price);
    p.markedAt = now;
    p.unrealizedPct = round2(pct); // 가격 변동률(레버리지 미적용)
    p.roePct = round2(pct * num(p.leverage, 1)); // 증거금 대비 수익률
    p.unrealizedAmt = qty == null ? null : round2((price - entry) * qty * dir);
    p.hitStop = stop == null ? false : dir === 1 ? price <= stop : price >= stop;
    p.hitTarget = target == null ? false : dir === 1 ? price >= target : price <= target;
    changed = true;
  }

  if (changed) save(store);
  return store.open;
}

/**
 * 포지션을 청산해 closed로 옮긴다.
 * @param {string} id
 * @param {object} [opts] { price, reason } — price 없으면 마지막 평가가를 쓴다.
 * @returns {object|null} 청산된 포지션 (없는 id면 null, throw 안 함)
 */
function closePosition(id, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const store = load();
  const idx = store.open.findIndex((p) => p && p.id === id);
  if (idx === -1) return null;

  const pos = store.open[idx];
  const exit = priceOf(o.price != null ? o.price : pos.lastPrice);
  const dir = pos.side === 'SHORT' ? -1 : 1;
  const entry = fin(pos.entry);
  const qty = fin(pos.qty);
  const closedAt = o.now || new Date().toISOString();
  const openedMs = Date.parse(pos.openedAt);
  const closedMs = Date.parse(closedAt);

  const hasExit = exit != null && exit > 0 && entry != null && entry > 0;
  const realizedPct = hasExit ? round2(((exit - entry) / entry) * 100 * dir) : null;

  const closedPos = {
    ...pos,
    status: 'closed',
    exitPrice: hasExit ? round6(exit) : null,
    closedAt,
    closeReason: o.reason || '수동 청산',
    realizedPct, // 가격 변동률(레버리지 미적용)
    realizedRoePct: realizedPct == null ? null : round2(realizedPct * num(pos.leverage, 1)),
    realizedAmt: hasExit && qty != null ? round2((exit - entry) * qty * dir) : null,
    holdMin:
      Number.isFinite(openedMs) && Number.isFinite(closedMs)
        ? Math.max(0, Math.round((closedMs - openedMs) / 60000))
        : null,
    // 평가가가 없어 손익을 못 낸 경우를 숨기지 않는다
    note: hasExit ? null : '청산가를 알 수 없어 실현손익을 계산하지 않았다',
  };
  // 열려 있을 때만 의미 있는 필드를 정리한다
  delete closedPos.unrealizedPct;
  delete closedPos.unrealizedAmt;
  delete closedPos.roePct;

  store.open.splice(idx, 1);
  store.closed.push(closedPos);
  save(store);
  return closedPos;
}

/** 장부 전체. 라우트(GET /api/positions)가 그대로 내보낼 수 있게 summary도 함께 준다. */
function listPositions() {
  const store = load();
  return { open: store.open, closed: store.closed, summary: summary() };
}

/**
 * 성적 요약. 표본이 없으면 0으로 위장하지 않고 null을 넣는다.
 * 승률·손익비는 모두 "가격 변동률(%)" 기준이다(수량이 없는 포지션도 섞이므로).
 */
function summary() {
  const store = load();
  // 리스크 게이트가 불합격시킨 계획(주로 공격 모드 연출용)은 성적 표본에서 제외한다.
  // 스스로 "이 자리는 나쁘다"고 판정한 건을 승률에 섞으면 통계가 오염된다.
  const closed = store.closed.filter((p) => !(p && p.gateFailed));
  const excluded = store.closed.length - closed.length;
  // realizedPct가 null인 건(청산가를 모르는 건)은 표본에서 뺀다. 0으로 세지 않는다.
  const rets = closed.map((p) => fin(p && p.realizedPct)).filter((r) => r != null);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r < 0);

  const grossWin = wins.reduce((s, r) => s + r, 0);
  const grossLoss = losses.reduce((s, r) => s + Math.abs(r), 0);

  const rrs = []
    .concat(store.open, store.closed)
    .map((p) => fin(p && p.rr))
    .filter((r) => r != null);

  const n = rets.length;
  const notes = [];
  if (excluded > 0) notes.push(`리스크 게이트 불합격 ${excluded}건은 표본에서 제외됨`);
  if (closed.length === 0) notes.push('청산된 포지션이 없어 성적을 낼 수 없다');
  else if (n === 0) notes.push('청산가를 아는 포지션이 없어 성적을 낼 수 없다');
  else if (n < 20) notes.push(`평가 표본 ${n}건 — 통계적 유의성 없음`);
  if (n > 0 && losses.length === 0) notes.push('손실 거래가 없어 손익비(profitFactor)는 정의되지 않는다');

  return {
    openCount: store.open.length,
    closedCount: closed.length,
    evaluated: n, // realizedPct를 아는 청산 건수
    wins: wins.length,
    losses: losses.length,
    winRate: n > 0 ? round2((wins.length / n) * 100) : null,
    avgWinPct: wins.length ? round2(grossWin / wins.length) : null,
    avgLossPct: losses.length ? round2(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null, // 손실 0 → 무한대라 null
    expectancyPct: n > 0 ? round2(rets.reduce((s, r) => s + r, 0) / n) : null,
    avgRR: rrs.length ? round2(rrs.reduce((s, r) => s + r, 0) / rrs.length) : null,
    note: notes.length ? notes.join(' · ') : null,
  };
}

module.exports = {
  openFromDecision,
  markToMarket,
  closePosition,
  listPositions,
  summary,
  // 계약 밖 보조 (테스트·통합용)
  _setStoreFile,
  _storeFile: storeFile,
};
