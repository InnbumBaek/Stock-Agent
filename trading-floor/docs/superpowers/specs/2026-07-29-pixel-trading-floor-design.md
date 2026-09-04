# PIXEL TRADING FLOOR — 설계 문서

날짜: 2026-07-29
레퍼런스: 인스타 릴스(픽셀 트레이딩 플로어 데모) + TradingAgents 논문(arXiv:2412.20138, TauricResearch/TradingAgents)
요청: "코인 가상 법인(coin-hq)에서 트레이딩만 따로 떼서, 릴스처럼 그대로 제작"

## 1. 목적

티커를 입력하면 AI 에이전트 7명이 실제 시장 데이터를 놓고 분석→토론→판정하는 과정을
픽셀아트 오피스에서 말풍선으로 실시간 중계하는 로컬 웹앱.
분석·판정·기록까지만 하고 실제 주문은 절대 하지 않는다 (coin-hq 원칙 승계).

## 2. 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 분석 엔진 | `claude -p --model opus` 스폰 (자체 구현) | Max 구독으로 추가 비용 0, 텔레그램 브리지·coin-hq와 동일 패턴. 원본 오픈소스는 OpenAI API 과금 필요 |
| 대상 시장 | 코인 기본(BTC/ETH) + 티커 자유 입력(미국주식 포함) | coin-hq에서 트레이딩만 분리한 취지 + 릴스 데모(SNDK) 재현 가능 |
| 범위 | BUY/SELL/HOLD 판정 + 리포트 저장까지 | 가상 포지션 추적(PNL)은 v2로 미룸 (BRIEF PNL 봇과 연계 여지) |
| UI | 릴스의 픽셀 오피스 그대로 (이름 TARO/DIANA/NOVA/VIBE/BULL/BEAR/ACE 유지) | "그대로 만들어달라"는 요청 |
| 포트 | 8000 | 릴스 화면(localhost:8000)과 동일 |

## 3. 에이전트 구조 (TradingAgents 논문 매핑)

```
[애널리스트 팀 — 병렬 4명]
  TARO  기술적 분석   ← 캔들·MA20/50·RSI·MACD·변동성 (서버가 계산해 주입)
  DIANA 기본적 분석   ← 시총·순위·공급량·거래대금 (코인: CoinGecko / 주식: Yahoo)
  NOVA  뉴스 분석     ← 구글뉴스 RSS 최신 헤드라인
  VIBE  센티먼트      ← Fear&Greed 지수(코인) + 헤드라인 톤
        ↓
[리서치 팀 — 순차 토론 2라운드]
  BULL 매수 논거 → BEAR 반박+매도 논거 → BULL 재반박 → BEAR 최종
        ↓
[트레이딩 본부]
  ACE 수석 트레이더 — 전 리포트 종합 → {action: BUY|SELL|HOLD, confidence, entry, stop, target, rationale}
```

- 각 에이전트는 단일 `claude -p` 호출. 프롬프트에 역할 + 수집된 데이터 전문 포함, 도구 사용 금지("제공된 데이터만 사용").
- 응답은 JSON 강제: `{bubble: "말풍선 한 줄(≤40자)", report: "상세 분석"}` (+ ACE는 판정 필드 추가). 관대한 파서(첫 `{`~끝 `}`)로 추출.
- 한 에이전트 실패 시: 해당 리포트를 "분석 실패"로 표기하고 파이프라인은 계속 진행. ACE 실패 시에만 전체 오류 처리.

## 4. 시스템 구성

```
trading-floor/
├── server/
│   ├── server.js        ← http 서버(포트 8000) + SSE + 정적 파일 (의존성 0, Node24 내장 fetch)
│   ├── engine.js        ← 파이프라인 오케스트레이션 (분석 실행, 상태 브로드캐스트)
│   ├── agents.js        ← 에이전트 롤 프롬프트 7종 + claude -p 스폰/파싱
│   ├── market.js        ← 데이터 수집: Binance·CoinGecko·alternative.me·Yahoo·Google News RSS
│   └── indicators.js    ← SMA/RSI/MACD/변동성 계산
├── public/
│   ├── index.html       ← 픽셀 오피스 레이아웃
│   ├── style.css        ← 픽셀아트 스타일 (Galmuri 폰트, CRT 느낌)
│   └── app.js           ← SSE 구독, 말풍선·차트·티커테이프·시계 렌더
├── reports/             ← YYYY-MM-DD-<티커>-<HHmm>.md + decisions.json
├── start-floor.cmd      ← 서버 실행 + 브라우저 오픈
└── README.md
```

## 5. 데이터 흐름

