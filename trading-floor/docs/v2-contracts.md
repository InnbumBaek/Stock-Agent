# PIXEL TRADING FLOOR v2 — 모듈 간 계약 (단일 진실 소스)

여러 모듈이 병렬로 만들어지므로 **여기 적힌 시그니처·파일 형식·이벤트 이름을 반드시 지킨다.**
기존 v1.2 동작(모드 3종, SSE 이벤트, 리포트 저장)은 절대 깨지 않는다.

## 원칙

- **외부 npm 의존성 0** — Node 내장만. 이게 이 프로젝트의 이식성이다.
- **실주문 없음** — 거래소 주문 API는 넣지 않는다. 분석·판정·기록·알림까지만.
- 데이터에 없는 수치를 만들지 않는다. 없으면 `null`/"데이터 없음".
- 모든 신규 파일은 CommonJS(`require`/`module.exports`).

## 파일 배치

```
server/
  config.js      설정 로드/저장 (config.json)      [기존 없음 - 신규]
  riskmath.js    손익비·포지션사이징·청산 계산      [신규]
  positions.js   가상 포지션 추적                   [신규]
  stats.js       성적표·캘리브레이션 집계           [신규]
  watcher.js     급변동 감시 + 자동분석 트리거      [신규]
  notify.js      텔레그램 발송                      [신규]
  scheduler.js   정기 브리핑 예약                   [신규]
  scanner.js     워치리스트 일괄 스캔               [신규]
  replay.js      저장 리포트 → 이벤트 재생          [신규]
config.json      사용자 설정 (git 무시)
positions.json   가상 포지션 (reports/ 안에 저장)
```

## config.js

```js
module.exports = { loadConfig, saveConfig, DEFAULTS }
```

`loadConfig()` → 객체 (config.json 없으면 DEFAULTS, 부분 누락은 DEFAULTS로 채움. 절대 throw 안 함)
`saveConfig(patch)` → 병합 저장 후 최신 객체 반환

DEFAULTS:
```js
{
  watchlist: ['SKHYNIX', 'SAMSUNG', 'BTC'],
  watcher: {
    enabled: false,
    intervalSec: 60,
    triggers: { movePct: 1.5, windowMin: 15, volumeMultiple: 2.5, fundingAbs: 0.05, premiumPct: 1.0 },
    autoAnalyze: false,          // 트리거 시 자동으로 분석까지 돌릴지
    autoMode: 'scalp',
    cooldownMin: 30,             // 같은 심볼 재트리거 최소 간격
    quietHours: []               // 예: [[0,7]] → 0~7시 알림 억제
  },
  telegram: { enabled: false, botToken: '', chatId: '' },
  schedule: { enabled: false, jobs: [] },   // [{ at:'08:30', symbol:'SKHYNIX', mode:'scalp', days:'weekday' }]
  risk: {
    minRR: 1.5,                  // 최소 손익비. 미달이면 판정을 HOLD/PASS로 강등
    accountRiskPct: 2.0,         // 1회 거래 허용 손실 (계좌 대비 %)
    accountSize: 0,              // 0이면 비중을 %로만 표기
    leverage: 20,
    maintenanceMarginPct: 0.5    // 청산 계산용
  },
  ui: { sound: true, animations: true }
}
```

## riskmath.js — 손익비·사이징·청산

```js
module.exports = { parsePrice, computeRR, positionSize, liquidationPrice, evaluatePlan }
```

- `parsePrice(text)` → number|null. `"1,341,000원"`, `"$1,111.5"`, `"약 64,500 부근"` 같은 문자열에서 첫 숫자 추출(콤마·통화기호 제거). 숫자가 없으면 null.
- `computeRR({ entry, stop, target, side })` → `{ rr, riskPct, rewardPct, valid, reason }`
  - side: 'LONG'|'SHORT'. rr = 보상거리/위험거리. 방향이 논리적으로 어긋나면(롱인데 stop>entry 등) `valid:false`+reason.
- `positionSize({ accountSize, accountRiskPct, entry, stop, leverage })` → `{ qty, notional, marginRequired, riskAmount, notionalPctOfAccount }` (accountSize 0이면 비율만)
- `liquidationPrice({ entry, side, leverage, maintenanceMarginPct })` → number. 격리 기준 근사.
- `evaluatePlan(plan, riskCfg)` → **핵심 게이트**
  ```js
  { ok, rr, liq, stopBeyondLiq, downgrade, reasons: [], sizing }
  ```
  - `stopBeyondLiq`: 손절이 청산가보다 멀면 true (= 청산이 먼저 온다 → 치명적)
  - `downgrade`: true면 엔진이 판정을 HOLD(스윙)/PASS(스캘핑)로 강등해야 함
  - 강등 조건: rr < minRR, stopBeyondLiq, entry/stop/target 파싱 불가 중 하나라도 해당
  - `reasons`: 한국어 사유 배열 (화면·리포트에 그대로 표시)

## positions.js — 가상 포지션

저장: `reports/positions.json` — `{ open: [...], closed: [...] }`

```js
module.exports = { openFromDecision, markToMarket, closePosition, listPositions, summary }
```

- `openFromDecision(decision, market, cfg)` → position|null (action이 HOLD이고 scalp가 PASS면 null)
  - position: `{ id, symbol, display, side, mode, entry, stop, target, qty, notional, leverage, liq, rr, openedAt, source:'auto', status:'open' }`
