# PIXEL TRADING FLOOR — Claude Code 안내

AI 에이전트들이 시장 데이터를 분석하고 토론해 매매 판정을 내리는 **로컬 웹앱**이다.
픽셀아트 트레이딩 오피스 화면 + Node 내장 HTTP 서버로 구성된다.

**이것은 분석·시뮬레이션 도구다. 거래소 주문 연동은 없고, 앞으로도 넣지 않는다.**

## 실행

```bash
node server/server.js          # http://localhost:8000
# 포트 충돌 시: PORT=8123 node server/server.js
# Windows: start-floor.cmd 더블클릭
npm test                       # 164개 단위 테스트
```

의존성 설치 불필요 — `package.json`에 dependencies가 없고 Node 내장 모듈만 쓴다.

**전제조건**
- Node 20 이상 (global `fetch`, `AbortSignal.timeout` 사용)
- 실전 모드는 `claude` CLI가 PATH에 있고 로그인돼 있어야 한다 (에이전트마다 `claude -p --model opus`를 스폰)
- CLI가 없거나 할당량을 아끼려면 데모 모드 `http://localhost:8000/?demo=1` — 고정 목업 응답으로 화면 전체가 돈다

## 구조

```
server/
  server.js       HTTP 라우팅 · SSE · 리포트 열람/ZIP (외부 의존성 0)
  engine.js       모드별 파이프라인 오케스트레이션 → 이벤트 방송 → 리포트 저장
  agents.js       역할별 프롬프트 빌더 · claude 스폰 · 데모 목업
  market.js       시장 데이터 수집 (키 없는 공개 API만)
  indicators.js   SMA/RSI/MACD/ATR/변동성
  session-prep.js CLI — 수집 결과를 압축 JSON으로 stdout에 출력
  ki-bridge.js    ../stock-monitor 원장(KRX·DART)의 실측값 조회 — 기본 꺼짐
  export-brief.js 판정을 모아 주가 모니터링 리포트용 브리핑 JSON 생성 (CLI)
  scorecard.js    지난 판정을 원장으로 채점 (agent.scorecard/1) — 브리핑에 실린다
public/           단일 페이지 프론트 (캔버스 스프라이트 + DOM, 빌드 도구 없음)
.claude/commands/floor.md   /floor 슬래시 커맨드
reports/          런마다 마크다운 리포트 + 같은 이름의 .json(기계판독) + decisions.json 누적
```

## 에이전트와 모드

| 에이전트 | 역할 |
|---|---|
| TARO / DIANA / NOVA / VIBE | 기술적 · 기본적 · 뉴스 · 센티먼트 |
| **FLOW / FILING** | 유동성·체결 / 공시·자본구조 — **원장 실측이 있어야 돈다**<br>FLOW 는 KIS 실시간 호가도 단독으로 받는다 |
| BULL ⇄ BEAR | 매수/매도 논거 4턴 토론 |
| BLITZ / GUARD | 스캘퍼 / 리스크 관리 |
| RISKY / SAFE / **RED** / NEUTRAL | 리스크 위원회 — RED 는 **가정 반대심문**, 원장 실측 필요 |
| ACE / PM | 수석 트레이더 — 최종 판정 / 포트폴리오 매니저 승인 |

**에이전트를 늘릴 때는 새 업무를 준다.** 같은 재료를 여러 명이 보면 의견이 상관되고
전담이 없어 아무도 깊이 보지 않는다. FLOW·FILING·RED 에게는 통합 이전에 아무도 보지
못하던 값(실행 시뮬레이션·매물대·자본구조·측정 한계)을 주고, 기존 역할에서는 그만큼
뺐다. 배정은 `agents.js` 의 `KI_SECTIONS` 이고 `test/roster.test.mjs` 가 강제한다.

셋 다 `requiresKi: true` 라 원장 실측이 없는 런(코인·해외주식)에서는 명단에서 빠진다 —
**그쪽 비용은 통합 이전과 같다** (algo 기준 opus 13콜, 한국 종목만 16콜).

