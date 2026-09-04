'use strict';

// PIXEL TRADING FLOOR — 워치리스트 일괄 스캔
//
// 워치리스트의 심볼을 하나씩 엔진에 태워 분석하고, 결과를 "지금 볼 만한 순서"로
// 정렬해 돌려준다.
//
// 설계 근거
//  - 엔진은 동시 1건만 돈다(engine.running 가드 → 두 번째 run은 409로 throw).
//    그래서 반드시 **순차** 실행이고, 다음 심볼을 시작하기 전에 이전 런이
//    완전히 끝났음을 확인해야 한다.
//  - 완료 감지는 이중으로 한다.
//      (1) engine의 'event' 이벤트에서 run:end 를 본다  ← 파이프라인의 진짜 종료 신호
//      (2) engine.run()이 반환할 때까지 await             ← running 플래그 해제 보장
//    engine.js의 finally는 `_emit(run:end)` → `running = false` 순서라서,
//    run:end만 보고 곧바로 다음 run을 부르면 409가 날 수 있다. 그래서 (2)가 필수다.
//    그래도 못 미더운 경우를 대비해 실행 직전에 running 해제를 폴링으로 한 번 더 확인한다.
//  - 판정 결과(action/confidence/rr/scalpBias)는 engine.run()의 반환값이 아니라
//    'decision' 이벤트에서만 얻을 수 있으므로 리스너 수집이 유일한 경로다.
//  - 한 종목이 실패해도 스캔 전체는 계속된다. 실패 건은 랭킹 최하위로 내려간다.
//
// 외부 의존성 0 (Node 내장만). 실주문 없음.

const DEFAULT_MODE = 'algo';
const VALID_MODES = new Set(['algo', 'scalp', 'attack']);

// 스캔 시작 전 엔진이 비기를 기다리는 최대 시간 (다른 분석이 돌고 있을 수 있다)
const ENGINE_FREE_TIMEOUT_MS = 10 * 60 * 1000;
const ENGINE_FREE_POLL_MS = 100;
// run()이 반환했는데도 run:end를 못 본 비정상 상황에서의 여유 시간
const RUN_END_GRACE_MS = 2000;

// 동시에 두 개의 스캔이 돌면 서로의 engine.run이 409로 충돌한다. 모듈 단위로 막는다.
let scanning = false;
let cancelRequested = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 조건이 참이 될 때까지 폴링. 시간 안에 못 만족하면 false.
async function waitUntil(fn, timeoutMs, pollMs) {
  if (fn()) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (fn()) return true;
  }
  return !!fn();
}

function errMessage(e) {
  if (!e) return '알 수 없는 오류';
  return e.message ? String(e.message) : String(e);
}

// 문자열/숫자 무엇이 와도 유한한 숫자만 통과시킨다. 없으면 null (추정값을 만들지 않는다).
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function upper(v) {
  return v == null ? '' : String(v).trim().toUpperCase();
}

// 워치리스트 정규화 — 공백 제거, 빈 값 제거, 대소문자 무시 중복 제거(입력 순서 유지)
function normalizeSymbols(symbols) {
  if (!Array.isArray(symbols)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of symbols) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s) continue;
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// 콜백이 터져도 스캔은 멈추지 않는다 (진행 알림은 부가 기능).
function safeProgress(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(payload);
  } catch (e) {
    console.error('[scanner] onProgress 콜백 오류:', errMessage(e));
  }
}

// 랭킹 등급
//   2 = 실행 가능한 방향 판정 (BUY/SELL 또는 스캘핑 LONG/SHORT)
//   1 = 관망 (HOLD / PASS / 그 밖)
//   0 = 분석 실패 — 항상 최하위
function tierOf(item) {
  if (!item.ok) return 0;
  const a = upper(item.action);
  if (a === 'BUY' || a === 'SELL') return 2;
  const b = upper(item.scalpBias);
  if (b === 'LONG' || b === 'SHORT') return 2;
  return 1;
}

// 사전식(lexicographic) 점수: 등급 → 손익비 → 확신도 순으로 엄격히 우선한다.
//  - 손익비는 소수 둘째 자리까지(0.00~9.99), 100배 해서 정수 자리로 올린다
//  - 확신도 최대 100 < 1000 이므로 손익비 0.01 차이도 확신도 100 차이를 이긴다
//  - 손익비가 없으면(null) 0으로 둔다. 없는 값을 지어내지 않는다.
function scoreOf(item) {
  const tier = item.tier;
  const rrPart = item.rr != null ? Math.max(0, Math.min(999, Math.round(item.rr * 100))) : 0;
  const conf = Math.max(0, Math.min(100, Math.round(Number(item.confidence) || 0)));
  return tier * 1000000 + rrPart * 1000 + conf;
}

