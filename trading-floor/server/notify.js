'use strict';

// PIXEL TRADING FLOOR — 텔레그램 발송 (notify)
//
// 계약(docs/v2-contracts.md):
//   module.exports = { sendMessage, sendDecision, sendAlert, isEnabled }
//
// 원칙
//   - Node 내장 fetch로 https://api.telegram.org/bot<token>/sendMessage 만 호출한다.
//   - **절대 throw 하지 않는다.** 앱 흐름(분석·감시 루프)을 이 모듈이 막으면 안 된다.
//     실패는 console.error 한 줄 + { ok:false, error } 반환으로 끝낸다.
//   - 봇 토큰은 어떤 경로로도 로그에 남기지 않는다(redact 로 세탁한 뒤에만 출력).
//   - 모든 메시지는 HTML parse_mode · 한국어 · 끝에 항상 면책 문구.
//   - 데이터에 없는 값은 줄 자체를 빼고, 지어내지 않는다.

const API_BASE = 'https://api.telegram.org';
const API_TIMEOUT_MS = 10000;
const TAIL = '— AI 시뮬레이션, 투자 조언 아님';
const TG_MAX = 4096; // 텔레그램 메시지 길이 상한

// 테스트에서 갈아끼울 수 있게 간접 참조로 둔다(_setFetch).
let fetchImpl = (...args) => fetch(...args);

// --- config 로드 (config.js 가 아직 없어도 죽지 않는다) ------------------

// config.js 는 다른 모듈이 만드는 파일이라 없을 수 있다. 없으면 텔레그램은
// 그냥 '비활성'으로 취급한다(무설정 = 발송 안 함).
const CFG_FALLBACK = { telegram: { enabled: false, botToken: '', chatId: '' } };
let cfgMod; // undefined = 아직 시도 안 함, null = 없음
let cfgModTriedAt = 0;

function loadCfgSafe() {
  const now = Date.now();
  if (cfgMod === undefined || (cfgMod === null && now - cfgModTriedAt > 60000)) {
    cfgModTriedAt = now;
    try {
      // eslint-disable-next-line global-require
      const m = require('./config');
      cfgMod = m && typeof m.loadConfig === 'function' ? m : null;
    } catch (_) {
      cfgMod = null;
    }
  }
  if (cfgMod) {
    try {
      const c = cfgMod.loadConfig();
      if (c && typeof c === 'object') return c;
    } catch (_) {}
  }
  return CFG_FALLBACK;
}

// cfg 는 세 가지 형태를 모두 받는다:
//   1) 전체 설정 객체        { telegram:{...}, risk:{...} }
//   2) 텔레그램 설정만       { enabled, botToken, chatId }
//   3) 생략(undefined/null)  → config.js 에서 직접 읽는다
function normalizeCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return loadCfgSafe();
  if (cfg.telegram && typeof cfg.telegram === 'object') return cfg;
  if ('botToken' in cfg || 'chatId' in cfg) return { telegram: cfg };
  return cfg;
}

function pickTelegram(cfg) {
  const t = (cfg && cfg.telegram) || {};
  return {
    enabled: !!t.enabled,
    botToken: String(t.botToken || '').trim(),
    chatId: String(t.chatId == null ? '' : t.chatId).trim(),
  };
}

function isEnabled(cfg) {
  const t = pickTelegram(normalizeCfg(cfg));
  return !!(t.enabled && t.botToken && t.chatId);
}

// --- 문자열 유틸 --------------------------------------------------------

// 토큰이 실수로 로그·반환값에 섞이는 걸 막는다.
function redact(text, token) {
  let s = String(text == null ? '' : text);
  if (token) s = s.split(token).join('***');
  // 형태가 남아 있으면(다른 토큰이라도) 통째로 가린다: 123456789:AAH...
  return s.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '***');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 필드 단위 상한 — 메시지가 텔레그램 상한을 넘지 않게 앞단에서 자른다.
function cut(s, max) {
  const t = String(s == null ? '' : s).trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v).toLocaleString('en-US');
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(4);
  if (abs === 0) return '0';
  return v.toPrecision(4);
}