| 모드 | 파이프라인 | 특징 |
|---|---|---|
| `algo` | 애널리스트 4 → 토론 4턴 → ACE | TradingAgents 논문 구조 |
| `scalp` | TARO·VIBE → BLITZ → GUARD → ACE | 20배 단타. PASS(관망) 가능 |
| `attack` | scalp와 동일 | **PASS·HOLD 금지 — 반드시 LONG/SHORT.** 시연·영상용 |

## 데이터 소스

**공개 API (키 불필요)**

- 암호화폐: Binance klines/ticker, CoinGecko, alternative.me 공포탐욕지수
- 주식: Yahoo Finance chart API
- 뉴스: Google News RSS (한국어)
- 환율: Yahoo `KRW=X` → 실패 시 open.er-api.com

**한국투자증권 KIS (키 필요 · 기본 꺼짐)** — `ki.realtime` 을 켤 때만. 원장이 일별
종가라 며칠 묵을 수 있는 그 신선도만 메운다. 현재가는 시세 줄로 전원이 보고, 호가·
잔량·스프레드는 FLOW 만 본다. **주문 API 는 화이트리스트에 없다** — KB 와 달리 KIS 는
같은 서버에 주문이 있어서, 시세 두 개 밖의 이름은 전부 `OrderNotAllowed` 다.

### 한국 주식의 이중 가격 체계 — 여기가 이 프로젝트의 핵심

SK하이닉스·삼성전자는 **USDT 결제 무기한 선물**이 여러 거래소에 상장돼 있고, 사용자는
그쪽에서 레버리지 거래를 한다. 그래서 가격 축이 두 개다.

- `market.candles` / `market.intraday` — **KRX 원화 정규장**. 09:00–15:30 KST 밖에서는 멈춘다
- `market.perp` — **USDT 무기한 24시간 차트**. 실제 주문이 체결되는 쪽
- `market.board` — 환율·KRX·거래소별 선물·괴리·해외상장을 모은 전광판

**스캘핑·공격 모드의 레벨은 반드시 `market.perp` 기준으로 낸다.** 정규장 차트로 20배
포지션을 설계하면 ATR이 몇 배로 부풀려져(폭락일 실측: KRX 3.05% vs 무기한 1.20%)
멀쩡한 셋업이 "청산 위험"으로 잘못 기각된다. 이 구분이 깨지면 판정 자체가 틀어진다.

**탭비트 API는 CloudFront/Cloudflare에서 403으로 막혀 있다.** 우회 시도하지 말고,
동일 기초자산 계약을 상장한 바이낸스·바이비트·비트겟·게이트 값으로 대체한다
(`KR_STOCKS[].perps`). 캔들은 바이낸스 USDⓈ-M에서 가져온다.

## 작업 규칙

- **외부 의존성을 추가하지 않는다.** npm 패키지 0개가 이 프로젝트의 제약이자 이식성이다
- **데이터에 없는 수치를 지어내지 않는다.** 없으면 "데이터 없음"으로 표기
- **20배 레버리지를 언급하면 청산 리스크 경고를 반드시 함께 낸다.** `attack` 모드에서도 예외 없다
- 시장 데이터 수집은 전부 best-effort — 한 소스가 죽어도 나머지로 계속 진행한다.
  캔들 실패만 치명적(throw)이다
- 새 소스를 붙이기 전에 `node -e "fetch(...)"`로 실제 응답을 확인하라. 문서만 보고 짜면 대개 틀린다

## 주가 모니터링 원장 연동 (선택 · 기본 꺼짐)

같은 저장소의 `../stock-monitor` 는 KRX·DART **공식 API**로 일별 원장을 쌓는 파이썬
도구다. `server/ki-bridge.js` 가 그 원장에서 **측정값만** 읽어 DIANA·GUARD·SAFE 의
프롬프트에 붙인다. `config.json` 의 `ki.enabled` 로 켠다.

