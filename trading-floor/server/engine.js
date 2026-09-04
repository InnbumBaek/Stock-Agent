'use strict';

// PIXEL TRADING FLOOR — 분석 엔진
// 티커 입력 → 시장 데이터 수집 → 애널리스트 4명 병렬 분석 → BULL/BEAR 토론 4턴
// → ACE 최종 판정 → 리포트 저장. 모든 단계를 'event' 이벤트로 방송하고
// history 배열에 누적해 새 SSE 구독자에게 replay 한다.

const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { resolveSymbol, fetchMarket } = require('./market');
const { AGENTS, runAgent, checkClaudeAvailable } = require('./agents');

// 원장 실측이 있어야만 의미가 있는 역할. 실측이 없으면 명단에서 뺀다 —
// 볼 것이 없는 에이전트를 돌리면 opus 콜만 태우고 "데이터 없음"만 돌아온다.
// (코인·해외주식 런의 비용이 통합 이전과 같아야 한다)
const KI_ONLY_IDS = new Set(AGENTS.filter((a) => a.requiresKi).map((a) => a.id));

function filterByKi(ids, market) {
  const hasKi = !!(market && market.ki && market.krCode);
  if (hasKi) return ids.slice();
  return ids.filter((id) => !KI_ONLY_IDS.has(id));
}

// FLOW·FILING 은 원장 실측이 있어야 볼 것이 있다. 없으면 아래 filterByKi 가 뺀다.
const ANALYST_IDS = ['taro', 'diana', 'flow', 'filing', 'nova', 'vibe'];
const DEBATE_ORDER = ['bull', 'bear', 'bull', 'bear'];
const SCALP_ORDER = ['blitz', 'guard']; // 순차: guard는 blitz 결과를 받음

// 모드별 파이프라인 구성
// - algo  : 논문(TradingAgents) 파이프라인 그대로 — 애널리스트 4 → 토론 4턴 → ACE (스캘핑 없음)
// - scalp : 탭비트 20배 단타 — 기술·심리 2명 → BLITZ → GUARD → ACE (토론 없음, 빠름)
// - attack: scalp와 같은 파이프라인이되 PASS/HOLD 금지 — 반드시 LONG 또는 SHORT가 나온다.
//           (연출·시연용. 관망이라는 선택지를 없애는 것이므로 리스크 고지는 그대로 유지한다.)
// 리스크 위원회 — 순차. 뒤에 오는 심사자가 앞의 의견을 받아 반박한다.
// (논문의 Risk Management team: 공격적/보수적이 먼저 붙고 중립이 중재한다)
// RED 는 계획이 아니라 계획이 딛고 선 가정을 심문한다. NEUTRAL 이 그 지적까지 중재하도록
// 마지막 바로 앞에 둔다.
const RISK_ORDER = ['risky', 'safe', 'red', 'neutral'];

const MODES = {
  algo: {
    analysts: ANALYST_IDS,
    debate: DEBATE_ORDER,
    scalp: [],
    risk: RISK_ORDER, // ACE 1차 판정 → 리스크 위원회 → PM 최종 승인
    pm: true,
  },
  scalp: { analysts: ['taro', 'vibe'], debate: [], scalp: SCALP_ORDER, risk: [], pm: false },
  attack: { analysts: ['taro', 'vibe'], debate: [], scalp: SCALP_ORDER, risk: [], pm: false },
};
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// 리스크 게이트 보조
// riskmath.js / config.js / positions.js 는 v2에서 새로 붙는 모듈이라 아직 없을 수
// 있다. 없으면 조용히 기능만 꺼지고 v1.2 파이프라인이 그대로 돈다(하위호환).
// ---------------------------------------------------------------------------

// config.js가 없을 때 쓰는 리스크 기본값 (docs/v2-contracts.md의 DEFAULTS.risk와 동일)
const RISK_FALLBACK = Object.freeze({
  minRR: 1.5,
  accountRiskPct: 2.0,
  accountSize: 0,
  leverage: 20,
  maintenanceMarginPct: 0.5,
});

// 아직 없을 수 있는 모듈을 조용히 불러온다. 실패는 null.
function optionalModule(rel) {
  try {
    const m = require(rel);
    return m && typeof m === 'object' ? m : null;
  } catch (_) {
    return null; // 모듈이 아직 없거나 로드 실패 — 해당 기능만 끈다
  }
}

// 전체 설정과 risk 섹션을 함께 돌려준다. config.js가 없으면 기본값으로 채운다.
function loadRiskConfig() {
  const mod = optionalModule('./config');
  let full = null;
  try {
    if (mod && typeof mod.loadConfig === 'function') {
      const cfg = mod.loadConfig();
      if (cfg && typeof cfg === 'object') full = cfg;
    }
  } catch (e) {
    console.error('[risk] 설정 로드 실패 — 기본값을 씁니다:', e && e.message ? e.message : e);
    full = null;
  }
  const risk = { ...RISK_FALLBACK };
  const patch = full && full.risk && typeof full.risk === 'object' ? full.risk : null;
  if (patch) {
    for (const k of Object.keys(RISK_FALLBACK)) {
      if (Number.isFinite(patch[k])) risk[k] = patch[k];
    }
  }
  return { full: full || { risk }, risk };
}

