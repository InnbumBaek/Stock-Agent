'use strict';

// PIXEL TRADING FLOOR — 정기 브리핑 예약 (scheduler)
//
// 계약(docs/v2-contracts.md):
//   class Scheduler { constructor({engine, config, notify}) start() stop() status() }
//   - 분 단위 체크. days: 'daily' | 'weekday'. 실행 후 텔레그램 발송(설정 시).
//
// 설계 원칙
//   - 20초마다 깨어나 'HH:MM' 이 일치하는 잡을 찾는다. **같은 분에는 한 번만 실행한다.**
//   - engine 이 이미 돌고 있으면 건너뛴다(큐잉하지 않는다).
//   - 어떤 실패도 삼킨다. 예약 루프는 죽지 않는다.
//   - 지나간 시각은 소급 실행하지 않는다(서버를 09:00 에 켜도 08:30 잡은 돌지 않는다).

const CHECK_INTERVAL_MS = 20 * 1000; // 분 경계를 놓치지 않을 만큼만 촘촘하게
const MAX_HISTORY = 50;
const MAX_FIRED_KEYS = 300;
const VALID_MODES = ['algo', 'scalp', 'attack'];

// --- 유틸 ---------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function hhmm(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// 'HH:MM' → { h, m } | null
function parseAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, m: mi, at: `${pad2(h)}:${pad2(mi)}` };
}

// days: 'weekday' → 월~금. 그 외 값은 전부 'daily' 로 본다.
function dayOk(days, d) {
  if (String(days || 'daily').toLowerCase() === 'weekday') {
    const w = d.getDay();
    return w >= 1 && w <= 5;
  }
  return true;
}

// config 는 설정 객체 / 최신 설정을 돌려주는 함수 / config.js 모듈 어느 쪽이든 받는다.
function makeConfigReader(src) {
  return function read() {
    try {
      let c = src;
      if (typeof c === 'function') c = c();
      if (c && typeof c.loadConfig === 'function' && !c.schedule && !c.watchlist) {
        c = c.loadConfig();
      }
      if (c && typeof c === 'object') return c;
    } catch (_) {}
    return {};
  };
}

// 잡 목록을 정규화한다. 형식이 깨진 잡은 조용히 버린다(루프를 죽이지 않는다).
function readJobs(cfg) {
  const s = (cfg && cfg.schedule) || {};
  const raw = Array.isArray(s.jobs) ? s.jobs : [];
  const out = [];
  raw.forEach((j, i) => {
    if (!j || typeof j !== 'object') return;
    const t = parseAt(j.at);
    const symbol = typeof j.symbol === 'string' ? j.symbol.trim() : '';
    if (!t || !symbol) return;
    const mode = String(j.mode || 'algo').toLowerCase();
    const days = String(j.days || 'daily').toLowerCase() === 'weekday' ? 'weekday' : 'daily';
    out.push({
      index: i,
      at: t.at,
      h: t.h,
      m: t.m,
      symbol,
      mode: VALID_MODES.includes(mode) ? mode : 'algo',
      days,
      enabled: j.enabled !== false,
    });
  });
  return out;
}

// 다음 실행 예정 시각(ms). 오늘 이미 지났거나 요일이 안 맞으면 다음 해당일로 넘긴다.
function nextRunAt(job, from) {
  const base = from ? new Date(from) : new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, job.h, job.m, 0, 0);
    if (d.getTime() <= base.getTime()) continue;
    if (!dayOk(job.days, d)) continue;
    return d.getTime();
  }
  return null;
}

// --- Scheduler ----------------------------------------------------------

class Scheduler {
  // opts: { engine, config, notify }
  //   notify — 생략 시 ./notify. null 을 주면 텔레그램 발송을 끈다.
  constructor(opts = {}) {
    this.engine = opts.engine || null;
    this._config = makeConfigReader(opts.config);
    this._notify =
      opts.notify === null
        ? null
        : opts.notify ||
          (() => {
            try {
              return require('./notify');
            } catch (_) {
              return null;
            }
          })();

    this._started = false;
    this._timer = null;
    this._ticking = false;
    this._fired = new Set(); // `${날짜} ${HH:MM} ${symbol} ${mode}` — 같은 분 중복 방지
    this._firedOrder = [];
    this._warnedDisabled = false;

    this.history = []; // 최근 실행 이력 (최신이 앞)
    this.lastTickAt = null;
    this.lastError = null;
    this.runCount = 0;
  }

  // --- 수명주기 ---------------------------------------------------------

  start() {
    if (this._started) return this.status();
    this._started = true;
    this._warnedDisabled = false;
    // 켜는 순간의 분은 이미 지나간 것으로 본다(부팅 직후 소급 실행 방지).
    this._seal(new Date());
    this._arm(1000);
    return this.status();
  }

  stop() {
    this._started = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return this.status();
  }

  // 시작 시점의 현재 분을 '이미 실행됨'으로 막아둔다.
  _seal(now) {
    const jobs = readJobs(this._config());
    const key = `${dateKey(now)} ${hhmm(now)}`;
    for (const j of jobs) {
      if (j.at === hhmm(now)) this._markFired(`${key} ${j.symbol} ${j.mode}`);
    }
  }

  _markFired(key) {
    if (this._fired.has(key)) return false;
    this._fired.add(key);
    this._firedOrder.push(key);
    while (this._firedOrder.length > MAX_FIRED_KEYS) {
      this._fired.delete(this._firedOrder.shift());
    }
    return true;
  }

