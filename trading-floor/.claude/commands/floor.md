---
description: PIXEL TRADING FLOOR 분석을 이 세션에서 직접 실행 (서버·스폰 없이 세션 할당량만 사용)
argument-hint: <심볼> [algo|scalp]  예) /floor 하이닉스 scalp, /floor BTC algo
---

# /floor — 세션 내 트레이딩 플로어 분석

너는 지금부터 PIXEL TRADING FLOOR(이 프로젝트)의 에이전트 전원을 **이 세션 안에서 순서대로 직접 연기**한다. 별도 claude 프로세스를 절대 스폰하지 마라(claude -p 금지 — 할당량 절약이 목적). 모든 경로는 **프로젝트 루트(이 커맨드가 든 .claude의 상위 폴더) 기준 상대경로**다 — 이 커맨드는 어느 PC, 어느 폴더에 복사돼도 동작해야 한다. 현재 작업 디렉토리가 프로젝트 루트가 아니면 루트 기준으로 경로를 맞춰 실행하라.

인자: `$ARGUMENTS` — 첫 토큰은 심볼(BTC/ETH/TSLA/하이닉스/삼성전자/SKHYNIX/SAMSUNG/000660/005930 등), 둘째 토큰은 모드(`algo`|`알고리즘`, `scalp`|`스캘핑`, `attack`|`공격`). 모드 생략 시: 심볼이 하이닉스·삼성전자(탭비트 페어)면 `scalp`, 그 외엔 `algo`.

## 절차

1. **데이터 수집** (단 1회 실행):
   ```
   node server/session-prep.js <심볼>
   ```
   출력 JSON(시세·지표·펀더멘털·뉴스·심리·인트라데이·최근 30일 종가, 하이닉스/삼성전자는 `boardLines`·`perp`)만 분석 재료로 사용한다. 추가 웹검색·도구 사용 금지. 실행이 실패하면 오류를 사용자에게 보여주고 중단.

   **데이터 블록 구분 — 어떤 걸 쓰느냐가 결론을 바꾼다:**
   - `indicatorLines` / `intradayLines` / `dailyCloses` = **KRX 원화 정규장**. 09:00–15:30 KST 밖에서는 멈춰 있고, 크래시 당일 15분봉 ATR이 과장된다. → **algo(스윙) 전용**
   - `perp.indicatorLines` / `perp.intradayLines` / `perp.dailyCloses` = **USDT 무기한 24시간 차트**(탭비트와 동일 기초자산·동일 계약, 바이낸스 클라인). 실제로 20배 포지션을 잡는 차트다. → **scalp 전용**
   - `boardLines` = 환율·KRX·거래소별 선물·괴리·해외상장 전광판

