'use strict';

// PIXEL TRADING FLOOR — 주가 모니터링 원장 브리지 (ki-bridge)
//
// 같은 저장소의 `stock-monitor/ki_monitor.py` 가 KRX·DART 공식 API 로 쌓아 둔
// 원장에서 **측정값만** 읽어 온다. `python ki_monitor.py facts --code 000660`
// 를 스폰해 stdout 의 JSON 한 덩어리를 받는 것이 전부다.
//
// 계약(docs/integration.md):
//   module.exports = { DEFAULT_KI, DEFAULT_SCRIPT, isEnabled, kiConfig, krCodeOf,
//                      fetchKiFacts, fetchKiCandles, formatKiLines, formatKiPriceLine,
//                      clearCache, _setSpawn }
//
// 원칙 — 두 프로젝트의 규칙을 둘 다 지킨다
//
//   [trading-floor 쪽]
//   - **외부 npm 의존성 0.** node:child_process · node:fs · node:path 만 쓴다.
//     파이썬을 자식 프로세스로 부르는 것은 의존성 추가가 아니다. 사용자가
//     끄면(기본값) 이 파일은 아무것도 하지 않고, 파이썬이 없어도 앱은 돈다.
//   - **절대 throw 하지 않는다.** 분석 파이프라인·감시 루프를 이 모듈이 막으면
//     안 된다. 실패는 console.error 한 줄 + null 반환으로 끝낸다.
//   - 데이터에 없는 수치를 지어내지 않는다. 없으면 줄 자체를 뺀다.
//
//   [stock-monitor 쪽]
//   - **판단을 실어 나르지 않는다.** 등급·점수·권고로 바꾸지 않는다.
//     받은 측정값을 측정값인 채로 프롬프트에 넣고, 판정은 에이전트가 한다.
//   - **가정을 값과 함께 나른다.** 처분 소요일수는 참여율 가정 위에 서 있다.
//     숫자만 넣으면 프롬프트에서 가정이 사라진다.
//   - **원장 기준일을 반드시 함께 낸다.** 원장은 일별 종가다. 실시간이 아니다.
//     며칠 지난 값을 현재가처럼 읽으면 판정이 통째로 틀어진다.
//
// 기본값은 꺼짐(`ki.enabled=false`)이다. 켜기 전까지 trading-floor 의 동작은
// 통합 이전과 한 글자도 다르지 않다.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 설정이 없을 때 쓰는 기본값. config.js 의 DEFAULTS.ki 와 같은 모양이어야 한다.
const DEFAULT_KI = {
  enabled: false,
  python: '', // 비우면 python3 → python 순서로 찾는다
  script: '', // 비우면 <저장소>/stock-monitor/ki_monitor.py
  timeoutSec: 30,
  cacheMin: 30,
  withDisclosures: false, // 켜면 DART 공시까지 — 네트워크·키가 필요하다
  staleWarnDays: 5, // 원장이 이만큼 묵으면 프롬프트에 경고를 붙인다
  injectInto: ['diana', 'guard', 'safe', 'ace'], // 실측을 받을 에이전트
  // 공개 API(야후)로 캔들을 못 받을 때 원장의 KRX 공식 일봉으로 대신할지.
  // 사내망·폐쇄망에서 분석이 아예 서는 것을 막는다. 지어내는 것이 아니라
  // 이미 공식 API 로 받아 둔 값을 쓰는 것이다.
  candleFallback: true,
  candleDays: 200, // 대체 시 가져올 일수
};

// 저장소 배치상 server/ 의 두 단계 위가 저장소 루트다.
const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_SCRIPT = path.join(REPO_ROOT, 'stock-monitor', 'ki_monitor.py');

// 테스트에서 갈아끼울 수 있게 간접 참조로 둔다(_setSpawn).
let spawnImpl = spawn;

// --- config 로드 (config.js 가 없어도 죽지 않는다) -----------------------

