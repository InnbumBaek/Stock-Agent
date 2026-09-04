# Stock-Agent

주식 관련 두 프로젝트를 한 저장소에 담았습니다. **합친 것이 아니라 이어 붙였습니다.**
각자 원래대로 혼자 돌아가고, 사이에 얇은 계층 하나가 있을 뿐입니다.

| 프로젝트 | 무엇을 하는가 | 언어 |
|---|---|---|
| [`stock-monitor/`](stock-monitor/) | 상장 포트폴리오사의 **회수(엑싯) 시점 판단**에 필요한 사실을 KRX·DART 공식 API 로 매일 모아 단일 HTML 리포트로 만듭니다 | Python |
| [`trading-floor/`](trading-floor/) | 티커 하나를 넣으면 AI 에이전트들이 시장 데이터를 분석·토론해 **BUY/SELL/HOLD 판정**을 내리는 픽셀아트 트레이딩 오피스 웹앱입니다 | Node (npm 의존성 0) |

---

## 왜 합치지 않았는가

두 프로젝트의 핵심 원칙이 정반대입니다.

- **주가 모니터링** — *"판단은 사람이 합니다."* 등급·점수·권고를 내지 않습니다.
  측정값과, 그 측정값이 무엇을 셌는지, 어떤 가정 위에 서 있는지만 냅니다.
- **PIXEL TRADING FLOOR** — 판정을 내리는 것이 존재 이유입니다.

코드를 섞으면 둘 중 하나의 원칙이 깨집니다. 그래서 원장은 **측정값만** 내보내고,
데스크는 그것을 재료로 받아 판정합니다. 판정의 책임은 데스크에 있고, 원장은 끝까지
판단하지 않습니다.

```
  [stock-monitor]                          [trading-floor]
  KRX·DART 공식 API ─▶ ki.sqlite ─▶ facts (JSON) ─▶ ki-bridge.js ─▶ 프롬프트 ─▶ 판정
                        원장          측정값만          얇은 계층        DIANA·GUARD·SAFE
```

역방향은 없습니다. 데스크의 판정은 원장으로 돌아가지 않습니다 — 공식 API 로 측정한
사실만 담는 장부에 AI 판정이 섞이면 다음 리포트의 신뢰가 무너집니다.

계약의 전문은 [`docs/integration.md`](docs/integration.md) 에 있습니다.

---

## 각각 따로 쓰기

두 프로젝트는 **단독으로 떼어내도 그대로 돕니다.** 통합은 기본값이 꺼짐이라,
켜기 전까지 동작은 통합 이전과 같습니다.

```bash
# 주가 모니터링 — 회수 판단 리포트
cd stock-monitor
cp .env.example .env            # KRX·DART 키를 채웁니다
python ki_monitor.py check-auth
python ki_monitor.py daily      # 적재 → 리포트
python ki_monitor.py selftest   # 71개 (키 불필요)
```

```bash
# PIXEL TRADING FLOOR — 에이전트 데스크
cd trading-floor
node server/server.js           # http://localhost:8000
# 데모 모드(claude CLI 없이): http://localhost:8000/?demo=1
npm test                        # 89개
```

자세한 사용법은 각 프로젝트의 README 를 보십시오 —
[주가 모니터링](stock-monitor/README.md) · [PIXEL TRADING FLOOR](trading-floor/README.md).

---

## 이어 붙이기 (선택)

원장의 실측값을 에이전트 프롬프트에 넣습니다.

```bash
# 1) 원장을 만들고 내보내기가 되는지 확인
cd stock-monitor
python ki_monitor.py ingest --from 20250101 --universe KOSPI
python ki_monitor.py facts --code 000660 --indent 2

# 2) 데스크에서 켠다
cd ../trading-floor
echo '{ "ki": { "enabled": true } }' > config.json
node server/server.js
curl "http://localhost:8000/api/ki?symbol=SKHYNIX"
```

켜면 DIANA(기본적 분석)·GUARD·SAFE(리스크)의 프롬프트에 이런 블록이 붙습니다.

```
[KRX·DART 실측 — 주가 모니터링 원장]
출처: 주가 모니터링 원장 (한국거래소 KRX Open API · 금융감독원 DART Open API)
기준일: 2026-08-12 (23일 경과)
주의: 원장이 23일 묵었다. 아래 값은 그 시점의 일별 종가 기준이며 현재가가 아니다.

[처분 여건 (유동성)]
- 시가총액 3% 처분 소요 — 평균 거래량 기준 37.3영업일, 중앙값 기준 42.2영업일
  (해당 기준 거래량의 10% 참여 가정)
- 최근 60일 거래대금의 36%가 상위 5일에 집중
...
[위 숫자가 서 있는 가정]
- 처분 소요일수 — 해당 기준 거래량의 10%만 장내에서 소화한다고 가정합니다. ...

위 값은 공식 API 로 측정한 사실이다. 등급·점수·권고가 아니다.
```

가정과 원장 기준일이 숫자와 **반드시 함께** 갑니다. 숫자만 넘기면 받는 쪽에서
가정이 사라지고, 일별 종가를 현재가로 읽으면 판정이 통째로 틀어지기 때문입니다.

원장이 없거나 파이썬이 없어도 데스크는 그대로 돕니다. 실측만 빠집니다.

---

## 저장소에 없는 것

아래는 `.gitignore` 로 제외됩니다. 저작권이 아니라 **자격증명·영업비밀** 문제입니다.

| 파일 | 이유 |
|---|---|
| `.env` | API 키. 유출되면 재발급 외에 방법이 없습니다 |
| `stock-monitor/ki.sqlite` | 87MB 원장. 공식 API 로 언제든 다시 만들 수 있습니다 |
| `stock-monitor/watchlist.csv` · `exit_plan.csv` · `positions.csv` | 포트폴리오사 실명·회수계획·보유 포지션 (대외비) |
| `trading-floor/config.json` | 텔레그램 봇 토큰이 들어갑니다 |
| `stock-monitor/out/` · `trading-floor/reports/` | 생성된 리포트 |

`*.sample.csv` 와 `.env.example` 은 뼈대로 남겨 두었습니다.

---

## 면책

`trading-floor` 는 **AI 시뮬레이션**이며 **투자 조언이 아닙니다.** 실제 주문·거래·
자금 이동은 발생하지 않고, 거래소 API 키나 결제 수단을 쓰지 않습니다.

`stock-monitor` 가 만드는 리포트는 **대외비 문서**이며 투자권유·투자자문 자료가
아닙니다. 데이터 출처와 이용 조건은 [`stock-monitor/SOURCES.md`](stock-monitor/SOURCES.md)
를 보십시오.

투자의 최종 판단과 책임은 전적으로 사용자 본인에게 있습니다.