1. 사용자: 티커 입력 → `POST /api/analyze {symbol}` (동시 실행 1건 — 진행 중이면 409)
2. `market.js`: 심볼 해석(코인 우선 매칭 → 아니면 Yahoo) → 캔들 120일 + 지표 + 펀더멘털 + 뉴스 + F&G 수집. 소스 실패는 "데이터 없음"으로 대체(전체 중단 없음). 단 가격 캔들 실패 시엔 즉시 오류 반환
3. `engine.js`: 단계별 실행, 매 이벤트를 SSE(`/api/stream`)로 방송
   - `market` → `analyst:start/done`(4 병렬) → `debate:turn`(4턴) → `decision` → `saved`
4. 프론트: 이벤트 수신 → 해당 캐릭터 말풍선 갱신·타이핑 인디케이터·판정 패널 표시
5. 종료: 리포트 md 저장 + `decisions.json`에 1줄 append

## 6. UI 레이아웃 (데스크톱 기준, 릴스 최종 프레임 재현)

- 헤더: `◆ PIXEL TRADING FLOOR ◆` + 티커 입력 + [ANALYZE] + NYC/LDN/SEL 픽셀 시계
- 상단 전광판: 심볼·현재가·등락률 + 캔버스 라인차트(수집한 캔들)
- 좌측 큰 방: 애널리스트 팀 — 책상 4개, 캐릭터 4명(TARO·DIANA·NOVA·VIBE) + 역할 배지
- 우측 상단 방: 리서치 팀 — BULL(황소)·BEAR(곰) 마주보는 테이블
- 우측 하단 방: HEAD TRADER — ACE + 판정 패널(BUY 초록/SELL 빨강/HOLD 노랑 + confidence + 근거)
- 하단: 스크롤 티커 테이프(주요 코인·주식 시세, 1분 주기 갱신)
- 캐릭터: 코드 내 픽셀 매트릭스 → 캔버스 렌더(외부 이미지 의존 없음)
- 말풍선: 진행 중 "…" 타이핑 → 완료 시 bubble 텍스트. 클릭하면 상세 리포트 모달
- 폰트: Galmuri(CDN, 실패 시 monospace 폴백)

## 7. 오류 처리·운영

- claude CLI 타임아웃 180초/에이전트, stderr 캡처해 서버 로그
- 데모 모드: `?demo=1` 또는 서버 env `FLOOR_DEMO=1` — mock 응답으로 전체 연출 재생(토큰 0, UI 시연·개발용)
- 면책 문구 상시 노출: "AI 시뮬레이션 — 투자 조언이 아님"
- 실제 주문·API 키·거래소 연동 없음

## 8. 테스트

- 데모 모드로 전체 파이프라인 UI 검증(브라우저)
- 실전 1회: BTC 분석 end-to-end (opus 7콜) — 판정 패널·리포트 저장 확인
- market.js 단독 실행 스모크 테스트(코인 1종·주식 1종)

## 9. v2 후보 (이번 범위 아님)

가상 포지션·PNL 추적(BRIEF PNL 연계), 판정 텔레그램 발송, coin-hq 퀘스트 연동, 예약 정기 분석

## 10. v1.1 확장 (2026-07-29 저녁, 사용자 추가 요청)

- **모드 2종**: `algo`(논문 파이프라인: 애널리스트4→토론4→ACE) / `scalp`(탭비트 20배 단타: TARO·VIBE→BLITZ→GUARD→ACE, 토론 생략·호출 5회로 절약). POST /api/analyze body `mode`, run:start 이벤트·리포트·decisions.json에 mode 기록
- **스캘핑 데스크**: BLITZ(스캘퍼)·GUARD(리스크 관리, 격리 20배 청산 버퍼 -4.7~-5.0%·리스크 2% 룰). ACE JSON에 scalp{bias,entry,stop,target,note} (스캘핑 리포트 있을 때만 — OUTPUT_ACE_CORE/OUTPUT_ACE 분리)
- **한국주식(탭비트 무기한 기초자산)**: SKHYNIX(000660.KS)·SAMSUNG(005930.KS), 한글 별칭 입력, ₩ 표기, 한국어 뉴스, 테이프 추가. 인트라데이 15분봉 전 종목 공통(intraday.summaryLines)
- **`/floor` 세션 커맨드**: F:\CLAUDE\.claude\commands\floor.md (+프로젝트 사본). session-prep.js(컴팩트 JSON ~3KB)로 데이터만 받고 역할 연기는 세션이 직접 — claude -p 스폰 0회
- **원본 TradingAgents 로컬**: vendor/TradingAgents 클론 + claude-shim(OpenAI 호환→claude CLI 위임, 가짜 임베딩) — 세션 할당량으로 원본 실행. 네이티브 anthropic(API 키 과금) 설정도 병기