let cfgMod; // undefined = 아직 시도 안 함, null = 없음
let cfgModTriedAt = 0;

function loadKiCfg(override) {
  const base = { ...DEFAULT_KI };
  if (override && typeof override === 'object') return { ...base, ...override };

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
  if (!cfgMod) return base;
  try {
    const c = cfgMod.loadConfig();
    if (c && typeof c.ki === 'object' && c.ki) return { ...base, ...c.ki };
  } catch (_) {
    /* loadConfig 는 throw 하지 않기로 돼 있지만, 그래도 막아 둔다 */
  }
  return base;
}

function isEnabled(override) {
  return loadKiCfg(override).enabled === true;
}

// 병합된 ki 설정 사본. 부르는 쪽이 config.js 를 직접 읽지 않아도 되게 공개한다.
function kiConfig(override) {
  return loadKiCfg(override);
}

// --- 종목코드 -----------------------------------------------------------

// KRX 6자리 코드로 정규화. 원장의 키가 이것이다.
// market.js 의 KR_STOCKS 를 여기서 require 하지 않는다 — market.js 가 이 모듈을
// 부르므로 순환 의존이 된다. 심볼→코드 변환은 부르는 쪽(market.js/server.js)이
// 이미 갖고 있는 resolved.yahoo('000660.KS')로 하고, 여기는 코드만 받는다.
function krCodeOf(input) {
  if (input == null) return null;
  const s = String(input).trim().toUpperCase();
  const m = s.match(/^(\d{6}|\d{4}[A-Z]\d)(?:\.(?:KS|KQ))?$/);
  return m ? m[1] : null;
}

// --- 캐시 ---------------------------------------------------------------
//
// 원장은 일별 종가다. 분석 한 번에 여러 에이전트가 같은 값을 보므로 캐시가 없으면
// 파이썬을 그만큼 스폰한다. 실패도 캐시한다 — 원장이 없는 환경에서 매 요청마다
// 프로세스를 띄우면 그게 더 큰 비용이다.

const cache = new Map(); // '<종류>:<코드>' -> { at, ttl, value }
const NEG_TTL_MS = 60000; // 실패는 1분만 기억한다

function cacheGet(code) {
  const hit = cache.get(code);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(code);
    return undefined;
  }
  return hit.value;
}

function cacheSet(code, value, ttl) {
  cache.set(code, { at: Date.now(), ttl, value });
}

function clearCache() {
  cache.clear();
}

// --- 파이썬 실행 --------------------------------------------------------

function pythonCandidates(cfg) {
  const out = [];
  if (cfg.python && String(cfg.python).trim()) out.push(String(cfg.python).trim());
  out.push('python3', 'python');
  return [...new Set(out)];
}

function scriptPath(cfg) {
  const s = cfg.script && String(cfg.script).trim();
  if (!s) return DEFAULT_SCRIPT;
  return path.isAbsolute(s) ? s : path.resolve(REPO_ROOT, s);
}

