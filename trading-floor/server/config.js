'use strict';

// config.js — 사용자 설정 로드/저장 (프로젝트 루트의 config.json)
//
// 계약: module.exports = { loadConfig, saveConfig, DEFAULTS }
//
// 원칙
// - 외부 의존성 0. Node 내장 모듈만 쓴다.
// - loadConfig()는 절대 throw하지 않는다. 파일이 없거나 JSON이 깨졌어도 DEFAULTS로 돌아간다.
// - saveConfig()도 throw하지 않는다. HTTP 핸들러에서 동기 throw는 프로세스를 죽이기 때문에,
//   쓰기 실패는 console.error로만 남기고 병합된 객체를 그대로 돌려준다(이번 실행에만 적용).
// - 두 함수 모두 동기다. 서버 부팅·라우트 어디서든 await 없이 쓸 수 있다.
// - 반환값은 항상 새 객체(깊은 복사)다. 호출자가 마음대로 고쳐도 DEFAULTS나 다음 로드에
//   영향을 주지 않는다.
//
// 설정 파일 경로는 기본이 <프로젝트루트>/config.json 이고,
// 환경변수 TRADING_FLOOR_CONFIG 로 덮어쓸 수 있다(테스트·다중 프로필용).

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// 설정 파일 경로. 호출 시점마다 환경변수를 다시 본다.
function configPath() {
  const override = process.env.TRADING_FLOOR_CONFIG;
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return DEFAULT_CONFIG_FILE;
}

// 기본 설정을 매번 새로 만든다. 외부에서 DEFAULTS를 훼손해도 로드가 오염되지 않는다.
function makeDefaults() {
  return {
    watchlist: ['SKHYNIX', 'SAMSUNG', 'BTC'],
    watcher: {
      enabled: false,
      intervalSec: 60,
      triggers: {
        movePct: 1.5,
        windowMin: 15,
        volumeMultiple: 2.5,
        fundingAbs: 0.05,
        premiumPct: 1.0,
      },
      autoAnalyze: false, // 트리거 시 자동으로 분석까지 돌릴지
      autoMode: 'scalp',
      cooldownMin: 30, // 같은 심볼 재트리거 최소 간격
      quietHours: [], // 예: [[0,7]] → 0~7시 알림 억제
    },
    telegram: { enabled: false, botToken: '', chatId: '' },
    schedule: { enabled: false, jobs: [] }, // [{ at:'08:30', symbol:'SKHYNIX', mode:'scalp', days:'weekday' }]
    risk: {
      minRR: 1.5, // 최소 손익비. 미달이면 판정을 HOLD/PASS로 강등
      accountRiskPct: 2.0, // 1회 거래 허용 손실 (계좌 대비 %)
      accountSize: 0, // 0이면 비중을 %로만 표기
      leverage: 20,
      maintenanceMarginPct: 0.5, // 청산 계산용
    },
    ui: { sound: true, animations: true },
    // 주가 모니터링 원장(../stock-monitor) 연동. 계약: docs/integration.md
    // 기본이 꺼짐이다 — 켜기 전까지 trading-floor 의 동작은 통합 이전과 같다.
    ki: {
      enabled: false,
      python: '', // 비우면 python3 → python 순서로 찾는다
      script: '', // 비우면 <저장소>/stock-monitor/ki_monitor.py
      timeoutSec: 30,
      cacheMin: 30,
      withDisclosures: false, // 켜면 DART 공시까지 — 네트워크·키가 필요하다
      staleWarnDays: 5, // 원장이 이만큼 묵으면 프롬프트에 경고를 붙인다
      injectInto: ['diana', 'guard', 'safe'], // 실측을 받을 에이전트
      // 공개 API(야후)로 캔들을 못 받을 때 원장의 KRX 공식 일봉으로 대신할지.
      // 사내망·폐쇄망에서 분석이 아예 서는 것을 막는다.
      candleFallback: true,
      candleDays: 200,
    },
  };
}

// 참고용 기본값 스냅샷. 이 객체를 고쳐도 loadConfig 결과에는 영향이 없다.
const DEFAULTS = makeDefaults();

// --- 내부 헬퍼 -----------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out;
  }
  return v;
}

// 프로토타입 오염 방지 (config.json은 HTTP POST로도 들어온다)
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// base(기본값 사본)에 patch를 깊게 덮어쓴다.
// - 객체끼리는 재귀 병합, 배열·원시값은 통째로 교체
// - 형식이 다른 값(예: watchlist에 문자열)은 무시하고 기본값을 유지
// - null은 "값 없음"으로 보고 기본값을 유지 (기본값에 없던 키만 null 허용)
function mergeInto(base, patch) {
  if (!isPlainObject(patch)) return base;
  for (const key of Object.keys(patch)) {
    if (BLOCKED_KEYS.has(key)) continue;
    const pv = patch[key];
    if (pv === undefined) continue;
    const bv = base[key];

    if (isPlainObject(bv) && isPlainObject(pv)) {
      mergeInto(bv, pv);
      continue;
    }
    if (pv === null) {
      if (bv === undefined) base[key] = null;
      continue;
    }
    if (bv !== undefined && bv !== null && kindOf(bv) !== kindOf(pv)) {
      console.error(
        `[config] '${key}' 값의 형식이 달라 무시했습니다 (기대: ${kindOf(bv)}, 입력: ${kindOf(pv)})`
      );
      continue;
    }
    base[key] = deepClone(pv);
  }
  return base;
}

// --- 공개 API ------------------------------------------------------------

// config.json을 읽어 DEFAULTS와 병합한 설정 객체를 돌려준다.
// 파일이 없으면 DEFAULTS, 일부 키만 있으면 나머지는 DEFAULTS로 채운다. 절대 throw하지 않는다.
function loadConfig() {
  const cfg = makeDefaults();
  const file = configPath();

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // 파일 없음(ENOENT)은 정상 — 조용히 기본값을 쓴다.
    if (!err || err.code !== 'ENOENT') {
      console.error(`[config] 설정 파일을 읽지 못해 기본값을 씁니다: ${err && err.message}`);
    }
    return cfg;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[config] config.json 파싱 실패 — 기본값을 씁니다: ${err.message}`);
    return cfg;
  }

  if (!isPlainObject(parsed)) {
    console.error('[config] config.json 최상위가 객체가 아니라 기본값을 씁니다');
    return cfg;
  }

  return mergeInto(cfg, parsed);
}

// patch를 현재 설정에 깊게 병합해 저장하고, 저장된 최신 설정 객체를 돌려준다.
// 쓰기에 실패해도 throw하지 않는다(반환된 객체는 이번 실행 메모리 기준으로만 유효).
function saveConfig(patch) {
  const merged = loadConfig();
  mergeInto(merged, isPlainObject(patch) ? patch : {});

  const file = configPath();
  const text = JSON.stringify(merged, null, 2) + '\n';
  const tmp = `${file}.tmp`;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      // 원자적 저장: 임시 파일에 쓰고 교체 (중간에 죽어도 config.json이 깨지지 않는다)
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
    } catch (renameErr) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 임시 파일 정리는 실패해도 무시 */
      }
      throw renameErr;
    }
  } catch (err) {
    console.error(`[config] 설정 저장 실패 — 이번 실행에만 적용됩니다: ${err && err.message}`);
  }

  return merged;
}

module.exports = { loadConfig, saveConfig, DEFAULTS };