// 심볼 1건 실행 — 이벤트를 수집하면서 완료를 기다린다. 절대 throw 하지 않는다.
async function runOne(engine, symbol, { mode, mock }) {
  const startedAt = Date.now();
  const collected = {
    symbol,
    display: symbol,
    mode,
    ok: false,
    action: null,
    confidence: null,
    rr: null,
    rrSource: null,
    scalpBias: null,
    verdict: null,
    riskOk: null,
    riskReasons: [],
    savedPath: null,
    error: null,
  };

  let sawRunEnd = false;
  const onEvent = (evt) => {
    if (!evt || typeof evt !== 'object') return;
    switch (evt.type) {
      case 'run:start':
        if (evt.display) collected.display = String(evt.display);
        if (evt.symbol) collected.symbol = String(evt.symbol);
        if (evt.mode) collected.mode = String(evt.mode);
        break;
      case 'risk':
        // 리스크 게이트 결과 (engine.js 통합 후 발생). 손익비 2차 출처.
        if (collected.rr == null) {
          const rr = toNumber(evt.rr);
          if (rr != null) {
            collected.rr = rr;
            collected.rrSource = 'risk';
          }
        }
        if (typeof evt.ok === 'boolean') collected.riskOk = evt.ok;
        if (Array.isArray(evt.reasons)) collected.riskReasons = evt.reasons.map(String);
        break;
      case 'decision': {
        collected.ok = true;
        collected.action = upper(evt.action) || 'HOLD';
        collected.confidence = toNumber(evt.confidence);
        // 손익비 1차 출처 — decision 이벤트에 실려 오면 그걸 우선한다.
        const rr = toNumber(evt.rr);
        if (rr != null) {
          collected.rr = rr;
          collected.rrSource = 'decision';
        }
        if (evt.scalp && typeof evt.scalp === 'object' && evt.scalp.bias) {
          collected.scalpBias = upper(evt.scalp.bias);
        }
        if (evt.verdict) collected.verdict = upper(evt.verdict);
        if (Array.isArray(evt.riskReasons) && !collected.riskReasons.length) {
          collected.riskReasons = evt.riskReasons.map(String);
        }
        break;
      }
      case 'saved':
        if (evt.path) collected.savedPath = String(evt.path);
        break;
      case 'run:error':
        collected.error = evt.message ? String(evt.message) : '분석 실패';
        break;
      case 'run:end':
        sawRunEnd = true;
        break;
      default:
        break;
    }
  };

  engine.on('event', onEvent);
  try {
    // (2) run()이 반환하면 engine.running 은 이미 해제된 상태다.
    await engine.run(symbol, { mode, mock });
    // (1) 정상 경로라면 여기서 sawRunEnd 는 이미 true. 아니면 잠깐만 더 기다린다.
    if (!sawRunEnd) {
      await waitUntil(() => sawRunEnd, RUN_END_GRACE_MS, ENGINE_FREE_POLL_MS);
    }
  } catch (e) {
    // engine.run 자체가 던지는 경우는 "이미 분석이 진행 중"(409) 정도다.
    collected.error = collected.error || errMessage(e);
  } finally {
    engine.removeListener('event', onEvent);
  }

  // decision 이벤트를 못 봤으면 판정이 없는 것이다 — 실패로 처리한다.
  if (!collected.ok && !collected.error) {
    collected.error = '판정(decision) 이벤트를 받지 못했습니다.';
  }
  if (collected.error) collected.ok = false;

  collected.durationMs = Date.now() - startedAt;
  return collected;
}

/**
 * 워치리스트 일괄 스캔.
 *
 * @param {object}   o
 * @param {object}   o.engine      Engine 인스턴스 (EventEmitter, run()/running 보유)
 * @param {string[]} o.symbols     스캔할 심볼 배열
 * @param {string}   [o.mode]      'algo' | 'scalp' | 'attack' (기본 algo)
 * @param {Function} [o.onProgress] 진행 알림 콜백 — 서버가 SSE 'scan' 이벤트로 중계한다
 * @param {boolean}  [o.mock]      데모(목업) 실행 여부. demo 로도 받는다 — 계약 외 확장
 * @param {number}   [o.waitMs]    엔진이 비기를 기다리는 최대 시간(ms) — 계약 외 확장
 * @returns {Promise<Array>} ranking — 점수 내림차순 정렬된 결과 배열
 */