// 한 번 실행. 해석은 하지 않고 { code, stdout, stderr, spawnError } 만 돌려준다.
function runOnce(bin, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ spawnError: err });
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* 이미 죽었으면 무시 */
      }
      finish({ timedOut: true, stdout, stderr });
    }, timeoutMs);

    if (child.stdout) child.stdout.on('data', (d) => {
      stdout += d;
    });
    if (child.stderr) child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => finish({ spawnError: err }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

// stdout 에서 JSON 을 꺼낸다. ki_monitor.py 는 stdout 에 JSON 만 내기로 돼 있지만,
// 파이썬 경고 한 줄이 섞이는 환경(예: 사용자 sitecustomize)이 있어 방어한다.
function parseFactsJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    /* 아래에서 잘라 본다 */
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

/**
 * 원장에서 이 종목의 관측 사실을 읽어 온다.
 *
 * @param {string} codeOrSymbol  '000660' 또는 '000660.KS'
 * @param {object} [opts]        { cfg } — cfg 를 주면 config.json 대신 그것을 쓴다
 * @returns {Promise<object|null>} facts 객체(ki.facts/1) 또는 null.
 *          **절대 reject 하지 않는다.**
 */
async function fetchKiFacts(codeOrSymbol, opts = {}) {
  return runKiJson('facts', codeOrSymbol, opts, (cfg, code) => {
    const a = ['facts', '--code', code];
    if (cfg.withDisclosures) a.push('--with-disclosures');
    return a;
  });
}

/**
 * 원장의 KRX 공식 일봉을 읽어 온다 (ki.candles/1).
 *
 * 공개 API 가 막힌 곳에서 데스크가 캔들을 못 받아 분석이 서는 것을 막는 용도다.
 * 없는 값을 만들지 않는다 — 원장에 없으면 null 이다.
 *
 * @returns {Promise<object|null>} **절대 reject 하지 않는다.**
 */
async function fetchKiCandles(codeOrSymbol, opts = {}) {
  return runKiJson('candles', codeOrSymbol, opts, (cfg, code) => [
    'candles',
    '--code',
    code,
    '--days',
    String(Math.max(30, Number(cfg.candleDays || 200))),
  ]);
}

// facts·candles 가 공유하는 실행부. 종류(kind)별로 캐시를 나눈다.
async function runKiJson(kind, codeOrSymbol, opts, buildArgs) {
  const cfg = loadKiCfg(opts.cfg);
  if (!cfg.enabled) return null;

  const code = krCodeOf(codeOrSymbol);
  if (!code) return null;

  const cacheKey = `${kind}:${code}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const script = scriptPath(cfg);
  if (!fs.existsSync(script)) {
    console.error(`[ki] 원장 스크립트를 찾지 못했습니다: ${script} — ${kind} 를 건너뜁니다`);
    cacheSet(cacheKey, null, NEG_TTL_MS);
    return null;
  }

  const args = [script, ...buildArgs(cfg, code)];
  const timeoutMs = Math.max(1000, Number(cfg.timeoutSec || 30) * 1000);
  const cwd = path.dirname(script);

  let lastNote = '';
  for (const bin of pythonCandidates(cfg)) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runOnce(bin, args, cwd, timeoutMs);

    if (r.spawnError) {
      // 그 이름의 파이썬이 없으면 다음 후보로. 그 외 오류는 여기서 끝낸다.
      if (r.spawnError.code === 'ENOENT') {
        lastNote = `'${bin}' 실행 파일 없음`;
        continue;
      }
      lastNote = `${bin}: ${r.spawnError.message}`;
      break;
    }
    if (r.timedOut) {
      lastNote = `${bin}: ${cfg.timeoutSec}초 안에 끝나지 않아 중단`;
      break;
    }

    // 종료코드가 1이어도 stdout 에 { ok:false, reason } 이 실려 온다.
    // 그 reason 이 사용자가 볼 수 있는 유일한 단서이므로 먼저 파싱한다.
    const parsed = parseFactsJson(r.stdout);
    if (!parsed) {
      lastNote = `${bin}: JSON 을 받지 못했습니다 (exit ${r.code})`;
      if (r.stderr) lastNote += ` — ${String(r.stderr).trim().split('\n').slice(-1)[0]}`;
      break;
    }
    if (parsed.ok !== true) {
      console.error(`[ki] ${code} ${kind} 없음 — ${parsed.reason || '원장에 데이터 없음'}`);
      cacheSet(cacheKey, null, NEG_TTL_MS);
      return null;
    }

    const ttl = Math.max(60, Number(cfg.cacheMin || 30) * 60) * 1000;
    cacheSet(cacheKey, parsed, ttl);
    return parsed;
  }

  console.error(`[ki] ${code} ${kind} 조회 실패 — ${lastNote || '알 수 없는 이유'}`);
  cacheSet(cacheKey, null, NEG_TTL_MS);
  return null;
}

// --- 프롬프트용 서식 ----------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// 이 종목이 속한 시장의 관측기간(영업일). 분위의 의미가 여기에 달렸다.
function mkNDays(facts, market) {
  const mk = (facts && facts.markets ? facts.markets[market] : null) || null;
  return mk && Number.isFinite(Number(mk.n_days)) ? Number(mk.n_days) : null;
}

function pct(v, digits = 0) {
  const n = num(v);
  return n == null ? null : `${(n * 100).toFixed(digits)}%`;
}

/**
 * facts → 프롬프트에 그대로 넣을 한국어 줄 배열.
 *
 * 판단을 만들지 않는다. 측정값과 그 측정값이 선 가정만 옮긴다.
 * 값이 없는 줄은 넣지 않는다 — 빈 줄이 있으면 에이전트가 채우려 든다.
 *
 * @param {object|null} facts  fetchKiFacts 의 반환값
 * @param {string} codeOrSymbol
 * @param {object} [opts] { staleWarnDays, detail: 'standard'|'full' }
 * @returns {string[]}  비어 있으면 붙일 실측이 없다는 뜻
 */
function formatKiLines(facts, codeOrSymbol, opts = {}) {
  const code = krCodeOf(codeOrSymbol);
  if (!facts || !code) return [];
  const s = facts.stocks && facts.stocks[code];
  if (!s || s.found !== true) return [];

  const warnDays = Number(opts.staleWarnDays ?? DEFAULT_KI.staleWarnDays);
  // 'full' 은 전담 에이전트(FLOW)용 — 매물대 전 구간·규칙 전체·사분위까지 낸다.
  const detail = opts.detail === 'full' ? 'full' : 'standard';
  // 어느 블록을 줄 것인가. 주지 않으면 전부 — 기존 호출자의 동작이 바뀌지 않는다.
  // 역할을 나눈 이유: 같은 재료를 여러 명이 보면 의견이 상관되고, 전담이 없으면
  // 아무도 깊이 보지 않는다.
  const want = Array.isArray(opts.sections) && opts.sections.length
    ? new Set(opts.sections)
    : null;
  const on = (name) => !want || want.has(name);
  const out = [];
  const stale = num(s.stale_days);

  out.push(
    `출처: 주가 모니터링 원장 (한국거래소 KRX Open API · 금융감독원 DART Open API)`
  );
  out.push(`기준일: ${s.as_of || '알 수 없음'}${stale != null ? ` (${stale}일 경과)` : ''}`);
  if (stale != null && stale > warnDays) {
    out.push(
      `주의: 원장이 ${stale}일 묵었다. 아래 값은 그 시점의 일별 종가 기준이며 ` +
        `현재가가 아니다. 최신 시세는 위의 시세 데이터를 쓰라.`
    );
  }

  const m = s.measures || {};
  const obs = s.observations || {};

  const push = (label, arr) => {
    if (Array.isArray(arr) && arr.length) {
      out.push('');
      out.push(`[${label}]`);
      arr.forEach((line) => out.push(`- ${line}`));
    }
  };

  if (on('liq')) push('처분 여건 (유동성)', obs.liq);
  if (on('px')) push('가격 위치', obs.px);
  if (on('cap')) push('상장·보호예수', obs.cap);
  if (on('fin')) push('재무·밸류에이션', obs.fin);
  if (on('events')) push('공시 이벤트', obs.events);

  // 관측 문장에 안 들어가는 숫자 몇 개만 따로. 중복은 넣지 않는다.
  const extras = [];
  if (num(m.amihud) != null) {
    extras.push(`Amihud 비유동성 ${m.amihud.toFixed(4)} (클수록 체결비용이 큼)`);
  }
  if (num(m.pbr) != null) extras.push(`PBR ${m.pbr.toFixed(2)}배`);
  if (num(m.roe) != null) extras.push(`ROE ${pct(m.roe, 1)}`);
  if (num(m.zero_days) != null && m.zero_days > 0) {
    extras.push(`최근 60일 무거래일 ${pct(m.zero_days)}`);
  }
  if (extras.length && on('extras')) {
    out.push('');
    out.push('[추가 측정값]');
    extras.forEach((line) => out.push(`- ${line}`));
  }

  // 매물대 — 어느 가격에서 손바뀜이 많았는가. 그 가격 근처에서 물량이 나온다.
  const vp = on('profile') && Array.isArray(s.volume_profile) ? s.volume_profile.slice() : [];
  if (vp.length) {
    const top = vp
      .filter((b) => b && num(b.price) != null && num(b.share) != null)
      .sort((a, b) => b.share - a.share)
      .slice(0, detail === 'full' ? vp.length : 3);
    if (top.length) {
      out.push('');
      out.push(`[매물대 — 가격대별 거래대금 비중${detail === 'full' ? '' : ' (상위 3개 구간)'}]`);
      for (const b of top) {
        out.push(`- ${Math.round(b.price).toLocaleString('en-US')}원 부근 ${pct(b.share, 1)}`);
      }
      out.push(
        '(손바뀜이 많았던 가격대다. 그 근처에서 대기 물량이 나올 가능성을 뜻하며, ' +
          '지지·저항을 보증하지 않는다.)'
      );
    }
  }

  // 실행 시뮬레이션 — "어떻게 팔면 얼마에 팔리는가". 회수 판단의 핵심이다.
  const ex = on('exec') ? s.execution : null;
  if (ex && ex.ok === true && ex.rules) {
    const order = Array.isArray(ex.ranked_by_shortfall) ? ex.ranked_by_shortfall : Object.keys(ex.rules);
    const rows = order.map((k) => ex.rules[k]).filter(Boolean);
    if (rows.length) {
      out.push('');
      out.push(
        `[실행 시뮬레이션 — 시가총액 ${ex.target_pct}% 를 ${ex.horizon}영업일에 걸쳐 매도` +
          `${ex.starts != null ? ` · 시작일 ${ex.starts}개 구간 반복` : ''}]`
      );
      const show = detail === 'full' ? rows : rows.slice(0, 2).concat(rows.slice(-1));
      const seen = new Set();
      for (const r of show) {
        if (seen.has(r.label)) continue;
        seen.add(r.label);
        const sf = num(r.shortfall_med);
        const parts = [`${r.label}: 실현단가 ${sf != null ? `${sf >= 0 ? '+' : ''}${sf.toFixed(0)}bp` : '데이터 없음'}`];
        if (detail === 'full' && num(r.shortfall_p25) != null && num(r.shortfall_p75) != null) {
          parts.push(`구간 ${r.shortfall_p25.toFixed(0)}~${r.shortfall_p75.toFixed(0)}bp`);
        }
        if (num(r.vs_vwap_med) != null) parts.push(`VWAP 대비 ${r.vs_vwap_med.toFixed(0)}bp`);
        if (num(r.fill_med) != null) parts.push(`체결률 ${pct(r.fill_med, 0)}`);
        if (num(r.days_med) != null) parts.push(`소요 ${r.days_med.toFixed(0)}영업일`);
        out.push(`- ${parts.join(' · ')}`);
      }
      out.push(
        'bp 는 의사결정 시점 종가 대비다. 음수면 그만큼 못 받고 판 것이다. ' +
          '체결률이 1 미만이면 물량을 다 못 판 것이므로 실현단가만 보면 안 된다. ' +
          '순서는 과거 실현단가 순일 뿐 권고가 아니다.'
      );
    }
  } else if (ex && ex.ok === false && ex.reason) {
    out.push('');
    out.push(`[실행 시뮬레이션] 산출하지 못했다 — ${ex.reason}`);
  }

  // 자본구조 — 엑싯 '단가'의 다른 축. 팔 수 있는가와 별개로, 팔 때 희석이
  // 얼마나 진행돼 있는가. DART 조회를 켠 경우에만 채워진다.
  const cap = on('capital') ? s.capital : null;
  if (cap) {
    const lines = [];
    if (num(cap.bond_outstanding) != null) {
      lines.push(
        `미상환 전환사채·BW ${Math.round(cap.bond_outstanding).toLocaleString('en-US')}원` +
          (num(cap.cb_to_mktcap) != null ? ` — 시가총액의 ${pct(cap.cb_to_mktcap, 1)}` : '')
      );
    }
    if (num(cap.shares_total) != null) {
      lines.push(
        `발행 보통주 ${Math.round(cap.shares_total).toLocaleString('en-US')}주` +
          (num(cap.treasury) != null
            ? ` · 자기주식 ${Math.round(cap.treasury).toLocaleString('en-US')}주`
            : '')
      );
    }
    if (num(cap.top_holder_pct) != null) {
      lines.push(
        `최대주주 및 특수관계인 ${cap.top_holder_pct.toFixed(2)}% — 같은 창구로 나올 수 있는 물량`
      );
    }
    for (const h of (cap.holders || []).slice(0, 5)) {
      if (!h || !h.name) continue;
      lines.push(
        `  · ${h.name}${h.relate ? ` (${h.relate})` : ''}` +
          (num(h.pct) != null ? ` ${h.pct.toFixed(2)}%` : '')
      );
    }
    if (lines.length) {
      out.push('');
      out.push(`[자본구조 — DART ${cap.year || '?'} 사업보고서 기준]`);
      lines.forEach((l) => out.push(`- ${l}`));
    }
    const rx = cap.refix;
    if (rx && Array.isArray(rx.scenarios) && rx.scenarios.length) {
      out.push('');
      out.push(
        `[리픽싱 시나리오 — 주가가 더 내리면 희석이 얼마나 가속되는가` +
          ` (전환가 하한을 현재가의 ${pct(rx.floor_assumed_pct, 0)}로 가정)]`
      );
      for (const sc of rx.scenarios) {
        const p = num(sc.price);
        const cv = num(sc.conv_price);
        const ps = num(sc.potential_shares);
        const dl = num(sc.dilution_pct);
        if (p == null) continue;
        out.push(
          `- 주가 ${Math.round(p).toLocaleString('en-US')}원 → 전환가 ` +
            `${cv != null ? Math.round(cv).toLocaleString('en-US') : '?'}원` +
            (ps != null ? ` · 잠재 주식수 ${Math.round(ps).toLocaleString('en-US')}주` : '') +
            (dl != null ? ` (발행주식의 ${pct(dl, 1)})` : '')
        );
      }
      out.push('전환가 하한은 발행조건에 따라 다르다. 위 하한은 가정이므로 증권신고서로 확인해야 한다.');
    }
  }

  // 측정 한계 — 원장이 '재지 못한' 것. 가정을 심문하는 역할(RED)의 재료다.
  if (on('limits')) {
    const lim = [];
    const nd = mkNDays(facts, s.market);
    if (nd != null) {
      lim.push(
        `관측기간 ${nd}영업일 — 이 안에서의 분위(pctile)만 말할 수 있다. ` +
          `${nd < 120 ? '1년이 안 되므로 분위의 의미가 제한적이다.' : ''}`
      );
    }
    if (num(s.stale_days) != null) {
      lim.push(`원장 기준일로부터 ${s.stale_days}일 경과 — 그 사이의 사건은 반영돼 있지 않다.`);
    }
    const missing = Object.entries(s.measures || {})
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    if (missing.length) {
      lim.push(
        `측정하지 못한 값 ${missing.length}개: ${missing.join(', ')} — ` +
          `표본이 부족했거나 정의되지 않아 산출을 거부한 것이다. 0 이 아니라 '모름'이다.`
      );
    }
    if (s.execution && s.execution.ok === false) {
      lim.push(`실행 시뮬레이션 산출 실패 — ${s.execution.reason}`);
    }
    if (!s.capital) {
      lim.push('자본구조(미상환 사채·최대주주 지분) 미조회 — 희석 규모를 모르는 상태다.');
    }
    if (lim.length) {
      out.push('');
      out.push('[이 원장이 재지 못한 것]');
      lim.forEach((l) => out.push(`- ${l}`));
    }
  }

  // 시장 국면 — 수준이 아니라 분위로 본다.
  const mk = (facts.markets || {})[s.market];
  const reg = on('regime') && mk && mk.regime ? mk.regime : null;
  if (reg) {
    const rows = Object.values(reg)
      .filter((r) => r && r.label && (r.display != null || num(r.value) != null))
      .map((r) => {
        const p = num(r.pctile);
        const val = r.display != null ? r.display : String(r.value);
        return `- ${r.label} ${val}${p != null ? ` (관측기간 ${Math.round(p * 100)}분위)` : ''}`;
      });
    if (rows.length) {
      out.push('');
      out.push(`[시장 국면 — ${s.market} · 관측 ${mk.n_days || '?'}영업일]`);
      rows.forEach((line) => out.push(line));
    }
  }

  const assumptions = on('assumptions') && Array.isArray(facts.assumptions)
    ? facts.assumptions
    : [];
  if (assumptions.length) {
    out.push('');
    out.push('[위 숫자가 서 있는 가정]');
    assumptions.forEach((line) => out.push(`- ${line}`));
  }

  out.push('');
  out.push(
    '위 값은 공식 API 로 측정한 사실이다. 등급·점수·권고가 아니다. ' +
      '여기 없는 수치는 "데이터 없음"으로 두고 추정해서 채우지 마라. ' +
      '가정이 붙은 숫자는 가정과 함께 인용하라.'
  );
  return out;
}

/**
 * 원장 일봉으로 만든 시세 한 줄. **실시간이 아님을 반드시 밝힌다.**
 *
 * 원장은 일별 종가다. 이 줄을 현재가처럼 읽으면 판정이 통째로 틀어지므로
 * 출처와 기준일을 문장 안에 넣는다.
 *
 * @returns {string|null} 만들 수 없으면 null
 */
function formatKiPriceLine(candlesPayload, label) {
  const p = candlesPayload;
  if (!p || p.ok !== true || !Array.isArray(p.candles) || p.candles.length === 0) return null;
  const last = p.candles[p.candles.length - 1];
  const prev = p.candles.length >= 2 ? p.candles[p.candles.length - 2] : null;
  if (!last || !Number.isFinite(last.c)) return null;

  const name = label || p.name || p.code;
  const price = Math.round(last.c).toLocaleString('en-US');
  let chg = '';
  if (prev && Number.isFinite(prev.c) && prev.c !== 0) {
    const pctChg = ((last.c - prev.c) / prev.c) * 100;
    chg = ` (${pctChg >= 0 ? '+' : ''}${pctChg.toFixed(2)}%)`;
  }
  const stale = Number.isFinite(Number(p.stale_days)) ? Number(p.stale_days) : null;
  return (
    `${name} ₩${price}${chg} · KRX 정규장 종가 ${p.as_of || '?'}` +
    (stale != null ? ` (${stale}일 경과)` : '') +
    ' — 한국거래소 공식 API 로 받은 일별 시세이며 실시간 호가가 아니다'
  );
}

// 테스트 주입구 — 실제 파이썬 없이 스폰 동작을 검증하기 위한 것.
function _setSpawn(fn) {
  spawnImpl = typeof fn === 'function' ? fn : spawn;
}

module.exports = {
  DEFAULT_KI,
  DEFAULT_SCRIPT,
  isEnabled,
  kiConfig,
  krCodeOf,
  fetchKiFacts,
  fetchKiCandles,
  formatKiLines,
  formatKiPriceLine,
  clearCache,
  _setSpawn,
};