  // 타이머 unref — 예약 루프가 프로세스를 붙잡지 않게 한다(수명은 HTTP 서버가 잡는다).
  _arm(delayMs) {
    if (!this._started) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        this._tick();
      } catch (e) {
        this.lastError = e && e.message ? e.message : String(e);
      }
      this._arm(CHECK_INTERVAL_MS);
    }, Math.max(50, Number(delayMs) || CHECK_INTERVAL_MS));
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  // --- 분 단위 체크 -----------------------------------------------------

  _tick(nowArg) {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const now = nowArg ? new Date(nowArg) : new Date();
      this.lastTickAt = now.getTime();

      const cfg = this._config();
      const s = (cfg && cfg.schedule) || {};
      if (s.enabled === false) {
        if (!this._warnedDisabled) {
          this._warnedDisabled = true;
          console.error(
            '[scheduler] 루프는 켰지만 config.schedule.enabled=false 라 잡을 실행하지 않습니다.'
          );
        }
        return;
      }
      this._warnedDisabled = false;

      const cur = hhmm(now);
      const dk = dateKey(now);
      for (const job of readJobs(cfg)) {
        if (!job.enabled) continue;
        if (job.at !== cur) continue;
        if (!dayOk(job.days, now)) continue;
        const key = `${dk} ${cur} ${job.symbol} ${job.mode}`;
        if (!this._markFired(key)) continue; // 같은 분에는 한 번만
        this._fire(job, cfg, now);
      }
    } finally {
      this._ticking = false;
    }
  }

  _fire(job, cfg, now) {
    if (!this.engine || typeof this.engine.run !== 'function') {
      this._record(job, now, '실패', '엔진이 연결되지 않음');
      return;
    }
    if (this.engine.running) {
      // 큐잉하지 않는다 — 예약 브리핑은 그 시각의 시장을 보는 것이 목적이다.
      this._record(job, now, '건너뜀', '다른 분석이 진행 중');
      return;
    }
    this.runCount += 1;
    this._record(job, now, '실행', null);
    this._runAndNotify(job, cfg).catch((e) => {
      console.error('[scheduler] 예약 실행 오류:', e && e.message ? e.message : e);
    });
  }

  // engine.run 을 돌리며 SSE 이벤트를 가로채 판정을 모으고, 끝나면 텔레그램으로 보낸다.
  async _runAndNotify(job, cfg) {
    const engine = this.engine;
    const cap = { decision: null, market: null, saved: null, error: null, display: job.symbol };
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
      await engine.run(job.symbol, { mode: job.mode });
    } catch (e) {
      // engine 은 동시 실행을 409 로 거절한다. 경합은 '실패'가 아니므로 알리지 않는다.
      busy = e && e.code === 409;
      cap.error = e && e.message ? e.message : String(e);
    } finally {
      engine.removeListener('event', onEvt);
    }

    this._patchLast(
      cap.decision
        ? `판정 ${cap.decision.action}`
        : busy
        ? '건너뜀'
        : cap.error
        ? '실패'
        : '판정 없음',
      busy ? '다른 분석이 진행 중' : cap.error || null
    );

    if (!this._notify || busy) return;
    try {
      if (cap.decision) {
        const decision = {
          ...cap.decision,
          symbol: cap.display,
          mode: job.mode,
          reportPath: cap.saved,
        };
        const market = cap.market
          ? { ...cap.market, display: cap.display }
          : { display: cap.display };
        await this._notify.sendDecision(decision, market, cfg);
      } else if (cap.error && typeof this._notify.sendMessage === 'function') {
        await this._notify.sendMessage(
          `⚠️ <b>예약 브리핑 실패</b> · ${esc(job.symbol)} (${esc(job.at)})\n` +
            `${esc(cap.error)}\n\n— AI 시뮬레이션, 투자 조언 아님`,
          cfg
        );
      }
    } catch (e) {
      console.error('[scheduler] 예약 알림 실패:', e && e.message ? e.message : e);
    }
  }

  // --- 이력 -------------------------------------------------------------

  _record(job, now, result, message) {
    this.history.unshift({
      ts: (now || new Date()).getTime(),
      at: job.at,
      symbol: job.symbol,
      mode: job.mode,
      days: job.days,
      result,
      message: message || null,
    });
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
  }

  _patchLast(result, message) {
    if (!this.history.length) return;
    this.history[0].result = result;
    this.history[0].message = message;
    this.history[0].doneAt = Date.now();
  }

  // --- 상태 -------------------------------------------------------------

  status() {
    const cfg = this._config();
    const s = (cfg && cfg.schedule) || {};
    const enabled = s.enabled !== false;
    const now = Date.now();
    const jobs = readJobs(cfg).map((j) => {
      const last = this.history.find((h) => h.at === j.at && h.symbol === j.symbol) || null;
      return {
        at: j.at,
        symbol: j.symbol,
        mode: j.mode,
        days: j.days,
        enabled: j.enabled,
        nextRunAt: j.enabled && enabled ? nextRunAt(j, now) : null,
        lastRunAt: last ? last.ts : null,
        lastResult: last ? last.result : null,
      };
    });
    return {
      enabled,
      running: !!(this._started && enabled),
      started: this._started,
      checkIntervalSec: CHECK_INTERVAL_MS / 1000,
      jobCount: jobs.length,
      jobs,
      runCount: this.runCount,
      engineRunning: !!(this.engine && this.engine.running),
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      history: this.history.slice(0, MAX_HISTORY),
    };
  }
}

module.exports = { Scheduler, parseAt, dayOk, nextRunAt };
