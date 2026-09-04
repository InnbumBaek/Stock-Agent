# PIXEL TRADING FLOOR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 티커 입력 → AI 에이전트 7명(TARO/DIANA/NOVA/VIBE/BULL/BEAR/ACE)이 실데이터 분석→토론→BUY/SELL/HOLD 판정을 픽셀 오피스 UI에서 실시간 중계하는 로컬 웹앱.

**Architecture:** 의존성 0의 Node(24) http 서버가 무료 공개 API로 시장 데이터를 수집하고, 에이전트별 `claude -p --model opus` 프로세스를 스폰해 JSON 응답을 받아 SSE로 프론트에 방송한다. 프론트는 단일 페이지 픽셀아트 오피스(캔버스 스프라이트 + DOM 말풍선).

**Tech Stack:** Node 24 내장(http, child_process, fetch, node:test), 바닐라 JS/CSS, Galmuri 웹폰트(CDN, 폴백 monospace), claude CLI(Max 구독).

## Global Constraints

- 외부 npm 의존성 금지 (Node 내장만)
- 포트 8000 고정, 실행 중 분석은 동시 1건 (중복 요청 409)
- 실제 주문·거래소 키·결제 없음. UI에 "AI 시뮬레이션 — 투자 조언이 아님" 상시 노출
- 에이전트 이름·역할 고정: TARO(기술적 분석)·DIANA(기본적 분석)·NOVA(뉴스 분석)·VIBE(센티먼트)·BULL(매수 논거)·BEAR(매도 논거)·ACE(수석 트레이더)
- claude 호출: `claude -p --model opus`, 프롬프트는 stdin, 타임아웃 180초, 도구 사용 금지 지시 포함
- 모든 사용자 노출 텍스트는 한국어 (코드 주석·로그는 자유)
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: 스캐폴드 + 지표 계산 모듈

**Files:**
- Create: `package.json`, `.gitignore`, `server/indicators.js`, `test/indicators.test.mjs`

**Interfaces:**
- Produces: `indicators.js` exports `computeIndicators(candles)` — `candles`: `[{t,o,h,l,c,v}]`(과거→최신) → returns `{price, changePct24h, sma20, sma50, rsi14, macd:{macd, signal, hist}, high20, low20, volatilityPct, summaryLines:[string]}` (summaryLines는 프롬프트 주입용 한국어 요약 5줄 내외)

- [ ] **Step 1:** `package.json` 작성: `{"name":"trading-floor","private":true,"type":"commonjs","scripts":{"start":"node server/server.js","test":"node --test test/"}}`. `.gitignore`: `node_modules/`, `reports/*.md`, `reports/decisions.json`, `.env`
- [ ] **Step 2:** `test/indicators.test.mjs` — node:test로 실패 테스트 작성: 알려진 수열(1..30 종가)에 대해 sma20 정확값, rsi14가 0~100 범위·상승수열이면 100 근접, macd 필드 존재, high20/low20 정확값 검증
- [ ] **Step 3:** `node --test test/` 실행 → FAIL 확인
- [ ] **Step 4:** `server/indicators.js` 구현 (SMA/RSI(Wilder)/MACD(12,26,9)/20일 고저/일간수익률 표준편차×√365 변동성)
- [ ] **Step 5:** `node --test test/` → PASS 확인
- [ ] **Step 6:** `git add -A && git commit -m "feat: 스캐폴드 + 지표 계산 모듈"`

### Task 2: 시장 데이터 수집 모듈

**Files:**
- Create: `server/market.js`, `test/market.smoke.mjs`

**Interfaces:**
- Consumes: `computeIndicators(candles)` (Task 1)
- Produces: `market.js` exports:
  - `resolveSymbol(input)` → `{kind:'crypto'|'stock', symbol, display}` — 대문자화 후 코인 목록(BTC,ETH,SOL,XRP,DOGE,ADA,AVAX,LINK,DOT,TRX,BNB,SUI,PEPE 등 30여 개) 또는 `-USDT`/`USDT` 접미 매칭 시 crypto, 아니면 stock
  - `async fetchMarket(resolved)` → `{kind, symbol, display, candles:[{t,o,h,l,c,v}], indicators, fundamentals:{lines:[string]}, news:{headlines:[{title, age}]}, sentiment:{lines:[string]}, priceLine:string}` — 각 소스 실패 시 해당 필드에 `["데이터 없음"]` 넣고 계속, 캔들 실패만 throw
  - `async fetchTape()` → `[{sym, price, changePct}]` (BTC,ETH,SOL,XRP + TSLA,NVDA,AAPL,MSFT — 실패 항목은 제외)
- 데이터 소스 (전부 무키): Binance `/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=120`·`/api/v3/ticker/24hr`, CoinGecko `/api/v3/coins/markets?vs_currency=usd&ids=...`(코인 id 매핑 테이블 포함), alternative.me `/fng/`, Yahoo `query1.finance.yahoo.com/v8/finance/chart/<SYM>?range=6mo&interval=1d`(User-Agent 헤더 필수), Google News RSS `news.google.com/rss/search?q=<검색어>&hl=ko&gl=KR&ceid=KR:ko` (정규식으로 `<item><title>` 추출, 상위 8건)