// 사람이 읽는 가격 표기. 값이 없으면 null(호출부에서 "데이터 없음" 처리)
function fmtPrice(v) {
  if (!Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  const [int, frac] = v.toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return '데이터 없음';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

// riskmath.positionSize 결과를 한 줄 한국어로. 값이 없으면 빈 문자열.
function formatSizingLine(sizing) {
  if (!sizing || typeof sizing !== 'object') return '';
  const bits = [];
  if (Number.isFinite(sizing.notionalPctOfAccount)) {
    bits.push(`계좌 대비 명목 ${sizing.notionalPctOfAccount}%`);
  }
  if (Number.isFinite(sizing.marginPctOfAccount)) {
    bits.push(`증거금 비중 ${sizing.marginPctOfAccount}%`);
  }
  if (Number.isFinite(sizing.qty)) bits.push(`수량 ${fmtPrice(sizing.qty)}`);
  if (Number.isFinite(sizing.notional)) bits.push(`명목 ${fmtPrice(sizing.notional)}`);
  if (Number.isFinite(sizing.marginRequired)) bits.push(`증거금 ${fmtPrice(sizing.marginRequired)}`);
  if (Number.isFinite(sizing.riskAmount)) bits.push(`허용 손실 ${fmtPrice(sizing.riskAmount)}`);
  if (!bits.length && typeof sizing.sizingNote === 'string' && sizing.sizingNote) {
    return sizing.sizingNote;
  }
  return bits.join(' · ');
}

function actionToSide(action) {
  const a = String(action || '').toUpperCase().trim();
  if (a === 'BUY') return 'LONG';
  if (a === 'SELL') return 'SHORT';
  return null;
}

function biasToSide(bias) {
  const b = String(bias || '').toUpperCase().trim();
  return b === 'LONG' || b === 'SHORT' ? b : null;
}

// 관망(HOLD/PASS) 판정이라도 레벨 숫자만으로 방향을 유추해 손익비를 참고 계산한다.
// 숫자가 없거나 방향이 모순되면 null.
function inferSideFromLevels(rm, entry, stop, target) {
  if (!rm || typeof rm.parsePrice !== 'function') return null;
  try {
    const e = rm.parsePrice(entry == null ? '' : String(entry));
    const s = rm.parsePrice(stop == null ? '' : String(stop));
    const t = rm.parsePrice(target == null ? '' : String(target));
    if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(t)) return null;
    if (t > e && s < e) return 'LONG';
    if (t < e && s > e) return 'SHORT';
    return null;
  } catch (_) {
    return null;
  }
}

// AGENTS(배열 또는 객체) → id 로 메타를 찾을 수 있는 조회 함수
function buildAgentMeta() {
  const map = {};
  if (Array.isArray(AGENTS)) {
    for (const a of AGENTS) {
      if (a && a.id) map[a.id] = a;
    }
  } else if (AGENTS && typeof AGENTS === 'object') {
    for (const key of Object.keys(AGENTS)) {
      const a = AGENTS[key];
      if (a && typeof a === 'object') map[a.id || key] = a;
    }
  }
  return map;
}

const AGENT_META = buildAgentMeta();

function metaLabel(id) {
  const m = AGENT_META[id];
  const name = (m && (m.name || m.nameKo)) || id.toUpperCase();
  const role = (m && (m.role || m.roomKo)) || '';
  return role ? `${name} (${role})` : name;
}

class Engine extends EventEmitter {
  constructor() {
    super();
    // 다수의 SSE 구독자가 리스너를 붙이므로 상한 경고를 끈다.
    this.setMaxListeners(0);
    this.history = [];
    this.running = false;
  }

  // history 에 누적하면서 실시간 방송
  _emit(evt) {
    this.history.push(evt);
    this.emit('event', evt);
  }

  // 콘솔용 로그 한 줄. kind: 'sys' | 'news' | 'stage'
  _log(line, kind = 'sys') {
    if (!line) return;
    this._emit({ type: 'log', kind, line: String(line) });
  }

  // 과거 판정 회고(reflection) — decisions.json에서 같은 심볼 최근 3건을 읽고
  // 그 이후 가격이 어떻게 흘렀는지 일봉으로 계산해 문장으로 만든다.
  // 어떤 이유로 실패해도 런을 죽이지 않는다(회고는 부가 기능).
  async _buildMemory(resolved, market) {
    try {
      const raw = await fsp.readFile(path.join(REPORTS_DIR, 'decisions.json'), 'utf8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      const display = String(resolved.display);
      const past = arr
        .filter((d) => d && String(d.symbol) === display && d.ts)
        .slice(-3);
      if (!past.length) return null;

      const candles = Array.isArray(market && market.candles) ? market.candles : [];
      const nowPrice =
        (market && market.indicators && market.indicators.price) ||
        (candles.length ? candles[candles.length - 1].c : null);

      const out = past.map((d) => {
        const when = String(d.ts).slice(0, 16).replace('T', ' ');
        const head =
          `${when} · ${d.mode || 'algo'} · ${d.action || '-'}` +
          (d.confidence != null ? `(${d.confidence}%)` : '') +
          (d.scalpBias ? ` · 스캘핑 ${d.scalpBias}` : '');
        const then = Date.parse(d.ts);
        // 판정 시각 이후의 첫 일봉 종가를 기준으로 현재까지의 변화율
        const after = candles.filter((c) => c && c.t >= then);
        if (!Number.isFinite(then) || after.length < 2 || nowPrice == null) {
          return `${head} → 이후 흐름 데이터 부족`;
        }
        const base = after[0].c;
        if (!base) return `${head} → 이후 흐름 데이터 부족`;
        const pct = ((nowPrice - base) / base) * 100;
        const days = Math.max(1, Math.round((Date.now() - then) / 86400000));
        return `${head} → 이후 ${days}일간 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      });
      return out.length ? out : null;
    } catch (_) {
      return null;
    }
  }

  // GUARD·SAFE에게 넣어줄 청산 계산 컨텍스트.
  // riskmath.js가 없거나 기준가를 못 구하면 null(프롬프트에 아무것도 붙지 않는다).
  // plan을 주면 그 진입가 기준 청산가도 함께 계산한다(리스크 위원회용).
  _buildRiskInfo(market, plan) {
    const rm = optionalModule('./riskmath');
    if (!rm || typeof rm.liquidationPrice !== 'function') return null;
    const { risk } = loadRiskConfig();

    // 한국주식은 실제 체결이 일어나는 USDT 무기한을 기준가로 쓴다(CLAUDE.md 이중 가격 체계).
    const perpPrice =
      market && market.perp && market.perp.indicators ? market.perp.indicators.price : null;
    const usePerp = Number.isFinite(perpPrice);
    const spotPrice = market && market.indicators ? market.indicators.price : null;
    const price = usePerp ? perpPrice : Number.isFinite(spotPrice) ? spotPrice : null;
    if (!Number.isFinite(price)) return null;

    const args = { leverage: risk.leverage, maintenanceMarginPct: risk.maintenanceMarginPct };
    let longLiq = null;
    let shortLiq = null;
    try {
      const l = rm.liquidationPrice({ entry: price, side: 'LONG', ...args });
      const s = rm.liquidationPrice({ entry: price, side: 'SHORT', ...args });
      longLiq = Number.isFinite(l) ? l : null;
      shortLiq = Number.isFinite(s) ? s : null;
    } catch (e) {
      console.error('[risk] 청산가 계산 실패:', e && e.message ? e.message : e);
      return null;
    }
    if (longLiq == null && shortLiq == null) return null;

    const info = {
      price,
      source: usePerp ? '체결 차트(USDT 무기한)' : '정규장',
      leverage: risk.leverage,
      maintenanceMarginPct: risk.maintenanceMarginPct,
      longLiq,
      shortLiq,
      longBufferPct: longLiq != null ? ((longLiq - price) / price) * 100 : null,
      shortBufferPct: shortLiq != null ? ((shortLiq - price) / price) * 100 : null,
      lines: [],
    };
    info.lines.push(`기준가 ${fmtPrice(price)} — ${info.source}`);
    if (longLiq != null) {
      info.lines.push(
        `${risk.leverage}배 격리로 롱 진입 시 청산가 ${fmtPrice(longLiq)} (기준가 대비 ${fmtPct(info.longBufferPct)})`
      );
    }
    if (shortLiq != null) {
      info.lines.push(
        `${risk.leverage}배 격리로 숏 진입 시 청산가 ${fmtPrice(shortLiq)} (기준가 대비 ${fmtPct(info.shortBufferPct)})`
      );
    }
    info.lines.push(
      `유지증거금률 ${risk.maintenanceMarginPct}% 가정. 손절은 반드시 이 청산 버퍼 안쪽에 둬야 한다.`
    );

    // 트레이더 계획이 있으면 그 진입가 기준 청산까지 거리도 함께 준다(SAFE 등 리스크 위원회용)
    if (plan && typeof plan === 'object') {
      const side = actionToSide(plan.action) || biasToSide(plan.scalp && plan.scalp.bias);
      let entry = null;
      try {
        entry =
          typeof rm.parsePrice === 'function'
            ? rm.parsePrice(plan.entry == null ? '' : String(plan.entry))
            : null;
      } catch (_) {
        entry = null;
      }
      if (side && Number.isFinite(entry) && entry > 0) {
        let liq = null;
        try {
          const v = rm.liquidationPrice({ entry, side, ...args });
          liq = Number.isFinite(v) ? v : null;
        } catch (_) {
          liq = null;
        }
        if (liq != null) {
          info.planEntry = entry;
          info.planSide = side;
          info.planLiq = liq;
          info.planLiqDistPct = ((liq - entry) / entry) * 100;
          info.lines.push(
            `트레이더 계획(${side} · 진입 ${fmtPrice(entry)}) 기준 청산가 ${fmtPrice(liq)} ` +
              `(진입 대비 ${fmtPct(info.planLiqDistPct)})`
          );
        }
      }
    }
    return info;
  }

  // 리스크 게이트 — 최종 판정이 확정된 직후, 저장 전에 부른다.
  // riskmath.js가 없거나 evaluatePlan이 깨지면 null을 돌려주고 엔진은 게이트를 건너뛴다.
  // 평가 대상: 알고리즘 모드는 스윙 레벨(entry/stop/target), 스캘핑·공격 모드는 scalp 레벨.
  _runRiskGate(mode, decision, market) {
    const rm = optionalModule('./riskmath');
    if (!rm || typeof rm.evaluatePlan !== 'function') return null;
    const { risk } = loadRiskConfig();

    const scope = mode === 'algo' ? 'swing' : 'scalp';
    const src = scope === 'scalp' ? decision.scalp || {} : decision;
    const declaredSide =
      scope === 'scalp' ? biasToSide(src.bias) : actionToSide(decision.action);
    const side = declaredSide || inferSideFromLevels(rm, src.entry, src.stop, src.target);

    const gate = {
      scope,
      side,
      declared: !!declaredSide, // 실제 방향성 판정인지(관망이면 false)
      minRR: risk.minRR,
      rr: null,
      ok: true,
      downgrade: false,
      liq: null,
      stopBeyondLiq: false,
      reasons: [],
      downgradeReasons: [], // 그중 강등을 유발한 사유만 — rationale 접두어에 쓴다
      sizing: null,
    };

    if (!side) {
      gate.reasons.push(
        '방향성 판정이 아니고 레벨 숫자로도 방향을 유추할 수 없어 손익비를 계산하지 않았습니다.'
      );
      return gate;
    }

    // 레버리지는 '실제로 레버리지를 쓰는 축'에만 적용한다.
    // algo(스윙)는 무레버리지·KRX 정규장 판정이므로 20배 청산가를 들이대면
    // 손절이 -4.75%보다 넓은 정상적인 중장기 셋업이 전부 "청산 위험"으로 기각된다.
    // (CLAUDE.md의 이중 가격 체계 경고와 같은 함정이다)
    const gateLeverage = scope === 'scalp' ? risk.leverage : 1;
    gate.leverage = gateLeverage;

    let res = null;
    try {
      res = rm.evaluatePlan(
        {
          entry: src.entry,
          stop: src.stop,
          target: src.target,
          side,
          mode,
          scope,
          leverage: gateLeverage,
          symbol: market && market.symbol,
          display: market && market.display,
        },
        { ...risk, leverage: gateLeverage }
      );
    } catch (e) {
      console.error('[risk] evaluatePlan 실패 — 게이트를 건너뜁니다:', e && e.message ? e.message : e);
      return null;
    }
    if (!res || typeof res !== 'object') return null;

    gate.rr = Number.isFinite(res.rr) ? res.rr : null;
    gate.liq = Number.isFinite(res.liq) ? res.liq : null;
    gate.stopBeyondLiq = res.stopBeyondLiq === true;
    gate.downgrade = res.downgrade === true;
    gate.ok = res.ok === true ? true : res.ok === false ? false : !gate.downgrade;
    gate.sizing = res.sizing && typeof res.sizing === 'object' ? res.sizing : null;
    gate.reasons = Array.isArray(res.reasons)
      ? res.reasons.filter(Boolean).map((r) => String(r))
      : [];
    // riskmath가 강등 사유만 따로 주면 그것을 쓴다(사이징 안내 같은 정보성 문구가
    // rationale 접두어에 섞여 들어가지 않게 한다). 없으면 전체 사유로 폴백.
    gate.downgradeReasons = Array.isArray(res.downgradeReasons)
      ? res.downgradeReasons.filter(Boolean).map((r) => String(r))
      : [];
    if (!gate.downgradeReasons.length && gate.downgrade) gate.downgradeReasons = gate.reasons.slice();

    // 이미 관망인 판정은 강등할 것이 없다 — 손익비는 참고 수치로만 남긴다.
    if (!gate.declared) {
      gate.downgrade = false;
      gate.reasons.push('관망(HOLD/PASS) 판정이라 리스크 게이트는 참고용으로만 계산했습니다.');
    }
    return gate;
  }

  async run(symbolInput, opts = {}) {
    if (this.running) {
      const err = new Error('이미 분석이 진행 중입니다.');
      err.code = 409;
      throw err;
    }
    this.running = true;
    this.history = []; // run:start 시점에 히스토리 리셋

    const mock = !!opts.mock;
    const mode = MODES[opts.mode] ? opts.mode : 'algo';
    const plan = MODES[mode];
    let resolved = null;
    let market = null;
    const analystResults = []; // [{id, name, bubble, report}] — 렌더/저장용
    const analystReports = {}; // {taro,diana,nova,vibe: reportString} — agents.js 프롬프트 주입용
    const debateLog = [];
    const scalpResults = []; // [{id, name, bubble, report}] — 스캘핑 데스크 렌더/저장용
    const scalpReports = {}; // {blitz, guard: reportString} — agents.js 프롬프트 주입용
    const riskResults = []; // [{id, name, bubble, report}] — 리스크 위원회 렌더/저장용
    const riskReports = {}; // {risky, safe, neutral: reportString}
    let memory = null; // 과거 판정 회고
    let pmResult = null; // 포트폴리오 매니저 결과
    let decision = null;

    try {
      resolved = resolveSymbol(symbolInput);
      this._emit({
        type: 'run:start',
        symbol: resolved.symbol,
        display: resolved.display,
        mock,
        mode,
      });

      // 0) 실전 런이면 claude CLI 가용성부터 확인 — 없으면 즉시 중단하고 원인을 알린다
      //    (13명을 헛돌린 뒤 "파싱 실패"만 남는 상황을 막는다)
      if (!mock) {
        const chk = await checkClaudeAvailable();
        if (!chk.ok) {
          this._log('> claude 점검 실패', 'stage');
          throw new Error(
            'claude CLI를 사용할 수 없습니다. ' + chk.message +
            ' (데모 모드 ?demo=1 는 클로드 없이 동작합니다)'
          );
        }
        this._log(`> claude 확인됨 (${chk.message})`);
      }

      // 1) 시장 데이터
      this._log(`> Fetching ${resolved.display} data...`);
      market = await fetchMarket(resolved);
      const candles = (Array.isArray(market.candles) ? market.candles : [])
        .slice(-120)
        .map((c) => ({ t: c.t, c: c.c }));
      this._emit({
        type: 'market',
        priceLine: market.priceLine,
        candles,
        display: resolved.display,
        kind: resolved.kind,
      });

      // 콘솔 중계용 로그 — 수집 결과를 사람이 읽는 순서대로 흘린다
      this._log('> 실시간 시세 수신 완료');
      if (market.priceLine) this._log(`> ${market.priceLine}`);
      for (const l of (market.indicators && market.indicators.summaryLines) || []) {
        this._log(`> ${l}`);
      }
      if (market.perp && market.perp.priceLine) {
        this._log(`> [무기한] ${market.perp.priceLine}`);
      }
      for (const l of (market.intraday && market.intraday.summaryLines) || []) {
        this._log(`> ${l}`);
      }
      for (const h of ((market.news && market.news.headlines) || []).slice(0, 6)) {
        this._log(`${h.title}${h.age ? ` (${h.age})` : ''}`, 'news');
      }

      // 과거 판정 회고(있으면 ACE·PM 프롬프트에 주입)
      memory = await this._buildMemory(resolved, market);
      if (memory) {
        this._log('── 과거 판정 회고 ──', 'stage');
        for (const l of memory) this._log(`> ${l}`);
      }

      // 청산 계산 컨텍스트 — GUARD가 청산가를 지어내지 않도록 엔진이 계산해 넣어준다.
      // riskmath.js가 없으면 null이고 프롬프트는 기존 그대로다.
      const riskInfo = this._buildRiskInfo(market, null);

      // 2) 애널리스트 병렬 (Promise.allSettled) — 모드별 인원
      this._log('── 애널리스트 팀 분석 ──', 'stage');
      const analystIds = filterByKi(plan.analysts, market);
      const skipped = plan.analysts.filter((id) => !analystIds.includes(id));
      if (skipped.length) {
        this._log(
          `> 원장 실측이 없어 ${skipped.map(metaLabel).join('·')} 는 건너뜁니다`,
          'sys'
        );
      }
      const tasks = analystIds.map(async (id) => {
        this._emit({ type: 'agent:start', id });
        try {
          const res = await runAgent(id, { market, mode }, { mock });
          this._emit({
            type: 'agent:done',
            id,
            bubble: res.bubble,
            report: res.report,
          });
          return { id, name: metaLabel(id), bubble: res.bubble, report: res.report };
        } catch (e) {
          const bubble = '분석 실패';
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id, bubble, report });
          return { id, name: metaLabel(id), bubble, report };
        }
      });
      const settled = await Promise.allSettled(tasks);
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) {
          analystResults.push(s.value);
          analystReports[s.value.id] = s.value.report;
        }
      }

      // 3) BULL/BEAR 토론 순차 (algo 모드: bull→bear→bull→bear, scalp 모드: 생략)
      if (plan.debate.length) this._log('── 리서치 토론 (BULL vs BEAR) ──', 'stage');
      for (let i = 0; i < plan.debate.length; i++) {
        const id = plan.debate[i];
        const turn = i + 1;
        this._emit({ type: 'agent:start', id, turn });
        const res = await runAgent(
          id,
          { market, analystReports, debateLog, mode },
          { mock }
        );
        this._emit({
          type: 'agent:done',
          id,
          turn,
          bubble: res.bubble,
          report: res.report,
        });
        debateLog.push({
          id,
          turn,
          name: metaLabel(id),
          bubble: res.bubble,
          report: res.report,
        });
      }

      // 3.5) 스캘핑 데스크 (scalp 모드 전용: blitz → guard 순차, guard는 blitz 리포트를 받음)
      // 실패 정책: 애널리스트와 동일하게 '분석 실패'로 계속 진행한다.
      if (plan.scalp.length) this._log('── 스캘핑 데스크 (20x) ──', 'stage');
      for (const id of plan.scalp) {
        this._emit({ type: 'agent:start', id });
        try {
          const res = await runAgent(
            id,
            { market, analystReports, debateLog, scalpReports, riskInfo, mode },
            { mock }
          );
          this._emit({
            type: 'agent:done',
            id,
            bubble: res.bubble,
            report: res.report,
          });
          scalpReports[id] = res.report;
          scalpResults.push({
            id,
            name: metaLabel(id),
            bubble: res.bubble,
            report: res.report,
          });
        } catch (e) {
          const bubble = '분석 실패';
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id, bubble, report });
          scalpReports[id] = report;
          scalpResults.push({ id, name: metaLabel(id), bubble, report });
        }
      }

      // 4) ACE 판정 (algo 모드에서는 1차 계획 — 뒤에 리스크 위원회·PM 심사가 붙는다)
      this._log(
        plan.pm ? '── 수석 트레이더 1차 판정 ──' : '── 최종 판정 ──',
        'stage'
      );
      this._emit({ type: 'agent:start', id: 'ace' });
      const dec = await runAgent(
        'ace',
        { market, analystReports, debateLog, scalpReports, memory, mode },
        { mock }
      );
      this._emit({
        type: 'agent:done',
        id: 'ace',
        bubble: dec.bubble,
        report: dec.report,
      });

      // 4.5) 리스크 위원회 (algo 모드 전용) — ACE 1차 계획을 성향별로 심사하고 서로 반박
      const traderPlan = {
        action: dec.action,
        confidence: dec.confidence,
        entry: dec.entry,
        stop: dec.stop,
        target: dec.target,
        rationale: dec.rationale,
        scalp: dec.scalp,
      };
      // 리스크 위원회는 트레이더 계획의 진입가 기준 청산가까지 함께 본다.
      const riskIds = filterByKi(plan.risk, market);
      const riskInfoPlan = riskIds.length ? this._buildRiskInfo(market, traderPlan) : null;
      if (riskIds.length) this._log('── 리스크 위원회 심사 ──', 'stage');
      for (const id of riskIds) {
        this._emit({ type: 'agent:start', id });
        try {
          const res = await runAgent(
            id,
            {
              market,
              analystReports,
              debateLog,
              traderPlan,
              riskReports,
              riskInfo: riskInfoPlan,
              mode,
            },
            { mock }
          );
          this._emit({ type: 'agent:done', id, bubble: res.bubble, report: res.report });
          riskReports[id] = res.report;
          riskResults.push({ id, name: metaLabel(id), bubble: res.bubble, report: res.report });
        } catch (e) {
          const bubble = '분석 실패';
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id, bubble, report });
          riskReports[id] = report;
          riskResults.push({ id, name: metaLabel(id), bubble, report });
        }
      }

      // 4.6) 포트폴리오 매니저 최종 승인 (algo 모드 전용)
      // PM이 실패하면 ACE 판정을 그대로 최종으로 쓰고 그 사실을 리포트에 남긴다.
      if (plan.pm) {
        this._log('── 포트폴리오 매니저 최종 승인 ──', 'stage');
        this._emit({ type: 'agent:start', id: 'pm' });
        try {
          const res = await runAgent(
            'pm',
            { market, analystReports, debateLog, traderPlan, riskReports, memory, mode },
            { mock }
          );
          this._emit({ type: 'agent:done', id: 'pm', bubble: res.bubble, report: res.report });
          pmResult = {
            name: metaLabel('pm'),
            bubble: res.bubble,
            report: res.report,
            verdict: String(res.verdict || 'APPROVE').toUpperCase(),
            action: res.action,
            confidence: res.confidence,
            entry: res.entry,
            stop: res.stop,
            target: res.target,
            sizing: res.sizing || '',
            rationale: res.rationale || '',
          };
        } catch (e) {
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id: 'pm', bubble: '승인 절차 실패', report });
          pmResult = { failed: true, name: metaLabel('pm'), bubble: '승인 절차 실패', report };
        }
      }

      // 공격 모드에서 모델이 그래도 PASS를 뱉으면, 방향을 강제한다는 모드의 계약이
      // 깨진다. 기술 지표(SMA20 대비 위치)로 우위 쪽을 골라 채워 넣는다.
      const forceBias = () => {
        const i = (market && market.perp && market.perp.indicators) ||
          (market && market.indicators) || {};
        if (i.price != null && i.sma20 != null) return i.price >= i.sma20 ? 'LONG' : 'SHORT';
        return (i.changePct24h || 0) >= 0 ? 'LONG' : 'SHORT';
      };
      const attack = mode === 'attack';
      // scalp 판정은 스캘핑 데스크가 실제로 돈 모드에서만 채택한다
      // (mock ACE가 항상 scalp를 돌려줘도 algo 모드에서는 버린다)
      const scalp =
        plan.scalp.length > 0 && dec.scalp && typeof dec.scalp === 'object'
          ? {
              bias: (() => {
                const b = (dec.scalp.bias || 'PASS').toUpperCase();
                if (attack && b !== 'LONG' && b !== 'SHORT') return forceBias();
                return b;
              })(),
              entry: dec.scalp.entry != null ? dec.scalp.entry : '-',
              stop: dec.scalp.stop != null ? dec.scalp.stop : '-',
              target: dec.scalp.target != null ? dec.scalp.target : '-',
              note: dec.scalp.note != null ? dec.scalp.note : '',
            }
          : null;
      decision = {
        action: (() => {
          const a = (dec.action || 'HOLD').toUpperCase();
          // 공격 모드는 HOLD를 허용하지 않는다 — scalp 편향과 같은 쪽으로 정렬한다.
          if (attack && a !== 'BUY' && a !== 'SELL') {
            const b = (scalp && scalp.bias) || forceBias();
            return b === 'LONG' ? 'BUY' : 'SELL';
          }
          return a;
        })(),
        confidence:
          typeof dec.confidence === 'number'
            ? dec.confidence
            : Number(dec.confidence) || 0,
        entry: dec.entry != null ? dec.entry : '-',
        stop: dec.stop != null ? dec.stop : '-',
        target: dec.target != null ? dec.target : '-',
        rationale: dec.rationale != null ? dec.rationale : dec.report || '',
        report: dec.report != null ? dec.report : '',
        bubble: dec.bubble,
        scalp,
      };

      // 4.7) PM 판정을 최종 결정에 반영
      //  - APPROVE : ACE 계획 그대로
      //  - AMEND   : PM이 준 값으로 교체(빈 값은 ACE 값 유지)
      //  - REJECT  : action을 HOLD로 강제하고 기각 사유를 근거로
      if (pmResult && !pmResult.failed) {
        const v = pmResult.verdict;
        decision.verdict = v;
        if (pmResult.sizing) decision.sizing = pmResult.sizing;
        if (v === 'AMEND') {
          const a = String(pmResult.action || '').toUpperCase();
          if (['BUY', 'SELL', 'HOLD'].includes(a)) decision.action = a;
          if (typeof pmResult.confidence === 'number') decision.confidence = pmResult.confidence;
          if (pmResult.entry) decision.entry = pmResult.entry;
          if (pmResult.stop) decision.stop = pmResult.stop;
          if (pmResult.target) decision.target = pmResult.target;
          if (pmResult.rationale) {
            decision.rationale = `[PM 수정승인] ${pmResult.rationale}`;
          }
        } else if (v === 'REJECT') {
          decision.action = 'HOLD';
          decision.rationale = `[PM 기각] ${pmResult.rationale || '리스크 위원회 의견을 반영해 실행을 기각했습니다.'}`;
        } else if (pmResult.rationale) {
          decision.rationale = `${decision.rationale} [PM 승인] ${pmResult.rationale}`;
        }
      } else if (pmResult && pmResult.failed) {
        decision.verdict = 'PM_FAILED';
      }

      // 4.8) 리스크 게이트 — 손익비·청산·비중을 계산해 판정을 검증한다.
      //  - 미달(downgrade)이면 스윙은 HOLD, 스캘핑은 PASS로 강등한다.
      //  - 단, 공격 모드는 "방향 강제"가 모드의 계약이므로 강등하지 않고 경고만 남긴다.
      //  - riskmath.js가 없으면 gate가 null이고 v1.2 그대로 진행한다.
      const gate = this._runRiskGate(mode, decision, market);
      let downgraded = false;
      if (gate) {
        if (gate.downgrade) {
          gate.reasons.push(
            attack
              ? '공격 모드는 방향 강제가 계약이므로 강등하지 않고 경고만 남깁니다.'
              : decision.scalp
              ? '판정을 강등합니다 — 스윙 HOLD · 스캘핑 PASS.'
              : '스윙 판정을 HOLD로 강등합니다.'
          );
        }

        this._emit({
          type: 'risk',
          // --- 계약 필수 필드 ---
          rr: gate.rr,
          ok: gate.ok,
          reasons: gate.reasons.slice(),
          sizing: gate.sizing,
          // --- 부가 필드 (렌더·리포트 편의용, 없어도 무해) ---
          downgradeReasons: gate.downgradeReasons.slice(),
          scope: gate.scope,
          side: gate.side,
          liq: gate.liq,
          stopBeyondLiq: gate.stopBeyondLiq,
          downgrade: gate.downgrade,
          minRR: gate.minRR,
          mode,
        });

        this._log('── 리스크 게이트 ──', 'stage');
        this._log(
          `> 평가 대상: ${gate.scope === 'scalp' ? '스캘핑 레벨(레버리지 계약)' : '스윙 레벨'}` +
            ` · 방향 ${gate.side || '없음'}`
        );
        this._log(
          `> 손익비 ${gate.rr != null ? gate.rr.toFixed(2) : '데이터 없음'}` +
            ` (최소 ${gate.minRR}) · 청산가 ${fmtPrice(gate.liq) || '데이터 없음'}` +
            (gate.stopBeyondLiq ? ' · ⚠ 손절보다 청산이 먼저 온다' : '')
        );
        for (const r of gate.reasons) this._log(`> ${r}`);

        if (gate.downgrade) {
          const reasonText = gate.downgradeReasons.length
            ? gate.downgradeReasons.join(' · ')
            : '리스크 기준 미달';
          const base = decision.rationale ? ` ${decision.rationale}` : '';
          if (attack) {
            decision.rationale = `[리스크 경고] ${reasonText}${base}`;
          } else {
            downgraded = true;
            // 스윙과 스캘핑을 함께 내린다. 한쪽만 강등하면 "action BUY + scalp PASS" 같은
            // 모순이 남고, positions.js는 bias가 PASS면 action으로 방향을 되찾기 때문에
            // 강등된 판정으로 포지션이 열려버린다.
            if (decision.scalp) decision.scalp.bias = 'PASS';
            decision.action = 'HOLD';
            decision.rationale = `[리스크 게이트] ${reasonText}${base}`;
          }
        }

        decision.risk = gate;
        decision.rr = gate.rr;
        decision.riskOk = gate.ok;
        decision.riskReasons = gate.reasons;
        decision.riskScope = gate.scope;
        decision.riskSide = gate.side;
        decision.liq = gate.liq;
        decision.riskSizing = gate.sizing;
        decision.riskDowngraded = downgraded;
        // PM이 준 비중 문구가 있으면 그것을 우선한다(v1.2 표시를 덮지 않는다).
        const sizingLine = formatSizingLine(gate.sizing);
        if (!decision.sizing && sizingLine) decision.sizing = sizingLine;
      }

      const decisionEvt = {
        type: 'decision',
        action: decision.action,
        confidence: decision.confidence,
        entry: decision.entry,
        stop: decision.stop,
        target: decision.target,
        rationale: decision.rationale,
        report: decision.report,
      };
      if (decision.scalp) decisionEvt.scalp = decision.scalp;
      if (decision.verdict) decisionEvt.verdict = decision.verdict;
      if (decision.sizing) decisionEvt.sizing = decision.sizing;
      if (gate) {
        decisionEvt.rr = decision.rr;
        decisionEvt.riskOk = decision.riskOk;
        decisionEvt.riskReasons = decision.riskReasons;
        decisionEvt.liq = decision.liq;
        if (decision.riskSizing) decisionEvt.riskSizing = decision.riskSizing;
      }
      this._emit(decisionEvt);
      this._log(
        `>>> 최종 판정: ${decision.action} (${decision.confidence}%)` +
          (decision.verdict ? ` · PM ${decision.verdict}` : ''),
        'stage'
      );

      // 4.9) 가상 포지션 — 강등되지 않은 방향성 판정이면 장부에만 기록한다(실주문 없음).
      //      positions.js가 없으면 아무 일도 하지 않는다.
      //      공격 모드는 방향을 강등하지 않지만(모드의 계약), 리스크 게이트가 스스로
      //      불합격시킨 계획까지 장부에 쌓이면 성적표 통계가 오염된다. 그래서 게이트
      //      결과를 포지션에 표시해 stats가 표본에서 제외할 수 있게 한다.
      if (!downgraded) {
        const posMod = optionalModule('./positions');
        if (posMod && typeof posMod.openFromDecision === 'function') {
          try {
            const { full } = loadRiskConfig();
            const gateFailed = !!(gate && gate.downgrade);
            const opened = await posMod.openFromDecision(decision, market, full, {
              mode,
              gateFailed,
            });
            if (opened) {
              this._emit({ type: 'position', action: 'open', position: opened });
              this._log(
                `> 가상 포지션 오픈: ${opened.display || opened.symbol || ''} ${opened.side || ''}` +
                  ` @ ${fmtPrice(opened.entry) || opened.entry}`
              );
            }
          } catch (e) {
            console.error('[positions] 가상 포지션 오픈 실패:', e && e.message ? e.message : e);
          }
        }
      }

      // 5) 저장
      const savedPath = await this._save(
        resolved,
        market,
        mock,
        mode,
        analystResults,
        debateLog,
        scalpResults,
        riskResults,
        pmResult,
        memory,
        decision
      );
      this._emit({ type: 'saved', path: savedPath });
    } catch (err) {
      this._emit({
        type: 'run:error',
        message: err && err.message ? err.message : String(err),
      });
    } finally {
      this._emit({ type: 'run:end' });
      this.running = false;
    }
  }

  // 리포트(.md) + decisions.json 저장. 반환: 방송용 상대 경로
  async _save(resolved, market, mock, mode, analystResults, debateLog, scalpResults, riskResults, pmResult, memory, decision) {
    await fsp.mkdir(REPORTS_DIR, { recursive: true });

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
      now.getDate()
    )}`;
    const hhmm = `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const safeDisplay =
      String(resolved.display).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) ||
      'SYMBOL';
    const fname = `${dateStr}-${safeDisplay}-${hhmm}.md`;
    const fullPath = path.join(REPORTS_DIR, fname);

    const md = this._renderMarkdown(
      resolved,
      market,
      mock,
      mode,
      analystResults,
      debateLog,
      scalpResults,
      riskResults,
      pmResult,
      memory,
      decision,
      now
    );
    await fsp.writeFile(fullPath, md, 'utf8');

    // 기계판독용 사이드카 — 같은 이름의 .json (계약: ../docs/integration.md, floor.run/1)
    //
    // 마크다운은 사람이 읽는 것이다. 주가 모니터링 리포트(HTML)에 이 런을 실으려면
    // 구조화된 값이 필요한데, 마크다운을 되파싱하는 방식은 서식이 조금만 바뀌어도
    // 조용히 깨진다. 그래서 같은 재료로 JSON 을 한 벌 더 쓴다.
    //
    // .md 는 이미 저장됐다. 사이드카가 실패해도 런을 깨지 않는다.
    try {
      const record = this._runRecord(resolved, market, mock, mode, fname, analystResults,
        debateLog, scalpResults, riskResults, pmResult, memory, decision, now);
      await fsp.writeFile(
        fullPath.replace(/\.md$/, '.json'),
        JSON.stringify(record, null, 2),
        'utf8'
      );
    } catch (e) {
      console.error('[engine] 사이드카 JSON 저장 실패:', e && e.message ? e.message : e);
    }

    // decisions.json append
    const decPath = path.join(REPORTS_DIR, 'decisions.json');
    let arr = [];
    try {
      const raw = await fsp.readFile(decPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch (_) {
      arr = [];
    }
    arr.push({
      ts: now.toISOString(),
      symbol: resolved.display,
      mode,
      action: decision.action,
      confidence: decision.confidence,
      verdict: decision.verdict || null,
      scalpBias:
        decision.scalp && decision.scalp.bias
          ? String(decision.scalp.bias).toUpperCase()
          : null,
      // 리스크 게이트 결과 — 게이트가 없거나 계산 불가면 null (0으로 위장하지 않는다)
      rr: Number.isFinite(decision.rr) ? decision.rr : null,
      riskOk: typeof decision.riskOk === 'boolean' ? decision.riskOk : null,
    });
    await fsp.writeFile(decPath, JSON.stringify(arr, null, 2), 'utf8');

    return `reports/${fname}`;
  }

  // 런 한 건을 기계가 읽을 수 있는 모양으로 만든다 (floor.run/1).
  //
  // 원칙 — 마크다운과 같은 재료만 쓴다. 여기서 새로 계산하거나 요약하지 않는다.
  // 없는 값은 null 이다. 빈 문자열이나 0 으로 위장하지 않는다.
  _runRecord(resolved, market, mock, mode, fname, analystResults, debateLog,
             scalpResults, riskResults, pmResult, memory, decision, now) {
    const cast = (r) => ({
      id: r.id || null,
      name: r.name || null,
      bubble: r.bubble || null,
      report: r.report || null,
    });

    // 이 런이 참고한 주가 모니터링 원장의 기준일 (있을 때만).
    // 리포트에 "언제 시점의 실측을 보고 판단했는가"를 남기기 위한 것이다.
    let kiAsOf = null;
    try {
      const code = market && market.krCode;
      const s = code && market.ki && market.ki.stocks ? market.ki.stocks[code] : null;
      if (s && s.as_of) kiAsOf = s.as_of;
    } catch (_) {
      kiAsOf = null;
    }

    const d = decision || {};
    return {
      schema: 'floor.run/1',
      ts: now.toISOString(),
      symbol: resolved.symbol,
      display: resolved.display,
      kind: resolved.kind,
      // KR_STOCKS 밖 종목은 코드만 들고 오므로 이름이 없다. 수집 단계에서 원장이
      // 채워 준 market.nameKo 를 먼저 쓴다 — 회의 자료에 코드가 아니라 회사명이
      // 찍혀야 한다.
      nameKo: (market && market.nameKo) || resolved.nameKo || null,
      // KRX 6자리 — 주가 모니터링 워치리스트와 조인하는 키다. 한국 주식이 아니면 null.
      krCode: (market && market.krCode) || null,
      mode,
      mock,
      reportFile: fname,
      priceLine: (market && market.priceLine) || null,
      perpPriceLine: (market && market.perp && market.perp.priceLine) || null,
      kiAsOf,
      decision: {
        action: d.action || null,
        confidence: typeof d.confidence === 'number' ? d.confidence : null,
        entry: d.entry != null ? d.entry : null,
        stop: d.stop != null ? d.stop : null,
        target: d.target != null ? d.target : null,
        rationale: d.rationale || null,
        verdict: d.verdict || null,
        sizing: d.sizing || null,
        riskDowngraded: !!d.riskDowngraded,
        scalp: d.scalp || null,
        risk: d.risk || null,
      },
      analysts: (analystResults || []).map(cast),
      debate: (debateLog || []).map((x) => ({ turn: x.turn == null ? null : x.turn, ...cast(x) })),
      scalpDesk: (scalpResults || []).map(cast),
      riskCommittee: (riskResults || []).map(cast),
      pm: pmResult
        ? {
            failed: !!pmResult.failed,
            verdict: pmResult.verdict || null,
            sizing: pmResult.sizing || null,
            rationale: pmResult.rationale || null,
            bubble: pmResult.bubble || null,
            report: pmResult.report || null,
          }
        : null,
      memory: Array.isArray(memory) ? memory.slice() : [],
      disclaimer:
        '본 판정은 AI 시뮬레이션 결과이며 투자 조언이 아닙니다. 실제 주문은 이뤄지지 않습니다.',
    };
  }

  _renderMarkdown(resolved, market, mock, mode, analystResults, debateLog, scalpResults, riskResults, pmResult, memory, decision, now) {
    const modeLabel =
      mode === 'attack'
        ? '⚔ 공격(탭비트 20x · 방향 강제)'
        : mode === 'scalp'
        ? '스캘핑(탭비트 20x 단타)'
        : '알고리즘(논문 파이프라인)';
    const lines = [];
    lines.push(`# PIXEL TRADING FLOOR 분석 리포트`);
    lines.push('');
    lines.push(`- 심볼: ${resolved.display} (${resolved.symbol}, ${resolved.kind})`);
    lines.push(`- 시각: ${now.toISOString()}`);
    lines.push(`- 모드: ${modeLabel} · ${mock ? '데모(시뮬레이션 목업)' : '실전(claude opus)'}`);
    if (market && market.priceLine) lines.push(`- 시세: ${market.priceLine}`);
    if (market && market.perp && market.perp.priceLine) {
      lines.push(`- 시세(체결 기준): ${market.perp.priceLine}`);
    }
    if (mode === 'attack') {
      lines.push(
        '- ⚠ 공격 모드: 관망(PASS/HOLD)을 금지하고 반드시 방향을 고르게 한 런이다. ' +
          '우위가 미약해도 한쪽이 선택되므로, 확신도와 무효화 레벨을 함께 보지 않으면 오독하기 쉽다.'
      );
    }
    lines.push('');
    if (market && market.board && Array.isArray(market.board.lines) && market.board.lines.length) {
      lines.push('## 멀티 거래소 전광판');
      lines.push('');
      for (const l of market.board.lines) lines.push(`- ${l}`);
      lines.push('');
    }

    lines.push('## 애널리스트 리포트');
    lines.push('');
    for (const r of analystResults) {
      lines.push(`### ${r.name}`);
      lines.push(`> ${r.bubble || ''}`);
      lines.push('');
      lines.push(r.report || '(리포트 없음)');
      lines.push('');
    }

    if (debateLog.length) {
      lines.push('## 리서치 토론 (BULL vs BEAR)');
      lines.push('');
    }
    for (const d of debateLog) {
      lines.push(`### 턴 ${d.turn} — ${d.name}`);
      lines.push(`> ${d.bubble || ''}`);
      lines.push('');
      lines.push(d.report || '(리포트 없음)');
      lines.push('');
    }

    if (Array.isArray(scalpResults) && scalpResults.length) {
      lines.push('## 스캘핑 데스크 (20x)');
      lines.push('');
      for (const r of scalpResults) {
        lines.push(`### ${r.name}`);
        lines.push(`> ${r.bubble || ''}`);
        lines.push('');
        lines.push(r.report || '(리포트 없음)');
        lines.push('');
      }
    }

    if (Array.isArray(riskResults) && riskResults.length) {
      lines.push('## 리스크 위원회');
      lines.push('');
      for (const r of riskResults) {
        lines.push(`### ${r.name}`);
        lines.push(`> ${r.bubble || ''}`);
        lines.push('');
        lines.push(r.report || '(리포트 없음)');
        lines.push('');
      }
    }

    if (pmResult) {
      lines.push('## 포트폴리오 매니저 승인');
      lines.push('');
      if (pmResult.failed) {
        lines.push('- 판정: **승인 절차 실패** — 수석 트레이더(ACE)의 판정을 그대로 최종으로 사용했습니다.');
        lines.push('');
        lines.push(pmResult.report || '');
        lines.push('');
      } else {
        lines.push(`- 판정: **${pmResult.verdict}**`);
        if (pmResult.sizing) lines.push(`- 권장 비중: ${pmResult.sizing}`);
        if (pmResult.rationale) lines.push(`- 근거: ${pmResult.rationale}`);
        lines.push('');
        lines.push(`> ${pmResult.bubble || ''}`);
        lines.push('');
        lines.push(pmResult.report || '(리포트 없음)');
        lines.push('');
      }
    }

    if (Array.isArray(memory) && memory.length) {
      lines.push('## 과거 판정 회고');
      lines.push('');
      for (const m of memory) lines.push(`- ${m}`);
      lines.push('');
    }

    if (decision.risk) {
      const g = decision.risk;
      lines.push('## 리스크 게이트');
      lines.push('');
      lines.push(
        `- 평가 대상: ${g.scope === 'scalp' ? '스캘핑 레벨(레버리지 계약)' : '스윙 레벨(정규장)'}` +
          ` · 방향 ${g.side || '없음'}`
      );
      lines.push(
        `- 손익비(R:R): ${g.rr != null ? g.rr.toFixed(2) : '데이터 없음'} (최소 기준 ${g.minRR})`
      );
      lines.push(
        `- 청산가: ${fmtPrice(g.liq) || '데이터 없음'}` +
          (g.stopBeyondLiq ? ' — ⚠ 손절이 청산가보다 멀다(청산이 먼저 온다)' : '')
      );
      lines.push(`- 권장 비중: ${formatSizingLine(g.sizing) || '데이터 없음'}`);
      lines.push(
        `- 통과 여부: ${g.ok ? '통과' : '미달'}` +
          (decision.riskDowngraded
            ? ' → 판정 강등'
            : g.downgrade
            ? ' → 공격 모드라 강등 없이 경고만'
            : '')
      );
      if (Array.isArray(g.reasons) && g.reasons.length) {
        lines.push('- 사유:');
        for (const r of g.reasons) lines.push(`  - ${r}`);
      }
      lines.push('');
    }

    lines.push(
      pmResult && !pmResult.failed ? '## 최종 판정 (ACE → PM 승인)' : '## 최종 판정 (ACE)'
    );
    lines.push('');
    lines.push(`- 액션: **${decision.action}**`);
    if (decision.verdict) lines.push(`- PM 판정: ${decision.verdict}`);
    if (decision.sizing) lines.push(`- 권장 비중: ${decision.sizing}`);
    lines.push(`- 확신도: ${decision.confidence}%`);
    lines.push(`- 진입: ${decision.entry}`);
    lines.push(`- 손절: ${decision.stop}`);
    lines.push(`- 목표: ${decision.target}`);
    lines.push(`- 근거: ${decision.rationale}`);
    lines.push('');
    if (decision.scalp) {
      const s = decision.scalp;
      lines.push('### 스캘핑 판정 (탭비트 20x)');
      lines.push(`- 편향: **${s.bias || '-'}**`);
      lines.push(`- 진입 트리거: ${s.entry || '-'}`);
      lines.push(`- 무효화(손절): ${s.stop || '-'}`);
      lines.push(`- 1차 목표: ${s.target || '-'}`);
      lines.push(`- 리스크: ${s.note || '-'}`);
      lines.push('');
    }
    if (decision.report) {
      lines.push(decision.report);
      lines.push('');
    }

    lines.push('---');
    lines.push(
      '본 리포트는 AI 시뮬레이션 결과이며 투자 조언이 아닙니다. 실제 주문은 이뤄지지 않습니다.'
    );
    lines.push('');
    return lines.join('\n');
  }
}

module.exports = { Engine };
