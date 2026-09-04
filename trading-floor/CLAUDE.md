# PIXEL TRADING FLOOR — Claude Code 안내

AI 에이전트들이 시장 데이터를 분석하고 토론해 매매 판정을 내리는 **로컬 웹앱**이다.
픽셀아트 트레이딩 오피스 화면 + Node 내장 HTTP 서버로 구성된다.

**이것은 분석·시뮬레이션 도구다. 거래소 주문 연동은 없고, 앞으로도 넣지 않는다.**

## 실행

```bash
node server/server.js          # http://localhost:8000
# 포트 충돌 시: PORT=8123 node server/server.js
# Windows: start-floor.cmd 더블클릭
npm test                       # 15개 단위 테스트
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
public/           단일 페이지 프론트 (캔버스 스프라이트 + DOM, 빌드 도구 없음)
.claude/commands/floor.md   /floor 슬래시 커맨드
reports/          런마다 마크다운 리포트 + decisions.json 누적
```

## 에이전트와 모드

| 에이전트 | 역할 |
|---|---|
| TARO / DIANA / NOVA / VIBE | 기술적 · 기본적 · 뉴스 · 센티먼트 |
| BULL ⇄ BEAR | 매수/매도 논거 4턴 토론 |
| BLITZ / GUARD | 스캘퍼 / 리스크 관리 |
| ACE | 수석 트레이더 — 최종 판정 |

| 모드 | 파이프라인 | 특징 |
|---|---|---|
| `algo` | 애널리스트 4 → 토론 4턴 → ACE | TradingAgents 논문 구조 |
| `scalp` | TARO·VIBE → BLITZ → GUARD → ACE | 20배 단타. PASS(관망) 가능 |
| `attack` | scalp와 동일 | **PASS·HOLD 금지 — 반드시 LONG/SHORT.** 시연·영상용 |

## 데이터 소스 (전부 키 불필요)

- 암호화폐: Binance klines/ticker, CoinGecko, alternative.me 공포탐욕지수
- 주식: Yahoo Finance chart API
- 뉴스: Google News RSS (한국어)
- 환율: Yahoo `KRW=X` → 실패 시 open.er-api.com

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

## 슬래시 커맨드

`/floor <심볼> [algo|scalp|attack]` — 별도 프로세스를 스폰하지 않고 **현재 세션에서**
에이전트 전원을 순서대로 연기한다 (할당량 절약용). `node server/session-prep.js <심볼>`로
데이터를 한 번만 수집한 뒤 그 JSON만 재료로 쓴다.