- [ ] **Step 1:** `server/market.js` 구현 (위 시그니처 그대로, 타임아웃 10초 AbortSignal, 실패 허용 로직 포함)
- [ ] **Step 2:** `test/market.smoke.mjs` 작성 — BTC와 AAPL 각각 fetchMarket 호출해 candles.length>50, indicators.price>0, priceLine 존재를 콘솔 출력·검증 (네트워크 스모크, node --test 아님 — `node test/market.smoke.mjs`로 실행)
- [ ] **Step 3:** 스모크 실행 → 두 심볼 모두 통과 확인
- [ ] **Step 4:** `git commit -m "feat: 시장 데이터 수집 모듈"`

### Task 3: 에이전트 모듈 (프롬프트 + claude 스폰 + mock)

**Files:**
- Create: `server/agents.js`, `test/agents.test.mjs`

**Interfaces:**
- Consumes: `fetchMarket` 결과 객체 (Task 2)
- Produces: `agents.js` exports:
  - `AGENTS` — `{id, name, nameKo, role, roomKo}` 7종 메타 (id: taro,diana,nova,vibe,bull,bear,ace)
  - `extractJson(text)` → 첫 `{`부터 마지막 `}`까지 잘라 JSON.parse, 실패 시 null
  - `async runAgent(id, context, {mock})` → `{bubble, report, ...extra}` — mock이면 고정 응답 즉시 반환(데모용 한국어 문구, 심볼 치환). 실제면 stdin으로 프롬프트 전달해 `claude -p --model opus` 스폰(shell:true, 타임아웃 180초), extractJson 실패 시 1회 재시도, 그래도 실패면 `{bubble:"분석 실패", report:"(파싱 실패) "+원문 앞 500자}`
  - context: `{market, analystReports?, debateLog?}` — 프롬프트 빌더가 역할별로 필요한 부분만 주입
- 프롬프트 공통 규칙: "너는 픽셀 트레이딩 플로어의 <이름>(<역할>)이다. 아래 제공된 데이터만 사용하고 도구·검색을 쓰지 마라. 반드시 JSON 하나만 출력: {\"bubble\":\"현장 말풍선 한 줄(한국어, 40자 이내)\",\"report\":\"상세 분석(한국어, 3-6문장)\"}"
  - taro: indicators.summaryLines + 캔들 최근 20일 요약 주입
  - diana: fundamentals.lines 주입
  - nova: news.headlines 주입
  - vibe: sentiment.lines + 헤드라인 제목만 주입
  - bull/bear: 애널리스트 4명 report 전문 + 직전 debateLog 주입, bubble/report에 상대 반박 포함 지시
  - ace: 전체 리포트 + 토론 로그 주입, JSON에 `"action":"BUY|SELL|HOLD","confidence":0-100,"entry":"...","stop":"...","target":"...","rationale":"2-3문장"` 추가 요구
- [ ] **Step 1:** `test/agents.test.mjs` — extractJson 3케이스(정상/앞뒤 잡문/불량→null) + mock runAgent가 7개 id 모두 bubble·report 반환, ace mock은 action 필드 포함 검증
- [ ] **Step 2:** `node --test` → FAIL 확인
- [ ] **Step 3:** `server/agents.js` 구현
- [ ] **Step 4:** `node --test` → PASS 확인
- [ ] **Step 5:** `git commit -m "feat: 에이전트 프롬프트·스폰 모듈"`

### Task 4: 엔진 + 서버 (SSE·API·리포트 저장)

**Files:**
- Create: `server/engine.js`, `server/server.js`, `start-floor.cmd`, `README.md`

**Interfaces:**
- Consumes: `resolveSymbol/fetchMarket/fetchTape`(Task 2), `AGENTS/runAgent`(Task 3)
- Produces:
  - `engine.js` exports `class Engine extends EventEmitter` — `run(symbolInput, {mock})`: 진행 중이면 throw `{code:409}`. 이벤트 `emit('event', {type, ...})` 시퀀스:
    1. `{type:'run:start', symbol, display, mock}`
    2. `{type:'market', priceLine, candles, display, kind}` (캔들은 `{t,c}`만 120개)
    3. 각 애널리스트: `{type:'agent:start', id}` → `{type:'agent:done', id, bubble, report}` (4명 병렬, Promise.allSettled)
    4. 토론 4턴 순차(bull→bear→bull→bear): 같은 `agent:start/done` + `{turn:1..4}`
    5. `{type:'decision', action, confidence, entry, stop, target, rationale, report}`
    6. `{type:'saved', path}` → `{type:'run:end'}`
    - 오류: `{type:'run:error', message}` 후 run:end. 상태 초기화 보장(finally)
  - 리포트 저장: `reports/YYYY-MM-DD-<display>-<HHmm>.md`(전 에이전트 리포트+판정), `reports/decisions.json`에 `{ts, symbol, action, confidence}` append
  - `server.js`: 포트 8000. 라우트: `GET /` 정적(public/), `GET /api/stream` SSE(현재 상태 replay 후 구독), `POST /api/analyze` body `{symbol, demo}` → 202 or 409, `GET /api/tape` → fetchTape 결과(서버 60초 캐시)
  - `start-floor.cmd`: `start http://localhost:8000 && node server\server.js`