function pctStr(n, dp = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`;
}

function hhmmKst(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  // 서버 로컬 시각을 그대로 쓴다(이 앱은 KST PC에서 돈다).
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 값이 있을 때만 줄을 만든다(없는 수치를 지어내지 않기 위한 게이트).
function has(v) {
  return v != null && v !== '' && v !== '-';
}

// --- 발송 ---------------------------------------------------------------

// text 는 **이미 HTML 이스케이프된** 문자열이어야 한다(태그를 쓰기 때문).
// 반환: { ok:true, messageId } | { ok:false, error }
async function sendMessage(text, cfg) {
  const c = normalizeCfg(cfg);
  const tg = pickTelegram(c);
  if (!tg.enabled) return { ok: false, error: '텔레그램 비활성(config.telegram.enabled=false)' };
  if (!tg.botToken || !tg.chatId) {
    return { ok: false, error: '봇 토큰 또는 chatId 가 비어 있음' };
  }

  let body = String(text == null ? '' : text);
  if (!body.trim()) return { ok: false, error: '빈 메시지' };
  if (body.length > TG_MAX) {
    // 필드 단위로 이미 잘라두므로 여기까지 오는 건 예외 상황이다.
    body = body.slice(0, TG_MAX - 120) + '\n…(생략)\n\n' + TAIL;
  }

  try {
    const res = await fetchImpl(`${API_BASE}/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text: body,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok || !data || data.ok !== true) {
      const why =
        (data && (data.description || data.error_code)) ||
        `HTTP ${res && res.status != null ? res.status : '?'}`;
      const msg = redact(String(why), tg.botToken);
      console.error('[notify] 텔레그램 발송 실패:', msg);
      return { ok: false, error: msg };
    }
    return { ok: true, messageId: data.result ? data.result.message_id : null };
  } catch (e) {
    const msg = redact(e && e.message ? e.message : String(e), tg.botToken);
    console.error('[notify] 텔레그램 발송 오류:', msg);
    return { ok: false, error: msg };
  }
}

// --- 판정 메시지 --------------------------------------------------------

const MODE_LABEL = {
  algo: '알고리즘',
  scalp: '스캘핑 20x',
  attack: '공격 20x',
};

const ACTION_ICON = {
  BUY: '🟢',
  SELL: '🔴',
  LONG: '🟢',
  SHORT: '🔴',
  HOLD: '⚪',
  PASS: '⚪',
};

// 리포트 링크. localhost 는 폰에서 열리지 않으므로 링크 대신 경로만 보여준다
// (열리지도 않는 링크를 다는 게 더 나쁘다).
function baseUrl(cfg) {
  const b =
    (cfg && (cfg.baseUrl || (cfg.telegram && cfg.telegram.baseUrl))) ||
    process.env.FLOOR_BASE_URL ||
    '';
  if (b) return String(b).replace(/\/+$/, '');
  const port = Number(process.env.PORT) || 8000;
  return `http://localhost:${port}`;
}

function reportLine(decision, cfg) {
  const p =
    decision.reportPath || decision.savedPath || decision.path || decision.report_url || null;
  if (!p) return null;
  const raw = String(p);
  if (/^https?:\/\//i.test(raw)) {
    return `📄 <a href="${escapeHtml(raw)}">리포트 열기</a>`;
  }
  const rel = raw.replace(/^\/+/, '');
  const base = baseUrl(cfg);
  const name = rel.split('/').pop();
  if (/localhost|127\.0\.0\.1/i.test(base)) {
    // 로컬 전용 주소 — 파일 경로만 알려준다.
    return `📄 리포트 <code>${escapeHtml(rel)}</code>`;
  }
  return `📄 <a href="${escapeHtml(base + '/' + rel)}">${escapeHtml(name)}</a>`;
}