async function scanWatchlist(o) {
  const opts = o || {};
  const engine = opts.engine;
  if (!engine || typeof engine.run !== 'function' || typeof engine.on !== 'function') {
    throw new Error('scanWatchlist: engine(Engine 인스턴스)이 필요합니다.');
  }
  if (scanning) {
    const err = new Error('이미 일괄 스캔이 진행 중입니다.');
    err.code = 409;
    throw err;
  }

  const mode = VALID_MODES.has(opts.mode) ? opts.mode : DEFAULT_MODE;
  const mock = !!(opts.mock || opts.demo);
  const onProgress = opts.onProgress;
  const freeTimeout = Number.isFinite(opts.waitMs) && opts.waitMs > 0
    ? opts.waitMs
    : ENGINE_FREE_TIMEOUT_MS;
  const symbols = normalizeSymbols(opts.symbols);

  if (!symbols.length) {
    const payload = {
      type: 'scan',
      phase: 'done',
      total: 0,
      ok: 0,
      failed: 0,
      mode,
      ranking: [],
      reason: '스캔할 심볼이 없습니다(워치리스트가 비어 있음).',
      ts: new Date().toISOString(),
    };
    safeProgress(onProgress, payload);
    return [];
  }

  scanning = true;
  cancelRequested = false;
  const results = [];
  let cancelled = false;
  let abortReason = null;

  try {
    safeProgress(onProgress, {
      type: 'scan',
      phase: 'start',
      total: symbols.length,
      symbols: symbols.slice(),
      mode,
      mock,
      ts: new Date().toISOString(),
    });

    for (let i = 0; i < symbols.length; i++) {
      if (cancelRequested) {
        cancelled = true;
        break;
      }
      const symbol = symbols[i];

      // 엔진이 비어 있는지 확인 — 수동 분석이 돌고 있으면 끝날 때까지 기다린다.
      const free = await waitUntil(() => !engine.running, freeTimeout, ENGINE_FREE_POLL_MS);
      if (!free) {
        abortReason = `엔진이 ${Math.round(freeTimeout / 1000)}초 동안 비지 않아 스캔을 중단했습니다.`;
        break;
      }

      let item;
      try {
        item = await runOne(engine, symbol, { mode, mock });
      } catch (e) {
        // runOne은 throw 하지 않도록 짰지만, 그래도 스캔 전체를 죽이지 않는다.
        item = {
          symbol,
          display: symbol,
          mode,
          ok: false,
          action: null,
          confidence: null,
          rr: null,
          rrSource: null,
          scalpBias: null,
          verdict: null,
          riskOk: null,
          riskReasons: [],
          savedPath: null,
          error: errMessage(e),
          durationMs: 0,
        };
      }

      item.tier = tierOf(item);
      item.score = scoreOf(item);
      results.push(item);

      safeProgress(onProgress, {
        type: 'scan',
        phase: 'item',
        index: i + 1,
        total: symbols.length,
        mode,
        symbol: item.symbol,
        display: item.display,
        ok: item.ok,
        action: item.action,
        confidence: item.confidence,
        rr: item.rr,
        scalpBias: item.scalpBias,
        verdict: item.verdict,
        tier: item.tier,
        score: item.score,
        savedPath: item.savedPath,
        error: item.error,
        durationMs: item.durationMs,
        ts: new Date().toISOString(),
      });
    }

    // 점수 내림차순. Array#sort 는 안정 정렬이라 동점이면 스캔 순서가 유지된다.
    const ranking = results.slice().sort((a, b) => b.score - a.score);
    ranking.forEach((r, idx) => {
      r.rank = idx + 1;
    });

    const okCount = ranking.filter((r) => r.ok).length;
    const donePayload = {
      type: 'scan',
      phase: 'done',
      total: symbols.length,
      scanned: ranking.length,
      count: ranking.length, // public/app.js onScan 이 읽는 필드
      ok: okCount,
      failed: ranking.length - okCount,
      mode,
      cancelled,
      ranking,
      ts: new Date().toISOString(),
    };
    if (cancelled) donePayload.reason = '사용자 요청으로 스캔을 중단했습니다.';
    else if (abortReason) donePayload.reason = abortReason;
    safeProgress(onProgress, donePayload);

    return ranking;
  } finally {
    scanning = false;
    cancelRequested = false;
  }
}

// --- 계약 외 확장 (서버 배선 편의용) ---------------------------------------

// 스캔 진행 여부. 서버가 /api/scan 중복 호출을 409로 막을 때 쓴다.
function isScanning() {
  return scanning;
}

// 다음 심볼로 넘어가기 전에 중단한다. 이미 돌고 있는 engine.run 은 끊지 못한다.
function cancelScan() {
  if (!scanning) return false;
  cancelRequested = true;
  return true;
}

module.exports = { scanWatchlist, isScanning, cancelScan };