- [ ] **Step 1:** `engine.js` 구현 (이벤트 히스토리 배열 유지 — 새 SSE 구독자에 replay)
- [ ] **Step 2:** `server.js` 구현 (SSE: `text/event-stream`, keep-alive 25초 주석 ping)
- [ ] **Step 3:** 검증: 서버 띄우고 `curl -X POST localhost:8000/api/analyze -d '{"symbol":"BTC","demo":true}'` 후 `curl -N localhost:8000/api/stream`으로 mock 전체 시퀀스(run:start→…→run:end) 수신 확인, reports/ 파일 생성 확인
- [ ] **Step 4:** `README.md` 작성 (실행법·구조·면책) 후 `git commit -m "feat: 엔진·서버·SSE"`

### Task 5: 픽셀 오피스 프론트엔드

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes: SSE 이벤트 프로토콜(Task 4), `POST /api/analyze`, `GET /api/tape`
- Produces: 릴스 레이아웃 재현 데스크톱 UI (최소 1100px, 모바일 대응은 범위 외)

레이아웃(고정 요소 id):
- `#topbar`: `◆ PIXEL TRADING FLOOR ◆` 로고, `#symbol-input`(placeholder "BTC, ETH, TSLA…"), `#analyze-btn`[▶ ANALYZE], 우측 `#clocks`(NYC/LDN/SEL — Intl.DateTimeFormat timeZone America/New_York, Europe/London, Asia/Seoul, 1초 갱신)
- `#board`: 전광판 — `#board-symbol` `#board-price` `#board-change`(+초록/-빨강), `#chart`(canvas, market 이벤트의 candles로 라인차트, 마지막 값 점)
- `#floor` (CSS grid 2열): 좌측 `#room-analyst`(우드톤 바닥, 책상 4개 2×2: taro/diana/nova/vibe), 우측 상단 `#room-research`(네이비, 원탁에 bull·bear 마주봄), 우측 하단 `#room-trading`(퍼플, ACE 책상 + `#decision-panel`)
- 각 캐릭터 슬롯: `<div class="desk" id="desk-<id>">` 안에 `<canvas class="sprite">`(48×48, 픽셀 매트릭스 → fillRect 렌더, 캐릭터별 팔레트: taro 파랑모자, diana 갈색머리, nova 노랑, vibe 보라, bull 주황 뿔, bear 빨강 곰귀, ace 금발) + `<div class="nametag">` + `<div class="badge">`(역할 한국어) + `<div class="bubble">`(기본 숨김)
- `#tape`: 하단 무한 스크롤 티커(CSS animation, /api/tape 60초 폴링, `NVDA +2.41%` 형식·등락색)
- `#decision-panel`: 기본 "대기 중", decision 이벤트 시 action 대문자 + confidence 게이지 + entry/stop/target + rationale, BUY=#3fb950/SELL=#f85149/HOLD=#d29922
- `#disclaimer`: "AI 시뮬레이션 — 투자 조언이 아님" 상시 푸터
- 데모: URL `?demo=1`이면 analyze 요청에 `demo:true`

동작(app.js):
- `EventSource('/api/stream')`; `agent:start` → 해당 bubble에 `…` 타이핑 애니메이션 + 캐릭터 살짝 바운스 CSS 클래스; `agent:done` → bubble 텍스트 타자기 효과(20ms/자), report는 `dataset`에 저장, bubble 클릭 시 `#modal`에 리포트 표시; `decision` → 판정 패널 + ACE 말풍선 "최종 판정: <action>"; `run:error` → 토스트 표시; 분석 중 `#analyze-btn` disabled
- 폰트: `<link>` Galmuri11 (cdn.jsdelivr.net/npm/galmuri/dist/galmuri.css), `font-family:'Galmuri11', monospace`
- 스타일: 배경 #1a1a24, 방은 2px 픽셀 보더 + 계단식 그림자, `image-rendering: pixelated`, CRT 스캔라인 오버레이(repeating-linear-gradient, opacity 0.06)

- [ ] **Step 1:** index.html/style.css/app.js 구현
- [ ] **Step 2:** 서버 재시작 후 브라우저(`?demo=1`)에서: 티커 입력→ANALYZE→말풍선 순차 진행→판정 패널→모달 열림 확인, 콘솔 에러 0 확인
- [ ] **Step 3:** `git commit -m "feat: 픽셀 오피스 프론트엔드"`

### Task 6: 실전 검증 + 마무리

**Files:**
- Modify: 발견된 버그 파일

- [ ] **Step 1:** 데모 아닌 실제 모드로 BTC 분석 1회 실행 (opus 7콜, 수 분 소요) — 전 에이전트 말풍선·판정·리포트 md 저장 확인
- [ ] **Step 2:** 스크린샷 확보(전체 플로어 + 판정 패널) — 사용자 보고용
- [ ] **Step 3:** 버그 수정 후 `git commit -m "fix: 실전 검증 반영"` (없으면 생략)