// sizing 은 문자열(PM 코멘트)일 수도, riskmath.positionSize() 객체일 수도 있다.
function sizingText(sizing) {
  if (!sizing) return null;
  if (typeof sizing === 'string') return cut(sizing, 160);
  if (typeof sizing !== 'object') return null;
  const bits = [];
  if (Number.isFinite(Number(sizing.qty))) bits.push(`수량 ${fmtNum(sizing.qty)}`);
  if (Number.isFinite(Number(sizing.notional))) bits.push(`명목 ${fmtNum(sizing.notional)}`);
  if (Number.isFinite(Number(sizing.marginRequired))) {
    bits.push(`증거금 ${fmtNum(sizing.marginRequired)}`);
  }
  if (Number.isFinite(Number(sizing.riskAmount))) {
    bits.push(`허용손실 ${fmtNum(sizing.riskAmount)}`);
  }
  if (Number.isFinite(Number(sizing.notionalPctOfAccount))) {
    bits.push(`계좌의 ${Number(sizing.notionalPctOfAccount).toFixed(1)}%`);
  }
  return bits.length ? bits.join(' · ') : null;
}

// 20배(레버리지) 판정이면 청산 경고를 반드시 한 줄 붙인다 — CLAUDE.md 규칙.
function leverageWarning(decision, cfg) {
  const mode = String(decision.mode || '').toLowerCase();
  const levered =
    mode === 'scalp' ||
    mode === 'attack' ||
    !!decision.scalp ||
    decision.liq != null ||
    decision.stopBeyondLiq === true;
  if (!levered) return null;

  const lev = Number(
    decision.leverage != null ? decision.leverage : cfg && cfg.risk ? cfg.risk.leverage : null
  );
  const levTxt = Number.isFinite(lev) && lev > 0 ? `${lev}배` : '고배율';
  const parts = [`⚠ <b>${escapeHtml(levTxt)} 청산 경고</b>`];
  if (has(decision.liq)) {
    parts.push(`청산가 ${escapeHtml(fmtNum(decision.liq))} 확인`);
  }
  if (decision.stopBeyondLiq === true) {
    parts.push('<b>손절보다 청산이 먼저 온다 — 이 설계는 치명적</b>');
  } else if (Number.isFinite(lev) && lev > 0) {
    parts.push(`약 ${(100 / lev).toFixed(1)}% 역행이면 청산 구간(유지증거금 별도)`);
  }
  parts.push('잔고 전액 진입 금지');
  return parts.join(' · ');
}

function buildDecisionHtml(decision, market, cfg) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const m = market && typeof market === 'object' ? market : {};

  const display = String(d.symbol || d.display || m.display || m.symbol || '-');
  const nameKo = m.nameKo || d.nameKo || '';
  const title = nameKo ? `${nameKo} (${display})` : display;
  const mode = String(d.mode || '').toLowerCase();
  const modeLabel = MODE_LABEL[mode] || '';

  const action = String(d.action || '-').toUpperCase();
  const icon = ACTION_ICON[action] || '◆';

  const L = [];
  L.push(
    `${icon} <b>${escapeHtml(title)}</b>` + (modeLabel ? ` — ${escapeHtml(modeLabel)}` : '')
  );

  const conf = Number(d.confidence);
  L.push(
    `판정 <b>${escapeHtml(action)}</b>` +
      (Number.isFinite(conf) ? ` · 확신도 <b>${conf}%</b>` : '') +
      (has(d.verdict) ? ` · PM ${escapeHtml(String(d.verdict))}` : '')
  );

  // 손익비 · 권장비중
  const rrBits = [];
  const rr = Number(d.rr);
  if (Number.isFinite(rr) && rr > 0) rrBits.push(`손익비 1:${rr.toFixed(2)}`);
  const sz = sizingText(d.sizing);
  if (sz) rrBits.push(`권장비중 ${sz}`);
  if (rrBits.length) L.push(escapeHtml(rrBits.join(' · ')));

  // 진입 / 손절 / 목표
  const plan = [];
  if (has(d.entry)) plan.push(`진입 ${cut(d.entry, 60)}`);
  if (has(d.stop)) plan.push(`손절 ${cut(d.stop, 60)}`);
  if (has(d.target)) plan.push(`목표 ${cut(d.target, 60)}`);
  if (plan.length) L.push(escapeHtml(plan.join(' / ')));

  // 스캘핑 판정
  if (d.scalp && typeof d.scalp === 'object') {
    const s = d.scalp;
    const sb = [`스캘핑 <b>${escapeHtml(String(s.bias || '-').toUpperCase())}</b>`];
    if (has(s.entry)) sb.push(escapeHtml(`진입 ${cut(s.entry, 60)}`));
    if (has(s.stop)) sb.push(escapeHtml(`무효화 ${cut(s.stop, 60)}`));
    if (has(s.target)) sb.push(escapeHtml(`목표 ${cut(s.target, 60)}`));
    L.push(sb.join(' · '));
  }

  // 청산 경고 (20배 관련이면 필수)
  const warn = leverageWarning(d, cfg);
  if (warn) {
    L.push('');
    L.push(warn);
  }

  // 리스크 게이트 사유
  const reasons = Array.isArray(d.riskReasons)
    ? d.riskReasons
    : Array.isArray(d.reasons)
    ? d.reasons
    : [];
  if (reasons.length) {
    L.push('');
    for (const r of reasons.slice(0, 4)) {
      L.push(`• ${escapeHtml(cut(r, 140))}`);
    }
  }

  // 시세 · 근거
  const priceLine = m.priceLine || (m.perp && m.perp.priceLine) || d.priceLine || '';
  L.push('');
  if (priceLine) L.push(`시세 ${escapeHtml(cut(priceLine, 180))}`);
  const rationale = d.rationale || d.bubble || '';
  if (rationale) L.push(`근거 ${escapeHtml(cut(rationale, 600))}`);

  const rl = reportLine(d, cfg);
  if (rl) {
    L.push('');
    L.push(rl);
  }

  L.push('');
  L.push(TAIL);
  return L.join('\n');
}

