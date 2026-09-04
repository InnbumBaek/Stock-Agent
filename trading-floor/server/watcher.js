'use strict';

// PIXEL TRADING FLOOR — 급변동 감시 (watcher)
//
// 계약(docs/v2-contracts.md):
//   class Watcher extends EventEmitter
//     constructor({ engine, config })
//     start() / stop() / status()
//   트리거 시 emit('alert', alertObj)
//
// 설계 원칙
//   - **가벼운 시세만 조회한다.** fetchMarket()은 뉴스·펀더멘털까지 긁어서 비싸다.
//     여기서는 market.js가 쓰는 것과 동일한 엔드포인트를 최소 개수만 직접 부른다.
//       코인    : Binance 현물 24hr ticker + 1분봉 klines (+ 무기한 펀딩)
//       한국주식: Binance USDⓈ-M 무기한(fapi) 24hr ticker + 1분봉 klines + premiumIndex
//                 — CLAUDE.md 규칙대로 체결이 일어나는 무기한 축을 본다
//       해외주식: Yahoo chart 1분봉 1콜
//   - 어떤 실패도 삼키고 다음 주기로 넘어간다. **감시 루프는 절대 죽지 않는다.**
//   - 조용시간에는 알림을 기록·방송만 하고 텔레그램·자동분석은 하지 않는다.
//   - 자동분석은 engine.running 이면 그냥 건너뛴다(큐잉 금지 — 시장은 이미 변했다).

const EventEmitter = require('events');
const { resolveSymbol, KR_STOCKS } = require('./market');

const MAX_ALERTS = 50; // 메모리에 보관하는 최근 알림 수
const MIN_INTERVAL_SEC = 10; // 너무 잦은 폴링 방지
const HTTP_TIMEOUT_MS = 8000;
const KLINE_MIN_BARS = 31; // 거래량 기준선을 만들 최소 봉 수
const KLINE_MAX_BARS = 200;
const VOL_BASE_MIN = 10; // 거래량 비교에 필요한 최소 기준봉 수
const FX_TTL_MS = 10 * 60 * 1000; // 환율 캐시 (괴리 계산용)
const KRX_TTL_MS = 5 * 60 * 1000; // KRX 종가 캐시
const FAIL_RETRY_MS = 60 * 1000; // 야후가 죽었을 때 재시도 억제 간격
const AUTO_GAP_DEFAULT_MIN = 5; // 자동분석 최소 간격(전역) — 할당량 보호

const BINANCE_SPOT = 'https://api.binance.com/api/v3';
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const ER_API = 'https://open.er-api.com/v6/latest/USD';

// market.js 와 동일한 UA — Yahoo 가 기본 UA 를 자주 막는다.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YAHOO_HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