- `markToMarket(prices)` → 갱신된 open 배열 (`unrealizedPct`, `unrealizedAmt`, `hitStop`, `hitTarget` 계산)
- `closePosition(id, { price, reason })` → closed로 이동, `realizedPct`, `holdMin` 기록
- `summary()` → `{ openCount, closedCount, winRate, avgWinPct, avgLossPct, profitFactor, expectancyPct, avgRR }`

## stats.js — 성적표·캘리브레이션

```js
module.exports = { buildStats }
```
`buildStats({ priceLookup })` → 
```js
{
  total, byMode: {algo:{...}, scalp:{...}, attack:{...}},
  byConfidence: [{ bucket:'50-59', n, hitRate, avgReturnPct }, ...],
  calibration: [{ bucket, predicted, actual, gap }],   // 확신도 vs 실제 적중률
  recent: [...],                                        // 최근 20건
  positions: <positions.summary()>,
  note: '...'                                           // 데이터 부족 시 한계 명시
}
```
- 판정 결과 평가는 `decisions.json` + 가능한 경우 이후 가격. 평가 불가 건은 `pending`으로 분류하고 승률 계산에서 제외한다(**추측 금지**).

## notify.js — 텔레그램

```js
module.exports = { sendMessage, sendDecision, sendAlert, isEnabled }
```
- Node 내장 fetch로 `https://api.telegram.org/bot<token>/sendMessage` 호출.
- 실패해도 절대 throw 금지 (앱 흐름을 막지 않는다). 실패는 console.error만.
- 메시지는 HTML parse_mode, 한국어. 끝에 항상 `— AI 시뮬레이션, 투자 조언 아님`.

## watcher.js — 급변동 감시

```js
class Watcher extends EventEmitter
  constructor({ engine, config })
  start() / stop() / status()
```
- `config.watcher.intervalSec`마다 워치리스트 심볼의 **가벼운 시세만** 조회(전체 fetchMarket 금지 — 비용 큼).
  - 코인: Binance ticker/klines 1m, 한국주식: `market.js`의 무기한 선물 소스.
- 트리거 판정 → `emit('alert', alertObj)`
  ```js
  { id, ts, symbol, display, kind:'move'|'volume'|'funding'|'premium', severity:'info'|'warn'|'critical',
    message:'하이닉스 15분 +2.3% (기준 1.5%)', value, threshold, price }
  ```
- `autoAnalyze`가 true이고 engine이 idle이면 `engine.run(symbol, {mode: autoMode})` 실행. 쿨다운·조용시간 준수.
- 실패는 전부 삼키고 다음 주기로 (감시는 절대 죽지 않는다).

## scheduler.js — 정기 브리핑

```js
class Scheduler { constructor({engine, config, notify}) start() stop() status() }
```
- 분 단위 체크. `days`: 'daily'|'weekday'. 실행 후 텔레그램 발송(설정 시).

## scanner.js — 일괄 스캔

```js
module.exports = { scanWatchlist }   // async ({engine, symbols, mode, onProgress}) => ranking[]
```
- 심볼을 **순차** 실행(engine은 동시 1건). 각 결과에서 `{symbol, action, confidence, rr, scalpBias}` 추출해 점수순 정렬.
- 점수: action이 BUY/SELL이고 rr 높고 confidence 높을수록 상위. HOLD/PASS는 하위.

## replay.js — 리포트 재생

```js
module.exports = { parseReport, replayEvents }
```
- 저장된 `.md`를 파싱해 원래 SSE 이벤트 시퀀스로 복원 → 속도 배율로 재생.

## 서버 라우트 (server.js — 통합 담당자가 배선)

```
GET  /api/config           설정 조회
POST /api/config           설정 저장 (부분 병합)
GET  /api/watcher          감시 상태 + 최근 알림
POST /api/watcher          {enabled:true|false}
GET  /api/stats            성적표 JSON
GET  /stats                성적표 HTML 페이지
GET  /api/positions        가상 포지션 (open/closed/summary)
POST /api/positions/close  {id, price?}
POST /api/scan             워치리스트 일괄 스캔 시작
GET  /api/replay?file=...  리포트 재생 시작 (SSE로 흘림)
POST /api/telegram/test    테스트 메시지 발송
```

## 신규 SSE 이벤트 (기존 이벤트는 변경 금지)

```js
{ type:'alert',    ...alertObj }                      // 급변동 감시
{ type:'position', action:'open'|'update'|'close', position }
{ type:'scan',     phase:'start'|'item'|'done', ... }
{ type:'risk',     rr, ok, reasons:[], sizing }       // 판정 직전 리스크 게이트 결과
```

## 판정 파이프라인 변경 (engine.js)

ACE(또는 PM) 판정 직후, 저장 전에:
1. `riskmath.evaluatePlan()` 실행 → `risk` 이벤트 방송
2. `downgrade`면 action을 HOLD(스윙)/PASS(스캘핑)로 바꾸고 rationale 앞에 `[리스크 게이트] <사유>` 추가
   - **단, attack 모드는 방향 강제가 계약이므로 강등하지 않는다.** 대신 경고만 붙인다.
3. decision 이벤트/리포트/decisions.json에 `rr`, `sizing`, `riskReasons` 포함
4. 가상 포지션 자동 오픈(설정 시)

## 프롬프트 변경 (agents.js)

- ACE·PM·BLITZ에게 **진입·손절·목표를 반드시 숫자로** 제시하게 요구(레벨 문자열 안에 숫자 포함).
- 최소 손익비 요구를 프롬프트에 명시: "목표는 손절 거리의 <minRR>배 이상이어야 한다. 그렇지 못하면 관망을 택하라."
- GUARD·SAFE에게 청산 버퍼 계산 결과(riskmath)를 컨텍스트로 주입.