**켜기 전까지 이 앱의 동작은 통합 이전과 한 글자도 다르지 않다.** 파이썬이 없어도,
원장이 없어도 앱은 그대로 돈다 — 실측만 빠진다.

- 원장은 **일별 종가**다. 실시간이 아니다. 며칠 지난 값을 현재가로 읽으면 판정이
  통째로 틀어지므로, 브리지가 기준일과 경과일수를 항상 함께 붙인다
- 원장 쪽은 **판단하지 않는 것**이 설계 원칙이다. 받은 측정값을 등급·점수·권고로
  바꾸지 마라. 판정은 이쪽 에이전트가 한다
- 브리지는 원장을 **읽기만** 한다. 분석 요청이 KRX API 호출을 유발하면 할당량이
  조용히 소진된다. `ingest` 는 사람이 돌린다

**KRX 6자리 코드를 그대로 분석 대상으로 받는다.** `KR_STOCKS` 에 없는 종목은
`generic:true` 로 해석되고, 야후 접미사를 `.KS` → `.KQ` 순으로 찾고 종목명은 원장이
채운다. 무기한 선물이 없으므로 `market.perp`·`market.board` 가 없고 프롬프트에
그 사실을 적는다 — **이 경로는 `algo` 모드용이다.** 정규장 차트로 20배를 설계하면
ATR 이 부풀려져 멀쩡한 셋업이 잘못 기각된다.

**야후가 막힌 망에서는 원장 일봉이 캔들을 대신한다** (`ki.candleFallback`, 기본 켬).
캔들 실패는 이 프로젝트에서 유일한 치명적 실패라 그대로 두면 분석이 아예 선다.
순서는 야후 → (실패 시) 원장 일봉 → (그것도 없으면) 원래 오류를 그대로 올린다.
없는 값을 만들지 않는다. 이 경로에는 실시간 호가·시가총액·인트라데이·무기한 선물이
없으므로 `scalp`·`attack` 보다 `algo` 가 맞다.

### 판정을 리포트로 내보내기

에이전트 판정은 회의 자료가 된다. `server/export-brief.js` 가 런 결과를 모아
`agent-brief.json` 을 만들고, 주가 모니터링이 그것을 HTML 리포트의 한 절로 싣는다.

```bash
node server/export-brief.js --run --symbols SKHYNIX,SAMSUNG   # 분석하고 내보낸다
node server/export-brief.js                                    # 저장된 것만 모은다
cd ../stock-monitor && python ki_monitor.py report --with-agents
```

- 엔진은 런마다 `.md` 옆에 같은 이름의 `.json`(floor.run/1)을 쓴다. 마크다운을
  되파싱하는 방식은 서식이 조금만 바뀌어도 조용히 깨지기 때문이다.
  **사이드카에는 마크다운과 같은 재료만 담는다.** 여기서 새로 계산하거나 요약하면
  두 리포트가 어긋난다.
- **`--run` 없이는 분석을 실행하지 않는다.** 13명 × claude opus 는 비용이 크다.
- 없는 값은 `null` 이다. 확신도 없음이 `0` 으로 둔갑하면 성적표 집계까지 틀어진다.
- 리포트에 실리는 문장은 언어모델이 만든 것이다. 받는 쪽(파이썬)이 이스케이프하지만,
  이쪽에서도 제어문자·거대 문자열을 그대로 흘려보내지 않는지 살펴라.

계약은 `../docs/integration.md` 가 단일 진실 소스다.

## 슬래시 커맨드

`/floor <심볼> [algo|scalp|attack]` — 별도 프로세스를 스폰하지 않고 **현재 세션에서**
에이전트 전원을 순서대로 연기한다 (할당량 절약용). `node server/session-prep.js <심볼>`로
데이터를 한 번만 수집한 뒤 그 JSON만 재료로 쓴다.
