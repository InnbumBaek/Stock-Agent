# Stock-Agent

주식 관련 두 프로젝트를 한 저장소에 담았습니다. **합친 것이 아니라 이어 붙였습니다.**

| 프로젝트 | 무엇을 하는가 | 언어 |
|---|---|---|
| [`stock-monitor/`](stock-monitor/) | 상장 포트폴리오사의 **회수(엑싯) 시점 판단**에 필요한 사실을 KRX·DART 공식 API 로 매일 모아 단일 HTML 리포트로 만듭니다 | Python |
| [`trading-floor/`](trading-floor/) | 티커 하나를 넣으면 AI 에이전트들이 시장 데이터를 분석·토론해 **BUY/SELL/HOLD 판정**을 내리는 픽셀아트 트레이딩 오피스 웹앱입니다 | Node (npm 의존성 0) |

---

## 무엇을 만드는가

**에이전트가 분석하고 판단합니다. 그 결과를 회수 판단 리포트에 실어 오프라인 회의에 올립니다.**

```
매일 · 자동                                      주 1회 · 회의
──────────────────────────────────────────       ──────────────
KRX·DART 공식 API 로 사실을 잽니다
        ↓
에이전트 13명이 그 사실을 보고 토론해 판정합니다
        ↓
측정값 §1~§4 + 에이전트 판정 §5 를 한 리포트로  →  사람이 읽고 결정합니다
```

주가 모니터링의 설계 원칙인 *"판단은 사람이 합니다"* 는 파이프라인이 판단하면 안 된다는
뜻이 아니라, 자동화가 만든 산출물을 놓고 **최종 결정은 회의에서 사람이 한다**는 뜻입니다.
그래서 에이전트 판정은 리포트에 실립니다.

다만 **측정값과 판정은 절을 나눕니다.** §1~§4 는 공식 API 로 잰 값이고 §5 는 언어모델의
의견입니다. 같은 표에 섞으면 회의에서 그 구분이 사라지고, 근거 없는 결론이 근거 있는
숫자처럼 읽힙니다.

### 데이터가 흐르는 방향

```
                    ① 사실 → 판단의 재료
  ┌───────────────────────────────────────────────────┐
  │                                                   ▼
[stock-monitor]                              [trading-floor]
 KRX·DART API                                 에이전트 13명
      ↓                                             │
  ki.sqlite ──▶ facts ──▶ ki-bridge.js ──▶ 프롬프트 │
   원장                              DIANA·GUARD·SAFE
      │                                             ▼
      │                                      판정 (BUY/SELL/HOLD)
      │                                             │
      │                                     export-brief.js
      ▼                                             │
  HTML 리포트  ◀─────── agent-brief.json ◀──────────┘
   §1~§4 측정값          ② 판단 → 회의 자료
   §5 에이전트 판정
```

되돌아오는 것은 **리포트**이지 **원장**이 아닙니다. `ki.sqlite` 는 공식 API 로 측정한
사실만 담는 장부이고, AI 판정을 거기에 쓰면 다음번 측정이 오염됩니다.

계약의 전문은 [`docs/integration.md`](docs/integration.md) 에 있습니다.

---

## 한 번에 돌리기

```bash
# 0) 원장 준비 (하루 한 번, 자동화)
cd stock-monitor
cp .env.example .env                 # KRX·DART 키를 채웁니다
python ki_monitor.py daily --market KOSPI

# 1) 에이전트 분석 (회의 전 · 수 분/종목)
cd ../trading-floor
echo '{ "ki": { "enabled": true } }' > config.json
node server/export-brief.js --run --symbols SKHYNIX,SAMSUNG --mode algo

# 2) 회의 자료 생성
cd ../stock-monitor
python ki_monitor.py report --market KOSPI --with-agents
#   → out/KI_exit_YYYYMMDD.html
```

어느 단계가 실패해도 앞 단계의 산출물은 살아 있습니다. 에이전트 분석이 없으면 리포트는
"에이전트 분석이 없습니다"라고 적고 나머지 절을 그대로 냅니다.