// --- 작은 유틸 ----------------------------------------------------------

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mean(arr) {
  const v = arr.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

// 기준값 대비 몇 배인지로 심각도를 매긴다(모든 kind 공통 규칙).
function severityOf(value, threshold) {
  const t = Math.abs(Number(threshold));
  const v = Math.abs(Number(value));
  if (!Number.isFinite(t) || t === 0 || !Number.isFinite(v)) return 'info';
  const r = v / t;
  if (r >= 2) return 'critical';
  if (r >= 1.4) return 'warn';
  return 'info';
}

// quietHours: [[0,7]] → 0시~7시 억제. [[22,6]] 처럼 자정을 넘는 구간도 지원.
function inQuietHours(quietHours, now) {
  if (!Array.isArray(quietHours) || !quietHours.length) return false;
  const h = (now || new Date()).getHours();
  for (const range of quietHours) {
    if (!Array.isArray(range) || range.length < 2) continue;
    const a = Number(range[0]);
    const b = Number(range[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
    if (a < b) {
      if (h >= a && h < b) return true;
    } else if (h >= a || h < b) {
      return true; // 자정 넘김
    }
  }
  return false;
}

// config 는 세 형태를 모두 받는다:
//   1) 설정 객체 그대로   { watchlist:[...], watcher:{...} }
//   2) 최신 설정을 돌려주는 함수  () => cfg   ← 실행 중 설정 변경이 바로 반영된다
//   3) config.js 모듈     { loadConfig, saveConfig, DEFAULTS }
function makeConfigReader(src) {
  return function read() {
    try {
      let c = src;
      if (typeof c === 'function') c = c();
      if (c && typeof c.loadConfig === 'function' && !c.watcher && !c.watchlist) {
        c = c.loadConfig();
      }
      if (c && typeof c === 'object') return c;
    } catch (_) {}
    return {};
  };
}

// 감시에 필요한 설정만 정규화해서 뽑는다(없으면 계약서 DEFAULTS 값).
function readWatchCfg(cfg) {
  const w = (cfg && cfg.watcher) || {};
  const t = w.triggers || {};
  const mode = String(w.autoMode || 'scalp').toLowerCase();
  return {
    enabled: w.enabled === true, // 명시적 false 만 끔으로 본다
    intervalSec: clampNum(w.intervalSec, MIN_INTERVAL_SEC, 3600, 60),
    movePct: clampNum(t.movePct, 0.01, 100, 1.5),
    windowMin: Math.round(clampNum(t.windowMin, 1, 120, 15)),
    volumeMultiple: clampNum(t.volumeMultiple, 1.1, 100, 2.5),
    fundingAbs: clampNum(t.fundingAbs, 0.0001, 10, 0.05),
    premiumPct: clampNum(t.premiumPct, 0.01, 100, 1.0),
    autoAnalyze: !!w.autoAnalyze,
    autoMode: ['algo', 'scalp', 'attack'].includes(mode) ? mode : 'scalp',
    cooldownMin: clampNum(w.cooldownMin, 0, 1440, 30),
    autoGapMin: clampNum(w.autoAnalyzeGapMin, 0, 1440, AUTO_GAP_DEFAULT_MIN),
    quietHours: Array.isArray(w.quietHours) ? w.quietHours : [],
    watchlist: Array.isArray(cfg && cfg.watchlist)
      ? cfg.watchlist.filter((s) => typeof s === 'string' && s.trim())
      : [],
  };
}

let alertSeq = 0;
function nextId() {
  alertSeq = (alertSeq + 1) % 1e6;
  return `w${Date.now().toString(36)}${alertSeq.toString(36)}`;
}

// --- Watcher ------------------------------------------------------------

class Watcher extends EventEmitter {
  // opts: { engine, config, notify, fetchImpl }
  //   notify    — 생략 시 ./notify 사용. null 을 주면 텔레그램 발송을 끈다.
  //   fetchImpl — 테스트용 fetch 주입.
  constructor(opts = {}) {
    super();
    this.setMaxListeners(0);
    this.engine = opts.engine || null;
    this._config = makeConfigReader(opts.config);
    this._notify =
      opts.notify === null
        ? null
        : opts.notify || (() => {
            try {
              return require('./notify');
            } catch (_) {
              return null;
            }
          })();
    this._fetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (...a) => fetch(...a);

    this._started = false;
    this._timer = null;
    this._ticking = false;
    this._warnedDisabled = false;
    // stop() 이 불리면 증가한다. 진행 중이던 주기가 남은 심볼을 계속 긁지 않게 하는 용도.
    this._gen = 0;

    this.alerts = []; // 최근 알림 (최신이 앞)
    this._cooldown = new Map(); // `${symbol}|${kind}` -> ts
    this._last = new Map(); // symbol -> 마지막 조회 스냅샷
    this._fxCache = { ts: 0, rate: null, source: null };
    this._fxRetryAt = 0;
    this._krxCache = new Map(); // yahoo 심볼 -> { ts, price }
    this._krxRetryAt = new Map();

    this.lastTickAt = null;
    this.lastError = null;
    this.tickCount = 0;
    this.alertCount = 0;
    this.lastAutoAnalyzeAt = null;
    this.lastAutoAnalyze = null;
  }

  // --- 수명주기 ---------------------------------------------------------

  start() {
    if (this._started) return this.status();
    this._started = true;
    this._warnedDisabled = false;
    this._arm(1000); // 서버 부팅 직후 몰리지 않게 1초 뒤 첫 조회
    return this.status();
  }

  stop() {
    this._started = false;
    this._gen += 1; // 진행 중인 주기를 중단시킨다
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return this.status();
  }

  // 타이머는 unref — 감시가 살아 있다는 이유로 프로세스가 안 죽는 일이 없게 한다
  // (프로세스 수명은 HTTP 서버가 잡는다).
  _arm(delayMs) {
    if (!this._started) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._tick()
        .catch((e) => {
          this.lastError = e && e.message ? e.message : String(e);
        })
        .finally(() => {
          const w = readWatchCfg(this._config());
          this._arm(w.intervalSec * 1000);
        });
    }, Math.max(50, Number(delayMs) || 1000));
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  // --- 주기 실행 --------------------------------------------------------

  async _tick() {
    if (this._ticking) return; // 이전 주기가 안 끝났으면 이번 주기는 건너뛴다
    this._ticking = true;
    try {
      const cfg = this._config();
      const w = readWatchCfg(cfg);

      if (!w.enabled) {
        if (!this._warnedDisabled) {
          this._warnedDisabled = true;
          console.error(
            '[watcher] 루프는 켰지만 config.watcher.enabled=false 라 시세 조회를 건너뜁니다.'
          );
        }
        return;
      }
      this._warnedDisabled = false;

      const now = new Date();
      const quiet = inQuietHours(w.quietHours, now);

      const gen = this._gen;
      for (const raw of w.watchlist) {
        if (this._gen !== gen) break; // 도중에 stop() 이 불렸다
        try {
          await this._checkSymbol(raw, cfg, w, quiet);
        } catch (e) {
          // 심볼 하나가 죽어도 나머지는 계속 본다.
          const msg = e && e.message ? e.message : String(e);
          this.lastError = `${raw}: ${msg}`;
          const prev = this._last.get(String(raw).toUpperCase()) || {};
          this._last.set(String(raw).toUpperCase(), {
            ...prev,
            symbol: String(raw).toUpperCase(),
            checkedAt: Date.now(),
            error: msg,
          });
        }
      }
      this.tickCount += 1;
      this.lastTickAt = Date.now();
    } finally {
      this._ticking = false;
    }
  }

  async _checkSymbol(raw, cfg, w, quiet) {
    const resolved = resolveSymbol(raw);
    const name = resolved.nameKo || resolved.display || resolved.symbol;
    const limit = Math.min(KLINE_MAX_BARS, Math.max(w.windowMin + 1, KLINE_MIN_BARS));

    let probe;
    if (resolved.kind === 'crypto') probe = await this._probeCrypto(resolved, limit);
    else if (resolved.kind === 'krstock') probe = await this._probeKrPerp(resolved, limit);
    else probe = await this._probeStock(resolved, limit);

    // 괴리(premium)는 KRX 현물 + 환율이 더 필요해서 별도 주기로 돈다.
    let premiumPct = null;
    if (resolved.kind === 'krstock' && probe.price != null) {
      premiumPct = await this._maybePremium(resolved, probe.price);
    }

    const snapshot = {
      symbol: resolved.symbol,
      display: name,
      kind: resolved.kind,
      price: probe.price,
      priceText: probe.price != null ? `${probe.cs}${fmtNum(probe.price)}` : null,
      changePct24h: probe.changePct,
      fundingPct: probe.fundingPct,
      premiumPct,
      source: probe.source,
      checkedAt: Date.now(),
      error: null,
    };
    this._last.set(resolved.symbol, snapshot);

    const candidates = this._evaluate(resolved, name, probe, premiumPct, w);
    for (const c of candidates) {
      this._raise(c, cfg, w, quiet);
    }
  }

  // --- 트리거 판정 ------------------------------------------------------

  _evaluate(resolved, name, probe, premiumPct, w) {
    const out = [];
    const cs = probe.cs || '$';
    const priceText = probe.price != null ? `${cs}${fmtNum(probe.price)}` : null;
    const base = {
      symbol: resolved.symbol,
      display: name,
      price: probe.price,
      priceText,
    };

    // 1) 이동 — windowMin 분 전 종가 대비 현재가
    const closes = probe.closes || [];
    if (closes.length > w.windowMin) {
      const ref = closes[closes.length - 1 - w.windowMin];
      const cur = probe.price != null ? probe.price : closes[closes.length - 1];
      if (Number.isFinite(ref) && ref !== 0 && Number.isFinite(cur)) {
        const movePct = ((cur - ref) / ref) * 100;
        if (Math.abs(movePct) >= w.movePct) {
          out.push({
            ...base,
            kind: 'move',
            severity: severityOf(movePct, w.movePct),
            value: Number(movePct.toFixed(4)),
            threshold: w.movePct,
            message:
              `${name} ${w.windowMin}분 ${pctStr(movePct)} (기준 ${w.movePct}%)` +
              (priceText ? ` · 현재 ${priceText}` : ''),
          });
        }
      }
    }

    // 2) 거래량 — 직전 '완성된' 1분봉 vs 그 이전 봉 평균
    //    (마지막 봉은 진행 중이라 항상 작게 잡히므로 제외한다)
    const vols = probe.vols || [];
    if (vols.length >= VOL_BASE_MIN + 2) {
      const lastVol = vols[vols.length - 2];
      const baseVols = vols.slice(0, vols.length - 2);
      const avg = mean(baseVols.slice(-30));
      if (Number.isFinite(lastVol) && avg && avg > 0) {
        const mult = lastVol / avg;
        if (mult >= w.volumeMultiple) {
          out.push({
            ...base,
            kind: 'volume',
            severity: severityOf(mult, w.volumeMultiple),
            value: Number(mult.toFixed(2)),
            threshold: w.volumeMultiple,
            message:
              `${name} 1분 거래량 ${mult.toFixed(1)}배 (기준 ${w.volumeMultiple}배)` +
              (priceText ? ` · 현재 ${priceText}` : ''),
          });
        }
      }
    }

    // 3) 펀딩비 — 무기한 선물이 있는 심볼만 값이 들어온다
    if (probe.fundingPct != null && Math.abs(probe.fundingPct) >= w.fundingAbs) {
      out.push({
        ...base,
        kind: 'funding',
        severity: severityOf(probe.fundingPct, w.fundingAbs),
        value: Number(probe.fundingPct.toFixed(6)),
        threshold: w.fundingAbs,
        message:
          `${name} 펀딩비 ${pctStr(probe.fundingPct, 4)} (기준 ${w.fundingAbs}%) · ` +
          `${probe.fundingPct >= 0 ? '롱이 숏에게 지불' : '숏이 롱에게 지불'}`,
      });
    }

    // 4) 괴리 — 무기한 원화환산 vs KRX 현물
    if (premiumPct != null && Math.abs(premiumPct) >= w.premiumPct) {
      out.push({
        ...base,
        kind: 'premium',
        severity: severityOf(premiumPct, w.premiumPct),
        value: Number(premiumPct.toFixed(4)),
        threshold: w.premiumPct,
        message:
          `${name} 선물↔KRX 괴리 ${pctStr(premiumPct)} (기준 ${w.premiumPct}%)` +
          (priceText ? ` · 무기한 ${priceText}` : ''),
      });
    }

    return out;
  }

  // 쿨다운 통과 → 기록·방송·(조용시간이 아니면) 텔레그램·자동분석
  _raise(candidate, cfg, w, quiet) {
    const key = `${candidate.symbol}|${candidate.kind}`;
    const now = Date.now();
    const last = this._cooldown.get(key) || 0;
    if (now - last < w.cooldownMin * 60000) return; // 같은 심볼·같은 종류는 쿨다운 중
    this._cooldown.set(key, now);

    const alert = {
      id: nextId(),
      ts: now,
      symbol: candidate.symbol,
      display: candidate.display,
      kind: candidate.kind,
      severity: candidate.severity,
      message: candidate.message,
      value: candidate.value,
      threshold: candidate.threshold,
      price: candidate.price,
      // 계약 외 부가 필드 — 화면·텔레그램 표기 편의용
      priceText: candidate.priceText,
      quiet: !!quiet,
    };

    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS;
    this.alertCount += 1;

    // 방송은 조용시간에도 한다(기록·화면은 살아 있어야 한다).
    try {
      this.emit('alert', alert);
    } catch (e) {
      console.error('[watcher] alert 리스너 오류:', e && e.message ? e.message : e);
    }

    if (quiet) return; // 조용시간: 텔레그램·자동분석 금지

    this._sendAlert(alert, cfg);
    this._maybeAutoAnalyze(alert, cfg, w);
  }

  _sendAlert(alert, cfg) {
    if (!this._notify || typeof this._notify.sendAlert !== 'function') return;
    try {
      const p = this._notify.sendAlert(alert, cfg);
      if (p && typeof p.catch === 'function') {
        p.catch((e) => console.error('[watcher] 알림 발송 실패:', e && e.message ? e.message : e));
      }
    } catch (e) {
      console.error('[watcher] 알림 발송 오류:', e && e.message ? e.message : e);
    }
  }

  // --- 자동 분석 --------------------------------------------------------

  _maybeAutoAnalyze(alert, cfg, w) {
    if (!w.autoAnalyze) return;
    if (!this.engine || typeof this.engine.run !== 'function') return;

    // 진행 중이면 그냥 버린다 — 큐잉하지 않는다(시장은 이미 변했다).
    if (this.engine.running) {
      this.lastAutoAnalyze = {
        ts: Date.now(),
        symbol: alert.symbol,
        result: '건너뜀(분석 진행 중)',
      };
      return;
    }
    // 전역 최소 간격 — claude 호출은 비싸다. 여러 심볼이 동시에 터져도 연쇄 실행을 막는다.
    const gapMs = w.autoGapMin * 60000;
    if (gapMs > 0 && this.lastAutoAnalyzeAt && Date.now() - this.lastAutoAnalyzeAt < gapMs) {
      this.lastAutoAnalyze = {
        ts: Date.now(),
        symbol: alert.symbol,
        result: `건너뜀(자동분석 최소 간격 ${w.autoGapMin}분)`,
      };
      return;
    }

    this.lastAutoAnalyzeAt = Date.now();
    this.lastAutoAnalyze = {
      ts: Date.now(),
      symbol: alert.symbol,
      mode: w.autoMode,
      result: '실행',
    };
    // 감시 루프를 붙잡지 않도록 분리 실행한다.
    this._runAndNotify(alert, w.autoMode, cfg).catch((e) => {
      console.error('[watcher] 자동분석 오류:', e && e.message ? e.message : e);
    });
  }

  // engine.run 을 돌리면서 SSE 이벤트를 가로채 판정을 모으고, 끝나면 텔레그램으로 보낸다.
  async _runAndNotify(alert, mode, cfg) {
    const engine = this.engine;
    const cap = { decision: null, market: null, saved: null, error: null, display: alert.symbol };
    const onEvt = (evt) => {
      if (!evt || !evt.type) return;
      if (evt.type === 'run:start') cap.display = evt.display || cap.display;
      else if (evt.type === 'market') cap.market = evt;
      else if (evt.type === 'decision') cap.decision = evt;
      else if (evt.type === 'saved') cap.saved = evt.path;
      else if (evt.type === 'run:error') cap.error = evt.message;
    };
    let busy = false;
    engine.on('event', onEvt);
    try {
      await engine.run(alert.symbol, { mode });
    } catch (e) {
      // engine 은 동시 실행을 409 로 거절한다. 이건 '실패'가 아니라 경합이므로
      // 텔레그램으로 알리지 않는다(그냥 이번 알림은 버린다).
      busy = e && e.code === 409;
      cap.error = e && e.message ? e.message : String(e);
    } finally {
      engine.removeListener('event', onEvt);
    }

    this.lastAutoAnalyze = {
      ts: Date.now(),
      symbol: alert.symbol,
      mode,
      result: cap.decision
        ? `판정 ${cap.decision.action}`
        : busy
        ? '건너뜀(분석 진행 중)'
        : cap.error
        ? '실패'
        : '판정 없음',
      message: busy ? null : cap.error || null,
    };

    if (!this._notify || busy) return;
    try {
      if (cap.decision) {
        const decision = {
          ...cap.decision,
          symbol: cap.display,
          mode,
          reportPath: cap.saved,
        };
        const market = cap.market
          ? { ...cap.market, display: cap.display }
          : { display: cap.display };
        await this._notify.sendDecision(decision, market, cfg);
      } else if (cap.error && typeof this._notify.sendMessage === 'function') {
        await this._notify.sendMessage(
          `⚠️ <b>자동분석 실패</b> · ${esc(alert.display || alert.symbol)}\n` +
            `${esc(cap.error)}\n\n— AI 시뮬레이션, 투자 조언 아님`,
          cfg
        );
      }
    } catch (e) {
      console.error('[watcher] 자동분석 알림 실패:', e && e.message ? e.message : e);
    }
  }

  // --- 시세 조회 (전부 최소 호출) ---------------------------------------

  async _json(url, headers) {
    const res = await this._fetch(url, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      ...(headers ? { headers } : {}),
    });
    if (!res || !res.ok) {
      throw new Error(`HTTP ${res && res.status != null ? res.status : '?'}`);
    }
    return res.json();
  }

  // Binance kline 배열 → { closes, vols }
  static _klines(arr) {
    if (!Array.isArray(arr) || !arr.length) return { closes: [], vols: [] };
    return {
      closes: arr.map((k) => num(k[4])),
      vols: arr.map((k) => num(k[5])),
    };
  }

  // 코인: 현물 1분봉 + 24hr ticker (+ 무기한 펀딩. 무기한이 없으면 그냥 null)
  async _probeCrypto(resolved, limit) {
    const pair = `${resolved.symbol}USDT`;
    const [kR, tR, fR] = await Promise.allSettled([
      this._json(`${BINANCE_SPOT}/klines?symbol=${pair}&interval=1m&limit=${limit}`),
      this._json(`${BINANCE_SPOT}/ticker/24hr?symbol=${pair}`),
      this._json(`${BINANCE_FAPI}/premiumIndex?symbol=${pair}`),
    ]);
    if (kR.status !== 'fulfilled' && tR.status !== 'fulfilled') {
      throw new Error('바이낸스 시세 조회 실패');
    }
    const k = kR.status === 'fulfilled' ? Watcher._klines(kR.value) : { closes: [], vols: [] };
    const t = tR.status === 'fulfilled' ? tR.value : {};
    const f = fR.status === 'fulfilled' ? fR.value : {};
    const price =
      num(t.lastPrice) != null
        ? num(t.lastPrice)
        : k.closes.length
        ? k.closes[k.closes.length - 1]
        : null;
    return {
      price,
      changePct: num(t.priceChangePercent),
      closes: k.closes,
      vols: k.vols,
      fundingPct: f.lastFundingRate != null ? num(f.lastFundingRate) * 100 : null,
      cs: '$',
      source: `바이낸스 현물 ${pair}`,
    };
  }

  // 한국주식: 체결이 일어나는 USDⓈ-M 무기한 축(CLAUDE.md 이중 가격 체계).
  async _probeKrPerp(resolved, limit) {
    const perpSym = ((KR_STOCKS[resolved.symbol] || {}).perps || {}).binance || null;
    if (!perpSym) throw new Error('무기한 선물 미상장(바이낸스)');
    const [kR, tR, fR] = await Promise.allSettled([
      this._json(`${BINANCE_FAPI}/klines?symbol=${perpSym}&interval=1m&limit=${limit}`),
      this._json(`${BINANCE_FAPI}/ticker/24hr?symbol=${perpSym}`),
      this._json(`${BINANCE_FAPI}/premiumIndex?symbol=${perpSym}`),
    ]);
    if (kR.status !== 'fulfilled' && tR.status !== 'fulfilled') {
      throw new Error('무기한 시세 조회 실패');
    }
    const k = kR.status === 'fulfilled' ? Watcher._klines(kR.value) : { closes: [], vols: [] };
    const t = tR.status === 'fulfilled' ? tR.value : {};
    const f = fR.status === 'fulfilled' ? fR.value : {};
    const price =
      num(t.lastPrice) != null
        ? num(t.lastPrice)
        : k.closes.length
        ? k.closes[k.closes.length - 1]
        : null;
    return {
      price,
      changePct: num(t.priceChangePercent),
      closes: k.closes,
      vols: k.vols,
      fundingPct: f.lastFundingRate != null ? num(f.lastFundingRate) * 100 : null,
      cs: '$',
      source: `바이낸스 무기한 ${perpSym}`,
    };
  }

  // 해외주식: Yahoo 1분봉 한 번으로 가격·거래량을 모두 얻는다.
  async _probeStock(resolved, limit) {
    const sym = resolved.yahoo || resolved.symbol;
    const d = await this._json(
      `${YAHOO_CHART}/${encodeURIComponent(sym)}?range=1d&interval=1m`,
      YAHOO_HEADERS
    );
    const r = d && d.chart && d.chart.result && d.chart.result[0];
    if (!r) throw new Error('야후 1분봉 없음');
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const closesAll = [];
    const volsAll = [];
    const cl = q.close || [];
    for (let i = 0; i < cl.length; i++) {
      if (cl[i] == null) continue; // 야후는 결측 구간을 null 로 남긴다
      closesAll.push(num(cl[i]));
      volsAll.push(q.volume && q.volume[i] != null ? num(q.volume[i]) : null);
    }
    const m = r.meta || {};
    const price =
      num(m.regularMarketPrice) != null
        ? num(m.regularMarketPrice)
        : closesAll.length
        ? closesAll[closesAll.length - 1]
        : null;
    const prev = num(m.previousClose) != null ? num(m.previousClose) : num(m.chartPreviousClose);
    return {
      price,
      changePct: prev && price != null ? ((price - prev) / prev) * 100 : null,
      closes: closesAll.slice(-limit),
      vols: volsAll.slice(-limit),
      fundingPct: null,
      cs: m.currency === 'KRW' ? '₩' : '$',
      source: `야후 ${sym} 1분봉`,
    };
  }

  // --- 괴리 계산 --------------------------------------------------------
  //
  // 괴리는 매 주기 계산한다(무기한 가격이 매번 새로우니까). 대신 분모인 환율·KRX
  // 종가는 캐시로 재사용해서 야후 호출을 TTL 간격으로만 낸다. KRX 종가는 장 마감
  // 후에는 어차피 고정값이라 캐시해도 정확도가 떨어지지 않는다.
  async _maybePremium(resolved, perpPrice) {
    try {
      const [rate, krx] = await Promise.all([this._usdKrw(), this._krxPrice(resolved.yahoo)]);
      if (!rate || !krx) return null;
      const perpKrw = perpPrice * rate;
      return ((perpKrw - krx) / krx) * 100;
    } catch (_) {
      return null;
    }
  }

  // market.js 와 같은 소스 순서: Yahoo KRW=X → open.er-api.com
  async _usdKrw() {
    const now = Date.now();
    if (this._fxCache.rate && now - this._fxCache.ts < FX_TTL_MS) return this._fxCache.rate;
    if (now < this._fxRetryAt) return this._fxCache.rate; // 직전 실패 — 잠깐 쉰다
    try {
      const d = await this._json(`${YAHOO_CHART}/KRW=X?range=1d&interval=1d`, YAHOO_HEADERS);
      const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      const rate = m ? num(m.regularMarketPrice) : null;
      if (rate) {
        this._fxCache = { ts: now, rate, source: 'Yahoo KRW=X' };
        return rate;
      }
      throw new Error('환율 없음');
    } catch (_) {
      try {
        const d = await this._json(ER_API, { Accept: 'application/json' });
        const rate = d && d.rates ? num(d.rates.KRW) : null;
        if (rate) {
          this._fxCache = { ts: now, rate, source: 'exchangerate-api' };
          return rate;
        }
      } catch (_) {}
      this._fxRetryAt = now + FAIL_RETRY_MS;
      return this._fxCache.rate; // 캐시가 남아 있으면 그거라도 쓴다
    }
  }

  async _krxPrice(yahooSym) {
    if (!yahooSym) return null;
    const now = Date.now();
    const hit = this._krxCache.get(yahooSym);
    if (hit && now - hit.ts < KRX_TTL_MS) return hit.price;
    if (now < (this._krxRetryAt.get(yahooSym) || 0)) return hit ? hit.price : null;
    try {
      const d = await this._json(
        `${YAHOO_CHART}/${encodeURIComponent(yahooSym)}?range=1d&interval=1d`,
        YAHOO_HEADERS
      );
      const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      const price = m ? num(m.regularMarketPrice) : null;
      if (price) {
        this._krxCache.set(yahooSym, { ts: now, price });
        return price;
      }
    } catch (_) {}
    this._krxRetryAt.set(yahooSym, now + FAIL_RETRY_MS);
    return hit ? hit.price : null;
  }

  // --- 상태 -------------------------------------------------------------

  status() {
    const cfg = this._config();
    const w = readWatchCfg(cfg);
    const quiet = inQuietHours(w.quietHours);
    return {
      enabled: !!w.enabled,
      running: !!(this._started && w.enabled),
      started: this._started,
      intervalSec: w.intervalSec,
      watchlist: w.watchlist,
      triggers: {
        movePct: w.movePct,
        windowMin: w.windowMin,
        volumeMultiple: w.volumeMultiple,
        fundingAbs: w.fundingAbs,
        premiumPct: w.premiumPct,
      },
      autoAnalyze: w.autoAnalyze,
      autoMode: w.autoMode,
      cooldownMin: w.cooldownMin,
      quietHours: w.quietHours,
      quiet,
      engineRunning: !!(this.engine && this.engine.running),
      lastTickAt: this.lastTickAt,
      lastTickAgoSec:
        this.lastTickAt != null ? Math.round((Date.now() - this.lastTickAt) / 1000) : null,
      tickCount: this.tickCount,
      alertCount: this.alertCount,
      lastError: this.lastError,
      lastAutoAnalyzeAt: this.lastAutoAnalyzeAt,
      lastAutoAnalyze: this.lastAutoAnalyze,
      symbols: Array.from(this._last.values()),
      alerts: this.alerts.slice(0, MAX_ALERTS),
    };
  }
}

module.exports = { Watcher, inQuietHours, severityOf };
