# ◆ PIXEL TRADING FLOOR ◆

티커 하나를 입력하면 AI 에이전트 **7명**이 실시간으로 시장 데이터를 분석하고,
서로 토론한 뒤 **BUY / SELL / HOLD** 판정을 내리는 픽셀아트 트레이딩 오피스
로컬 웹앱입니다. 릴스 콘셉트 영상과 TradingAgents 논문(멀티 에이전트 금융
의사결정 프레임워크)의 구조에서 착안했습니다.

의존성 0의 Node(24) 내장 HTTP 서버가 무료 공개 API로 시장 데이터를 모으고,
에이전트별 `claude -p --model opus` 프로세스를 스폰해 받은 JSON 응답을
SSE(Server-Sent Events)로 프론트에 방송합니다. 화면은 단일 페이지 픽셀아트
오피스(캔버스 스프라이트 + DOM 말풍선)입니다.

## 에이전트 7명 구조도

```
                    ┌─────────────────────────┐
   [시장 데이터]───▶│      애널리스트 방        │
   Binance/Yahoo    │  TARO   DIANA            │
   CoinGecko/뉴스   │  기술적  기본적          │
   F&G 지수         │  NOVA   VIBE             │
                    │  뉴스    센티먼트        │
                    └───────────┬─────────────┘
                                │ 리포트 4종
                                ▼
                    ┌─────────────────────────┐
                    │      리서치 방 (토론)    │
                    │   BULL  ⇄  BEAR          │
                    │   매수     매도          │
                    │   (4턴 순차 반박)        │
                    └───────────┬─────────────┘
                                │ 토론 로그
                                ▼
                    ┌─────────────────────────┐
                    │      트레이딩 방         │
                    │        ACE (수석)        │
                    │   → BUY / SELL / HOLD    │
                    │   확신도·진입·손절·목표  │
                    └─────────────────────────┘
```

| ID | 이름 | 역할 |
|----|------|------|
| taro | TARO | 기술적 분석 (지표·캔들) |
| diana | DIANA | 기본적 분석 (펀더멘털) |
| nova | NOVA | 뉴스 분석 |
| vibe | VIBE | 센티먼트 분석 |
| bull | BULL | 매수 논거 (토론) |
| bear | BEAR | 매도 논거 (토론) |
| ace | ACE | 수석 트레이더 (최종 판정) |

## 실행법

Windows 배치 실행기(브라우저 자동 오픈 + 서버 기동):

```
start-floor.cmd
```

또는 npm 스크립트:

```
npm start
```

서버가 뜨면 브라우저에서 접속:

- 실전 모드: <http://localhost:8000>
- **데모 모드**: <http://localhost:8000/?demo=1>
  claude 호출 없이 고정 목업 응답으로 전체 흐름을 즉시 재생합니다.
  (네트워크·구독 없이 UI 확인용)

티커 입력창에 `BTC`, `ETH`, `TSLA`, `NVDA` 등을 넣고 `▶ ANALYZE` 를 누르면
애널리스트 말풍선이 순차로 뜨고, 토론을 거쳐 판정 패널이 채워집니다.
분석은 동시 1건만 가능하며(중복 요청은 409), 실전 모드는 opus 7콜로 수 분이
소요될 수 있습니다.

## 폴더 구조

```
trading-floor/
├─ server/
│  ├─ indicators.js   지표 계산 (SMA/RSI/MACD/변동성)
│  ├─ market.js       시장 데이터 수집 (심볼 해석·시세·뉴스·센티먼트·티커테이프)
│  ├─ agents.js       에이전트 프롬프트 + claude 스폰 + 데모 목업
│  ├─ engine.js       분석 엔진 (이벤트 시퀀스·병렬/토론 오케스트레이션·리포트 저장)
│  └─ server.js       HTTP 서버 (정적 파일 + SSE + /api/analyze + /api/tape)
├─ public/            프론트엔드 (index.html / style.css / app.js)
├─ reports/           분석 결과 저장 (YYYY-MM-DD-<심볼>-<HHmm>.md, decisions.json)
├─ test/              테스트 (node:test + 네트워크 스모크)
├─ start-floor.cmd    Windows 실행기
└─ package.json
```

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/` | 픽셀 오피스 UI (정적) |
| GET | `/api/stream` | SSE 스트림 — 접속 시 현재 진행 상황을 replay 후 실시간 구독 |
| POST | `/api/analyze` | `{ "symbol": "BTC", "demo": false }` → 202 시작 / 409 진행 중 / 400 심볼 없음 |
| GET | `/api/tape` | 하단 티커테이프용 시세 배열 (서버 60초 캐시) |

## 면책

본 프로그램은 **AI 시뮬레이션**이며 **투자 조언이 아닙니다**. 에이전트의 분석·
토론·판정은 참고용 콘텐츠일 뿐이며, 어떤 **실제 주문·거래·자금 이동도 발생하지
않습니다**. 거래소 API 키나 결제 수단을 사용하지 않습니다. 투자의 최종 판단과
책임은 전적으로 사용자 본인에게 있습니다.