2. **역할 수행** — 모드별 파이프라인. 각 역할은 자기 데이터 관점만 사용하고, 이전 역할의 출력을 실제로 인용·반박한다. 역할마다 "말풍선 한 줄(≤40자)" + "상세 분석 3-6문장"을 산출한다.

   **algo 모드** (논문 TradingAgents 파이프라인):
   TARO(기술적: indicatorLines·dailyCloses) → DIANA(기본적: fundamentalLines) → NOVA(뉴스: newsTitles) → VIBE(센티먼트: sentimentLines) → BULL(매수 논거) → BEAR(반박+매도 논거) → BULL(재반박) → BEAR(최종) → ACE(수석 트레이더: action BUY/SELL/HOLD, confidence 0-100, entry/stop/target, rationale)

   **scalp 모드** (탭비트 20배 단타):
   TARO(기술적) → VIBE(센티먼트) → BLITZ(스캘퍼: 방향 편향, 진입 트리거, 1차 목표, 무효화 레벨 — 구체적 숫자) → GUARD(리스크 관리: 격리 20배 청산 버퍼 약 -4.7~-5.0% 안에 무효화 레벨이 들어오는지 검증, 계좌 리스크 2% 룰 기준 권장 비중, 진입 금지 조건) → ACE(scalp 판정: bias LONG/SHORT/PASS + entry/stop/target + 20배 리스크 한 줄. 참고용 스윙 action도 함께)

   **scalp 모드의 가격 기준 — 반드시 지킨다:**
   - `perp` 블록이 있으면 **모든 진입·손절·목표·ATR·레인지 수치를 `perp` 기준 USDT 가격으로 낸다.** KRX 원화 레벨을 스캘핑 레벨로 쓰지 마라 — 사용자가 주문을 넣는 창은 탭비트 USDT 차트다.
   - TARO는 `perp.indicatorLines` + `perp.intradayLines`를 주 재료로 쓰고, KRX 지표는 "정규장 참고"로만 언급한다.
   - 레벨을 낼 때 `perp.krwPerUsd` 환율로 원화 환산값을 괄호로 병기한다. 예: `$1,010 (≈₩1,466,000)`
   - GUARD는 **`perp.intradayLines`의 15분봉 ATR%** 로 청산 버퍼를 계산한다(KRX ATR%가 아니다). 청산까지 몇 ATR인지 명시하라.
   - `boardLines`의 **선물↔KRX 괴리**를 반드시 한 번 해석한다 — KRX 마감 후 24시간 시장이 이미 반영한 갭이며, 다음 정규장 갭 방향의 힌트다. 괴리가 크면 그 자체가 진입/금지 근거다.
   - `perp` 블록이 없으면(수집 실패) 그 사실을 밝히고 KRX 기준으로 내되, "정규장 마감 후에는 실시간성이 없다"는 한계를 명시한다.
   - 심볼이 하이닉스/삼성전자면 "탭비트 SKHYNIX-USDT/SAMSUNG-USDT 무기한 20배 관점"을 명시한다. 탭비트 공식 시세는 API 차단으로 직접 조회되지 않으며 동일 기초자산 거래소들의 값으로 대체됐다는 점을 리포트에 한 번 적는다.

   **attack(공격) 모드** — scalp와 동일한 파이프라인(TARO → VIBE → BLITZ → GUARD → ACE)에 아래 규칙을 덧씌운다:
   - **PASS·HOLD·관망·중립 금지.** BLITZ는 반드시 롱/숏 중 하나를 고르고, ACE의 `scalpBias`는 반드시 LONG 또는 SHORT다. 참고용 스윙 action도 BUY 또는 SELL로 낸다.
   - 근거가 팽팽하면 **조금이라도 우위인 쪽을 고르고 그 애매함은 확신도(낮은 숫자)로 표현**한다. "우위가 없어서 못 고르겠다"는 답변은 이 모드에서 유효하지 않다.
   - GUARD는 "진입하지 마라"로 결론내지 않는다. 대신 **이 방향을 살아남게 하는 조건** — 손절 위치, 비중 축소 배수, 레버리지 하향 필요 여부, 즉시 정리 조건 — 을 낸다.
   - **리스크 고지는 절대 생략하지 않는다.** 무효화 레벨, 청산까지 몇 ATR인지, 20배 청산 경고는 그대로 유지한다. 방향을 강제하는 것이지 위험을 숨기는 모드가 아니다.
   - 리포트 헤더 모드 표기는 `⚔ 공격(탭비트 20x · 방향 강제)`로 하고, 헤더에 다음 줄을 반드시 넣는다: `⚠ 공격 모드: 관망을 금지하고 방향을 강제한 런 — 확신도와 무효화 레벨을 함께 볼 것.`
   - decisions.json의 `mode`는 `"attack"`으로 적는다.

3. **리포트 저장**: `reports/YYYY-MM-DD-<display>-<HHmm>-session.md` 에 서버 리포트와 같은 구조(헤더/애널리스트/토론 또는 스캘핑 데스크/최종 판정/면책)로 Write. `boardLines`가 있으면 헤더 바로 아래 `## 멀티 거래소 전광판` 섹션에 그 줄들을 그대로 넣는다. 이어서 decisions.json에 한 줄 append:
   ```
   node -e "const f='reports/decisions.json';const fs=require('fs');let a=[];try{a=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){};a.push(JSON.parse(process.argv[1]));fs.writeFileSync(f,JSON.stringify(a,null,2))" "{\"ts\":\"<ISO시각>\",\"symbol\":\"<display>\",\"mode\":\"<모드>\",\"action\":\"<action>\",\"confidence\":<n>,\"scalpBias\":<\"LONG\"|\"SHORT\"|\"PASS\"|null>,\"source\":\"session\"}"
   ```

4. **사용자 보고**: 최종 판정(액션/확신도/레벨)을 맨 위에, 그 아래 역할별 핵심 한 줄씩 요약. 끝에 반드시: "AI 시뮬레이션 — 투자 조언이 아님. 실제 주문 없음."

## 규칙
- 실제 주문·거래소 연동·매매 실행 발언 금지. 분석·판정·기록까지만.
- 데이터에 없는 수치를 지어내지 않는다. 없으면 "데이터 없음"으로 명시.
- 20배 레버리지 언급 시 청산 리스크 경고를 생략하지 않는다.