async function sendDecision(decision, market, cfg) {
  const c = normalizeCfg(cfg);
  if (!isEnabled(c)) return { ok: false, error: '텔레그램 비활성' };
  let html;
  try {
    html = buildDecisionHtml(decision, market, c);
  } catch (e) {
    // 메시지 조립에서 죽는 일이 없도록 최후 방어.
    console.error('[notify] 판정 메시지 조립 실패:', e && e.message ? e.message : e);
    return { ok: false, error: '메시지 조립 실패' };
  }
  return sendMessage(html, c);
}

// --- 급변동 알림 --------------------------------------------------------

const SEV_ICON = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };
const KIND_LABEL = {
  move: '급변동',
  volume: '거래량 급증',
  funding: '펀딩비 이상',
  premium: '괴리 확대',
};

function buildAlertHtml(alert) {
  const a = alert && typeof alert === 'object' ? alert : {};
  const sev = String(a.severity || 'info').toLowerCase();
  const icon = SEV_ICON[sev] || 'ℹ️';
  const kind = KIND_LABEL[String(a.kind || '').toLowerCase()] || '감시 알림';
  const name = String(a.display || a.symbol || '-');

  const L = [];
  L.push(`${icon} <b>${escapeHtml(kind)}</b> · ${escapeHtml(name)}`);
  if (a.message) L.push(escapeHtml(cut(a.message, 200)));
  const priceTxt = a.priceText || (a.price != null ? fmtNum(a.price) : null);
  if (priceTxt) L.push(`현재가 ${escapeHtml(String(priceTxt))}`);
  const t = hhmmKst(a.ts);
  if (t) L.push(`${escapeHtml(t)} 기준`);
  L.push('');
  L.push(TAIL);
  return L.join('\n');
}

async function sendAlert(alert, cfg) {
  const c = normalizeCfg(cfg);
  if (!isEnabled(c)) return { ok: false, error: '텔레그램 비활성' };
  let html;
  try {
    html = buildAlertHtml(alert);
  } catch (e) {
    console.error('[notify] 알림 메시지 조립 실패:', e && e.message ? e.message : e);
    return { ok: false, error: '메시지 조립 실패' };
  }
  return sendMessage(html, c);
}

// 테스트 전용 — fetch 를 갈아끼운다. 인자 없이 부르면 원복.
function _setFetch(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (...args) => fetch(...args);
}

module.exports = {
  sendMessage,
  sendDecision,
  sendAlert,
  isEnabled,
  // 계약 외 부가 export — 통합·테스트 편의용(제거해도 계약은 유지된다)
  escapeHtml,
  buildDecisionHtml,
  buildAlertHtml,
  _setFetch,
};