리포트의 §5 는 이렇게 실립니다.

```
에이전트 분석 — AI 판정
  이 절은 AI 에이전트의 판정입니다 — 위 절들의 측정값과 성격이 다릅니다.
  출처: PIXEL TRADING FLOOR · 브리핑 생성 2026-09-04 01:58 · 판정 2건

  [BUY] SK하이닉스 · 확신도 64% · PM APPROVE · 권장 비중 계좌 대비 2%
    진입 1,480,000원 · 손절 1,400,000원 · 목표 1,700,000원
    리스크 게이트 — 손익비 2.75 (최소 기준 1.5) · 게이트 통과
    근거 — VWAP 대비 할인 구간이나 처분 소요일수가 길어 분할 전제
    ▸ 애널리스트 리포트 (4건)  ▸ 리서치 토론 (2건)  ▸ 리스크 위원회 (1건)
    분석 2026-09-04 01:30 · 모드 algo · 참고한 원장 기준일 2026-08-12
```

에이전트가 쓴 문장은 요약하지 않고 전문 그대로 접이식으로 실립니다. 회의에서 결론만
보고 넘어가지 않도록, 근거를 펼쳐 볼 수 있어야 하기 때문입니다.

---

## 각각 따로 쓰기

두 프로젝트는 **단독으로 떼어내도 그대로 돕니다.** 통합 기능은 전부 옵트인이라,
켜기 전까지 동작은 통합 이전과 같습니다.

```bash
# 주가 모니터링 — 회수 판단 리포트
cd stock-monitor
python ki_monitor.py daily      # 적재 → 리포트 (에이전트 절 없음)
python ki_monitor.py selftest   # 80개 (키 불필요)
```

```bash
# PIXEL TRADING FLOOR — 에이전트 데스크
cd trading-floor
node server/server.js           # http://localhost:8000
# 데모 모드(claude CLI 없이): http://localhost:8000/?demo=1
npm test                        # 104개
```

`--with-agents` 없이 만든 리포트는 통합 이전 원본 코드의 출력과 **바이트 단위로 같습니다.**

자세한 사용법은 각 프로젝트의 README 를 보십시오 —
[주가 모니터링](stock-monitor/README.md) · [PIXEL TRADING FLOOR](trading-floor/README.md).

---

## 저장소에 없는 것

아래는 `.gitignore` 로 제외됩니다. 저작권이 아니라 **자격증명·영업비밀** 문제입니다.

| 파일 | 이유 |
|---|---|
| `.env` | API 키. 유출되면 재발급 외에 방법이 없습니다 |
| `stock-monitor/ki.sqlite` | 87MB 원장. 공식 API 로 언제든 다시 만들 수 있습니다 |
| `stock-monitor/watchlist.csv` · `exit_plan.csv` · `positions.csv` | 포트폴리오사 실명·회수계획·보유 포지션 (대외비) |
| `trading-floor/config.json` | 텔레그램 봇 토큰이 들어갑니다 |
| `stock-monitor/out/` · `trading-floor/reports/` | 생성된 리포트·판정 기록 |

`*.sample.csv` 와 `.env.example` 은 뼈대로 남겨 두었습니다.

---

## 면책

`trading-floor` 의 판정은 **AI 시뮬레이션**이며 **투자 조언이 아닙니다.** 실제 주문·거래·
자금 이동은 발생하지 않고, 거래소 API 키나 결제 수단을 쓰지 않습니다.

`stock-monitor` 가 만드는 리포트는 **대외비 문서**이며 투자권유·투자자문 자료가
아닙니다. 에이전트 판정이 실려도 성격은 바뀌지 않습니다 — 회의에서 사람이 읽고
결정하기 위한 자료입니다. 데이터 출처와 이용 조건은
[`stock-monitor/SOURCES.md`](stock-monitor/SOURCES.md) 를 보십시오.

투자의 최종 판단과 책임은 전적으로 사용자 본인에게 있습니다.
