# 주가 모니터링 ↔ PIXEL TRADING FLOOR — 통합 계약 (단일 진실 소스)

두 프로젝트는 한 저장소에 있지만 **합쳐지지 않았다.** 각자 원래대로 혼자 돌아가고,
사이에 얇은 계층이 있을 뿐이다. 이 문서는 그 계층의 계약이다.

---

## 0. 무엇을 만들려는 것인가

**에이전트가 분석하고 판단한다. 그 결과를 회수 판단 리포트에 실어 오프라인 회의에 올린다.**

```
매일 · 자동                                   주 1회 · 회의
─────────────────────────────────────────    ──────────────
KRX·DART 공식 API 로 사실을 잰다
        ↓
에이전트 17명이 그 사실을 보고 토론해 판정한다
        ↓
측정값 §1~§4 + 에이전트 판정 §5 를 한 리포트로 낸다  →  사람이 읽고 결정한다
```

주가 모니터링의 설계 원칙인 *"판단은 사람이 합니다"* 는 **파이프라인이 판단하면 안 된다**는
뜻이 아니다. 자동화가 만든 산출물을 놓고 **최종 의사결정은 회의에서 사람이 한다**는 뜻이다.
그래서 에이전트 판정은 리포트에 실린다.

다만 **측정값과 판정은 절을 나눈다.** §1~§4 는 공식 API 로 잰 값이고 §5 는 언어모델의
의견이다. 같은 표에 섞으면 회의에서 그 구분이 사라지고, 근거 없는 결론이 근거 있는
숫자처럼 읽힌다.

---

## 1. 두 프로젝트

| | 주가 모니터링 (`stock-monitor/`) | PIXEL TRADING FLOOR (`trading-floor/`) |
|---|---|---|
| 언어 | Python (pandas·numpy·scipy) | Node 20+ (내장 모듈만, npm 의존성 0) |
| 데이터 | KRX·DART **공식 API**, 인증키 필요 | 키 없는 공개 API (Binance·Yahoo·CoinGecko) |
| 시간축 | **일별 종가** 원장 (SQLite) | 실시간~15분봉, 24시간 무기한 선물 |
| 대상 | 상장 포트폴리오사 (KOSPI·KOSDAQ 전체) | 하이닉스·삼성전자·주요 코인 |
| 역할 | **사실을 잰다** — 측정값·가정·한계 | **판단한다** — 분석·토론·판정 |
| 산출물 | 단일 HTML 리포트 (회의 자료) | 픽셀 오피스 웹앱 + 마크다운 리포트 |

두 도구의 역할이 다르므로 코드를 섞지 않는다. 원장은 끝까지 재기만 하고, 판정은 끝까지
데스크가 한다. 리포트는 둘을 **나란히** 싣는다.

---

## 2. 배치

```
Stock-Agent/
├─ stock-monitor/     주가 모니터링 — 원본 그대로
│   └─ ki_monitor.py  원본 5,317줄 + 파일 끝 '11. 통합 계층'
│                     · facts        관측 사실을 JSON 으로 내보낸다  (→ 데스크)
│                     · 에이전트 절   브리핑을 읽어 리포트에 싣는다  (← 데스크)
├─ trading-floor/     PIXEL TRADING FLOOR — 원본 그대로
│   └─ server/
│       · ki-bridge.js      원장 실측값을 읽어 프롬프트에 넣는다   (← 원장)
│       · export-brief.js   판정을 모아 브리핑 JSON 을 낸다        (→ 원장)
│       · engine.js         런마다 사이드카 JSON 을 함께 저장한다
└─ docs/integration.md      이 문서
```

각 하위 프로젝트는 **단독으로 떼어내도 그대로 돈다.** 각자의 `README.md`·`CLAUDE.md`·
`.gitignore`·테스트가 원본 그대로 남아 있다.

---

## 3. 데이터가 흐르는 방향 — 두 방향, 그러나 원장은 한 방향

```
                    ① 사실 → 판단의 재료
  ┌───────────────────────────────────────────────────────┐
  │                                                       ▼
[stock-monitor]                                    [trading-floor]
 KRX·DART API                                       에이전트 17명
      ↓                                                   │
  ki.sqlite ──▶ facts (JSON) ──▶ ki-bridge.js ──▶ 프롬프트 │
   원장                     FLOW·FILING·RED·DIANA·GUARD·SAFE·ACE
      │                                                   ▼
      │                                             판정 (BUY/SELL/HOLD)
      │                                                   │
      │                                       engine.js 사이드카 (floor.run/1)
      │                                                   │
      │                                            export-brief.js
      │                                                   │
      ▼                                          agent-brief.json
  HTML 리포트  ◀──────────────────────────────────────────┘
   §1~§4 측정값                ② 판단 → 회의 자료
   §5 에이전트 판정
```

### 원장(`ki.sqlite`)에는 절대 쓰지 않는다

되돌아오는 것은 **리포트**이지 **원장**이 아니다. `ki.sqlite` 는 공식 API 로 측정한
사실만 담는 장부다. AI 판정·가상 포지션·성적표를 여기에 쓰면 다음번 측정이 오염되고,
그 오염은 되돌릴 수 없다.

- 리포트(HTML 산출물) ← 에이전트 판정을 **별도 절로** 싣는다. ✔
- 원장(SQLite) ← 에이전트 판정을 쓴다. ✘ 하지 않는다.

---

## 4. 방향 ① — 원장이 데스크에 사실을 준다

### 4.1 Python 쪽 — `ki_monitor.py facts`

```bash
python ki_monitor.py facts --code 000660
python ki_monitor.py facts --codes 000660,005930 --indent 2
python ki_monitor.py facts                      # watchlist.csv 의 상장 종목 전부
python ki_monitor.py facts --code 000660 --with-disclosures   # DART 공시까지
```

- **stdout 은 JSON 만.** 진단 메시지는 전부 stderr 로 간다. 이게 깨지면 통합이 깨진다.
- **네트워크를 쓰지 않는다** (기본값). 원장에 있는 것만 낸다.
- 종료코드: 정상 `0`, 실패 `1`. **실패해도 stdout 에는 JSON 이 나간다**
  (`{"ok": false, "reason": "..."}`). 받는 쪽이 이유를 알아야 하기 때문이다.
- 시장(`--market`)을 물어보지 않는다. 종목코드로 원장에 물어 KOSPI/KOSDAQ 를 가른다.

#### 스키마 `ki.facts/1`

```jsonc
{
  "ok": true, "schema": "ki.facts/1", "calc_version": "single-v1",
  "generated_at": "2026-09-04T10:21:00", "stage": "personal",

  "units":       { "days_3pct": "영업일 (시총 3% 처분, 평균 거래량 기준)", ... },
  "assumptions": ["처분 소요일수 — 거래량의 10%만 소화한다고 가정합니다. ...", ...],
  "notes":       ["이 데이터는 측정값입니다. 등급·점수·권고가 아닙니다.", ...],

  "markets": {
    "KOSPI": {
      "as_of": "2026-08-12",      // 원장의 마지막 영업일
      "stale_days": 23,           // 오늘로부터 며칠 지났는가
      "n_days": 243,              // 관측기간 — 분위(pctile)의 의미가 여기 달렸다
      "n_stocks": 1885, "benchmark": "코스피", "fs_companies": 1799,
      "regime": { "rate": { "label": "국고채 3년", "value": 3.799,
                            "display": "3.799%", "pctile": 0.91, "chg20": -0.084,
                            "what": "국채전문유통시장 지표물 종가수익률" } }
    }
  },

  "stocks": {
    "000660": {
      "found": true, "code": "000660", "name": "SK하이닉스", "market": "KOSPI",
      "sector": null, "as_of": "2026-08-12", "stale_days": 23, "close": 1504000.0,
      "measures":     { "days_3pct": 37.27, "days_3pct_med": 42.17, "beta": null, ... },
      "observations": { "liq": [...], "px": [...], "cap": [...], "fin": [...], "events": [...] },
      "volume_profile": [{ "price": 1200000.0, "share": 0.08 }, ...]
    },
    "999999": { "found": false, "code": "999999", "reason": "원장에 이 종목의 시세가 없습니다" }
  },
  "missing": ["999999"]
}
```

| 규칙 | 왜 |
|---|---|
| 모르면 `null`. 0 으로 채우지 않는다 | 받는 쪽이 '측정 못 함'과 '0으로 측정됨'을 구분해야 한다 |
| `units` 가 값과 함께 나간다 | 금융 데이터는 단위가 틀려도 계산이 돌아간다. 조용히 틀린다 |
| `assumptions` 가 값과 함께 나간다 | 처분 소요일수는 참여율 가정 위에 서 있다 |
| `stale_days` 가 항상 나간다 | 일별 종가를 현재가로 읽으면 판정이 통째로 틀어진다 |
| `found:false` 를 명시한다 | 조용히 빼면 "조회했는데 없다"와 구분이 안 된다 |
| 등급·점수·권고 키가 없다 | 재는 쪽은 재기만 한다. 판정은 데스크의 몫이다 |

`measures` 는 `units` 에 등재된 키만 나간다. 중간 계산 컬럼이 새어 나가면 받는 쪽이
뜻 모르는 숫자를 근거로 쓴다.

### 4.2 Node 쪽 — `server/ki-bridge.js`

```js
module.exports = { DEFAULT_KI, DEFAULT_SCRIPT, isEnabled, kiConfig, krCodeOf,
                   fetchKiFacts, fetchKiCandles, formatKiLines, formatKiPriceLine,
                   clearCache, _setSpawn }
```

| 함수 | 시그니처 | 설명 |
|---|---|---|
| `isEnabled(cfg?)` | `=> boolean` | `ki.enabled`. 꺼져 있으면 아무것도 하지 않는다 |
| `kiConfig(cfg?)` | `=> object` | DEFAULTS 와 병합된 `ki` 설정 사본 |
| `krCodeOf(x)` | `=> '000660'\|null` | `'000660'` · `'000660.KS'` → 코드 |
| `fetchKiFacts(code, {cfg}?)` | `=> Promise<facts\|null>` | 파이썬 스폰 → JSON. **절대 reject 하지 않는다** |
| `fetchKiCandles(code, {cfg}?)` | `=> Promise<candles\|null>` | 원장 일봉 (ki.candles/1). 캐시는 facts 와 분리 |
| `fetchKiQuote(code, {cfg}?)` | `=> Promise<quote\|null>` | 실시간 시세 (ki.quote/1). **`ki.realtime` 이 꺼져 있으면 스폰조차 하지 않는다.** 캐시는 초 단위 |
| `formatKiQuoteLine(quote, label)` | `=> string\|null` | 실시간 시세 줄. 못 만들면 null → 원장 종가 줄이 남는다 |
| `formatKiMicroLines(quote)` | `=> string[]` | 호가·잔량·스프레드 블록. **FLOW 전용** |
| `formatKiLines(facts, code, opts?)` | `=> string[]` | 프롬프트용 한국어 줄. 없으면 `[]` |
| `formatKiPriceLine(candles, label)` | `=> string\|null` | 원장 시세 한 줄. 실시간이 아님을 문장에 박는다 |
| `clearCache()` / `_setSpawn(fn)` | | 캐시 비우기 / 테스트 주입구 |

- **외부 npm 의존성 0.** `node:child_process` · `fs` · `path` 만 쓴다.
- **절대 throw 하지 않는다.** 실패는 `console.error` 한 줄 + `null`.
- **성공도 실패도 캐시한다** (기본 30분 / 실패 1분).
- **`python3` → `python` 순서로 찾는다.** `ki.python` 을 지정하면 그것을 먼저.
- 측정값을 등급·점수로 바꾸지 않는다. `formatKiLines` 의 마지막 줄이 이것을 명시한다.

### 4.3 막힌 망에서의 캔들 — `ki_monitor.py candles`

데스크는 무료 공개 API(야후·바이낸스)로 캔들을 받는다. 그런데 **캔들 실패는 데스크에서
유일한 치명적 실패**다 — 사내망·폐쇄망처럼 그 API 가 막힌 곳에서는 분석 자체가 선다.

우리에게는 이미 **한국거래소 공식 API 로 받은 일별 시세**가 원장에 있다. 그것을 쓴다.
지어내는 것이 아니라 있는 것을 쓰는 것이다.

```bash
python ki_monitor.py candles --code 000660 --days 200
python ki_monitor.py candles --code 000660 --raw      # 수정주가 대신 원주가
```

```jsonc
{
  "ok": true, "schema": "ki.candles/1",
  "code": "000660", "name": "SK하이닉스", "market": "KOSPI",
  "currency": "KRW",                                    // 원화. 달러 무기한과 섞이면 안 된다
  "source": "한국거래소 KRX Open API — 일별 시세 (원장)",
  "interval": "1d", "adjusted": true,
  "n": 200, "first": "2025-08-13", "as_of": "2026-08-12", "stale_days": 23,
  "candles": [{ "t": 1786492800000, "o": 1456000.0, "h": 1549000.0,
                "l": 1440000.0, "c": 1504000.0, "v": 4566672.0 }]
}
```

| 규칙 | 왜 |
|---|---|
| `t` 는 거래일 **UTC 자정**의 epoch(ms) | 받는 쪽이 `toISOString().slice(0,10)` 을 날짜로 쓴다. 어긋나면 캔들 날짜가 하루씩 밀린다 |
| OHLC 가 하나라도 빈 봉은 **버린다** (자르기 전에) | 0 으로 채우면 지표가 조용히 틀어진다. 자른 뒤 버리면 요청한 일수보다 적게 나가고 이유를 알 수 없다 |
| 기본은 **수정주가** (`adj_factor` 적용) | 무상증자·액면분할 구간에서 지표가 통째로 틀어진다 |
| `currency` 를 명시한다 | 원화 정규장과 USDT 무기한은 절대 섞이면 안 되는 두 가격 축이다 |
| `as_of`·`stale_days` 를 함께 낸다 | 일별 종가다. 실시간 호가가 아니다 |

**폴백 조건 — 야후가 실패했을 때만.** 순서는 이렇다.

1. 야후 차트를 먼저 시도한다 (평소 경로, 변경 없음)
2. 실패하고 `ki.enabled` 와 `ki.candleFallback` 이 모두 켜져 있으면 원장 일봉을 쓴다
3. 그것도 없으면 **원래 오류를 그대로 올린다** — 없는 값을 만들지 않는다

폴백이 켜지면 시세 한 줄에 출처와 기준일이 박힌다.

```
SK하이닉스 ₩1,504,000 (+5.54%) · KRX 정규장 종가 2026-08-12 (23일 경과)
  — 한국거래소 공식 API 로 받은 일별 시세이며 실시간 호가가 아니다
```

이 경로에는 **실시간 호가·시가총액·인트라데이·무기한 선물이 없다.** 기본적 데이터
블록이 그 사실을 명시한다. 스캘핑·공격 모드는 무기한 차트를 전제로 하므로 이 경로에서는
레벨의 신뢰도가 떨어진다 — `algo` 모드를 쓰는 편이 맞다.

### 4.3-b 실시간 시세 — `ki_monitor.py quote`

원장은 **일별 종가**다. 며칠 지난 값을 현재가로 읽으면 목표가·괴리·손익비가 통째로
틀어진다. 그 신선도만 한국투자증권 KIS Open API 로 메운다.

원래 이 자리에는 KB증권이 있었다. 2026-08-13 실측에서 `openapi.kbsec.com` 은 API
게이트웨이가 아니라 서비스 포탈이고 공개 카탈로그 20개가 전부 계좌개설·주문 계열이라
**시세 API 가 하나도 없다**는 것이 확인됐다. 반면 원 코드의 `field_map`
(`stck_prpr`·`bidp1` …)은 처음부터 KIS 스키마였다. 붙일 수 없는 서버를 빼고 맞는
서버를 꽂은 것이다.

```bash
python ki_monitor.py quote --code 000660 --indent 2
python ki_monitor.py quote --code 000660 --no-orderbook   # 호가 생략 (호출 절반)
```

```jsonc
{
  "ok": true, "schema": "ki.quote/1", "code": "000660",
  "source": "한국투자증권 KIS Open API — 국내주식 현재가 · 호가",
  "realtime": true,
  "market_open": true,          // 정규장이 열려 있는가
  "checks": [],                 // 검산에 걸린 항목 (비어야 정상)
  "quote": {
    "price": 186200, "open": 185000, "high": 190000, "low": 180000,
    "prev_close": 185000, "volume": 1234567, "value": 2.3e11,
    "bid": 186100, "ask": 186300, "bid_qty": 1200, "ask_qty": 800,
    "change_pct": 0.6486,       // 기준가 대비
    "spread_bp": 10.74,         // (ask-bid)/mid
    "queue_imbalance": 0.2,     // (bid_qty-ask_qty)/합 — 양수면 매수 잔량이 두껍다
    "ts": "2026-09-04T13:20:00"
  }
}
```

| 규칙 | 왜 |
|---|---|
| **원장에 쓰지 않는다** (`CATALOG` 의 `kis.snap.*` 은 `persist=False`) | 원장은 KRX 공식 일봉만 담는 장부다. 장중 값이 섞이면 다음 측정이 오염된다 |
| **검산에 걸린 값은 내보내지 않는다** | 현재가가 고·저 범위 밖이거나 bid>ask 면 매핑 오류다. **틀린 현재가는 없는 것보다 나쁘다** |
| 실패는 예외가 아니라 `ok:false` + `reason` | 장 마감·휴장일·키 없음은 정상적인 '없음'이다. 부르는 쪽이 원장 종가로 갈아탄다 |
| **주문 API 는 화이트리스트에 없다** | KB 와 달리 KIS 는 같은 서버에 주문 API 가 있다. `allowed` 는 시세 두 개뿐이고 그 밖은 `OrderNotAllowed` |
| 토큰을 **파일에 캐시**한다 (`.kis_token.json`, 0600) | 브리지가 분석 한 번에 파이썬을 여러 번 새로 띄운다. 메모리 캐시만으로는 매번 새 토큰을 받아 발급 제한(EGW00133)에 걸린다 |
| `verified: False` 로 시작한다 | 실응답을 1회 대조하기 전까지는 매핑을 믿지 않는다. `kis_sanity` 가 매 호출 검산한다 |

**누가 무엇을 보는가 — 여기가 갈린다.**

| 값 | 받는 쪽 | 왜 |
|---|---|---|
| **현재가·등락률** (시세 줄) | **17명 전원** | 이 줄을 전원이 현재가로 읽는다. 신선도 문제이지 새 업무가 아니다 |
| **호가·잔량·스프레드·불균형** | **FLOW 만** | 방향이 아니라 '지금 이 가격에 얼마나 나가는가'다. 유동성·체결 담당의 재료 |

```
SK하이닉스 ₩186,200 (+0.65%) · 한국투자증권 KIS 장중 실시간 · 기준 2026-09-04 13:20
  — 원장의 일별 종가가 아니라 실시간 조회값이다
```

실시간을 못 받으면 이 줄을 만들지 않고 **원장 종가 줄이 그대로 남는다.** 값을 지어내지
않는다. 1호가만 보는 조회라 호가 블록 끝에 그 한계를 함께 적는다.

### 4.3-b-2 API 명세를 무엇으로 확인했는가

키가 있어도 **응답 모양이 코드의 가정과 다르면 조용히 틀린 값**이 나온다. 그래서
출처마다 어디까지 확인했는지를 코드에 남긴다.

| 출처 | `verified` (실응답 대조) | `spec_checked` (명세 대조) | 근거 |
|---|---|---|---|
| **KRX** | **True** | — | 원저자가 2026-08-13 실응답 942건 대조. 거래대금÷거래량이 고저 범위 안, 종가×상장주식수=시가총액 항등식까지 확인 |
| **DART** | 표준 라이브러리와 엔드포인트 일치 | — | `company.json` `corpCode.xml` `list.json` `majorstock.json` `elestock.json` `fnlttSinglAcntAll.json` |
| **KIS** | False | 2026-09-05 | 한국투자증권 **공식 예제 저장소**와 대조 |
| **ECOS** | False | 2026-09-05 | 한국은행 Open API 명세 및 표준 클라이언트 |

`verified` 와 `spec_checked` 는 다르다. 명세가 맞아도 **실제 값이 상식적인지는 한 번
받아 봐야 안다.** 그래서 KIS 는 `kis_sanity` 가 매 호출 검산하고(현재가가 고저 범위
밖이거나 bid>ask 면 값을 내보내지 않는다), ECOS 는 `RESULT.CODE` 를 잡는다.

**KIS 명세 대조에서 두 가지를 고쳤다.**

1. **시장 구분을 `J`(KRX 단독)로 못 박고 있었다.** 공식 예제는 `J:KRX, NX:NXT,
   UN:통합` 셋을 받는다. 넥스트레이드 개장 이후 KRX 만 보면 통합 최우선호가를
   놓친다 — 회수 판단에서 "지금 얼마에 팔리는가"는 통합 기준이 맞다.
   `UN → J` 폴백으로 바꾸고, **어느 쪽을 썼는지 응답에 남긴다**(`market_div`).
   UN 이 계좌·시점에 따라 거부될 수 있어 확인 없이 못 박지 않았다.

2. **토큰 만료를 `expires_in` 으로만 읽었다.** 공식은
   `access_token_token_expired`(`"YYYY-MM-DD HH:MM:SS"`)를 쓴다. 둘 다 본다.

### 아직 쓰지 않는 DART 엔드포인트

`document.xml` — **공시 원문**을 접수번호로 받는다(`crtfc_key` + `rcept_no`, ZIP).
지금은 제목과 원문 링크까지만 쓴다. 구조화 API(DS002·DS005)가 CB 발행조건·최대주주
같은 핵심을 이미 주므로 급하지 않지만, **보호예수·소송·계약처럼 구조화 API 가 없는
공시**는 원문에만 있다. 붙일 때는 프롬프트가 공시 전문으로 덮이지 않게 추출 범위를
먼저 정해야 한다.

### 4.3-c 출처 규율 — 무엇을 근거로 삼을 수 있는가

이 데스크의 재료는 신뢰 등급이 다르다. 공공기관 API 로 잰 값과 언론사 제목이 같은
무게로 프롬프트에 들어가면, 리포트에서 **"뉴스에서 봤다"가 "실측했다"처럼 읽힌다.**
회의에서 그 구분이 사라지는 것이 이 시스템의 가장 조용한 실패다.

게다가 같은 저장소의 `stock-monitor` 는 SOURCES.md 에서 "뉴스 기사 없음 — 기업 관련
사건은 DART 공시 원문으로만"을 원칙으로 두고 있었다. **한 저장소 안에서 원칙이
충돌하고 있었다.**

| 등급 | 출처 | 쓸 수 있는 범위 |
|---|---|---|
| **1차** | KRX 한국거래소 · DART 금융감독원 · 한국은행 ECOS · 한국투자증권 KIS | 근거로 삼아도 된다 |
| **참고** | 구글 뉴스 RSS 헤드라인 · 공포탐욕지수 | "이런 이야기가 돌고 있다"까지 |

`agents.js` 의 `SOURCE_RULE` 이 **17명 전원**의 프롬프트에 붙는다(ACE 는 조기 반환
경로라 별도로 붙인다). 규칙은 셋이다.

1. 숫자를 말할 때 어디서 온 값인지 함께 적는다.
2. **재료에 없는 숫자를 기억에서 꺼내 쓰지 않는다.** 학습 시점에 멈춘 값이고, 틀렸을
   때 아무도 추적할 수 없다. 모르면 "재료에 없다"고 적는다.
3. 헤드라인만 근거인 주장에는 **"미확인"**을 붙인다.

뉴스를 지우지는 않았다. 여론의 온도는 그 자체로 정보다. 다만 NOVA·VIBE 의 블록
제목을 `[언론 헤드라인 — 구글 뉴스 RSS · 참고 등급]` 으로 바꾸고, **헤드라인이 DART
공시와 어긋나면 공시를 믿으라**는 우선순위를 박았다.

DART 공시에는 접수번호로 만든 **원문 링크**가 붙는다
(`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=…`). 제목만으로는 발행조건·전환가·
리픽싱 조항을 알 수 없고, 그건 1차 출처를 본 것이 아니다.

`test/roster.test.mjs` 가 이 규율을 강제한다.

### 4.3-d 거시 재료 — `ki_monitor.py macro` (한국은행 ECOS)

에이전트가 금리·환율·경기를 이야기할 때 그 숫자는 전부 **언어모델의 기억**에서
나오고 있었다. `.env` 에 `ECOS_API_KEY` 가 있는데도 코드가 한 번도 쓰지 않았다.

```bash
python ki_monitor.py macro --indent 2
```

```jsonc
{
  "ok": true, "schema": "ki.macro/1",
  "source": "한국은행 경제통계시스템(ECOS) — 100대 통계지표",
  "source_url": "https://ecos.bok.or.kr/api/",
  "fetched_at": "2026-09-05T04:14:30",
  "n": 100,
  "stats": [
    { "group": "통화/금리", "name": "한국은행 기준금리",
      "value": 2.50, "unit": "연%", "as_of": "202608" }
  ]
}
```

| 규칙 | 왜 |
|---|---|
| **통계표코드를 하드코딩하지 않는다** | `722Y001` 같은 코드는 출처마다 설명이 엇갈린다. 확인 없이 박아 두면 엉뚱한 계열을 '기준금리'라고 부르게 된다. `KeyStatisticList` 는 응답이 통계명을 스스로 들고 온다 |
| 한국은행이 준 **통계명·단위·시점을 그대로 보존한다** | 이쪽에서 이름을 붙이는 순간 "한국은행이 이렇게 말했다"가 아니라 "우리가 이렇게 불렀다"가 된다 |
| 요청 형식 `/api/{서비스}/{인증키}/json/kr/1/100` | 명세 그대로 |
| ECOS 가 **HTTP 200 에 담아 보내는 실패**(`RESULT.CODE`)를 잡는다 | 안 잡으면 빈 통계를 정상 응답으로 읽는다 |
| 값이 없으면 `null` | 0 으로 채우면 '기준금리 0%'가 된다 |
| 실패는 예외가 아니라 `ok:false` + `reason` | 거시 재료가 없다고 분석 전체가 서면 안 된다 |

`facts` 는 네트워크 없이 도는 것이 계약이므로 여기에 섞지 않는다. `quote` 와 같은
별도 명령이다.

**누가 보는가 — DIANA·RED 만.**

| 역할 | 이 숫자로 무엇을 하는가 |
|---|---|
| **DIANA** (기본적) | 금리는 **할인율**이다. 밸류에이션 계산에 직접 들어간다 |
| **RED** (가정 심문) | "이 판정이 **어떤 금리 국면을 전제**하고 있는가"가 그 역할이다 |

둘은 같은 숫자를 다른 일에 쓴다. 나머지에게 주지 않는 이유는 분업이다 — 매크로는
모두에게 그럴듯하게 읽히는 재료라, 전원에게 주면 17명이 같은 거시 서사를 반복하고
앙상블이 무너진다. ACE 는 DIANA 의 리포트로 그 판단을 받는다.

`ki.macro` 를 켜야 돌고, **종목이 아니라 시장 배경이라 런당 한 번만** 조회한다.
100개를 다 넣지 않는다 — 프롬프트가 통계표가 되면 아무도 안 읽는다. 금리·통화·환율
순으로 12개를 싣고, 나머지가 있다는 사실만 적는다.

`roster.test.mjs` 가 이 배정을 강제한다.

### 4.4 설정 (`config.json` 의 `ki` 블록)

```jsonc
{
  "ki": {
    "enabled": false,          // 기본 꺼짐
    "python": "", "script": "",
    "timeoutSec": 30, "cacheMin": 30,
    "withDisclosures": false,  // 켜면 DART 공시까지 (네트워크·키 필요)
    "staleWarnDays": 5,        // 원장이 이만큼 묵으면 프롬프트에 경고
    "injectInto": ["diana", "guard", "safe", "ace"],
    "candleFallback": true,    // 야후가 막히면 원장 일봉으로 대신한다
    "candleDays": 200,         // 대체 시 가져올 일수

    "realtime": false,         // KIS 실시간 시세. **기본 꺼짐** — 켜야 돈다
    "realtimeOrderbook": true, // 호가까지 받을지 (끄면 KIS 호출이 종목당 2→1회)
    "quoteCacheSec": 20,       // 실시간을 분 단위로 묵히면 실시간이 아니다

    "macro": false,            // 한국은행 ECOS 거시 지표. **기본 꺼짐**
    "macroCount": 60           // 100대 통계 중 앞에서 몇 개를 받을지
  }
}
```

`realtime` 은 `enabled` 와 **별개의 스위치**다. 원장만 켜고 실시간은 끈 상태가 기본이며,
그 상태의 동작은 실시간 도입 이전과 같다.

`server/config.js` 의 `DEFAULTS.ki` 와 `ki-bridge.js` 의 `DEFAULT_KI` 는 **키가 같아야 한다** —
한쪽에만 키가 생기면 설정이 조용히 무시된다. 테스트가 검사한다.

### 4.5 누가 원장의 어느 부분을 보는가 — **겹치지 않게 나눈다**

에이전트를 늘릴 때의 규칙은 하나다. **새 역할에는 새 업무를 준다.**

같은 재료를 여러 명이 보면 (1) 의견이 서로 상관돼 앙상블의 이점이 사라지고,
(2) 전담이 없어 아무도 깊이 보지 않는다. 그래서 신규 3인에게는 **통합 이전에는
아무도 보지 못하던 값**을 배정했고, 기존 역할에서는 그만큼을 뺐다.

| 에이전트 | 담당 블록 | 이 역할만의 업무 |
|---|---|---|
| **FLOW** (유동성·체결) | `liq` `px` `extras` **`profile`** **`exec`** + **실시간 호가** | 실행 시뮬레이션·매물대·1호가 — **밖으로 나가지 않던 값이다.** 방향이 아니라 실행 가능성만 본다 |
| **FILING** (공시·자본구조) | `cap` `fin` `events` **`capital`** | 미상환 사채·최대주주 지분·리픽싱 — 역시 새로 내보낸 값. 가격이 아니라 주식수와 물량을 본다 |
| **RED** (가정 반대심문) | **`assumptions`** **`limits`** `regime` | 값이 아니라 **값의 한계**를 심문한다. 판정이 아니라 판정의 토대를 공격한다 |
| DIANA (기본적) | `fin` `px` `extras` `regime` | 밸류에이션·펀더멘털 (본래 역할) |
| GUARD·SAFE (리스크) | `liq` `px` (+SAFE `cap`) | 청산 위험과 다른 축의 리스크 |
| ACE (수석) | `liq` `px` `fin` `events` | 종합 판단용 요약. 상세는 애널리스트 리포트로 받는다 |
| TARO·NOVA·VIBE·BULL·BEAR·PM | — | 실측을 받지 않는다 |

블록 배정은 `agents.js` 의 `KI_SECTIONS` 가, 상세도는 `KI_DETAIL` 이 정한다
(FLOW 만 `detail:'full'` — 매물대 전 구간·규칙 전체·사분위까지).
`ki.injectInto` 는 **기존 역할**에만 적용되고, `requiresKi` 역할은 목록과 무관하게
항상 받는다 — 실측을 보라고 만든 자리이기 때문이다.

ACE 는 `buildPrompt` 에서 조기 반환하므로 공통 푸터를 타지 않는다. 별도 주입 지점이
있고, 한 프롬프트에 두 번 들어가지 않도록 `kiUsed` 로 막는다.

`roster.test.mjs` 가 이 분업을 강제한다 — 실행 시뮬레이션·매물대·**실시간 호가**가
FLOW 외에 붙거나, 자본구조가 FILING 외에 붙거나, 가정·한계가 RED 외에 붙으면 테스트가
깨진다.

### 4.6 명단 — 13명 → 16명, 그러나 비용은 조건부

| 모드 | 원장 있는 한국 종목 | 코인·해외주식 |
|---|---|---|
| `algo` | 애널 6 + 토론 4 + ACE 1 + 위원회 4 + PM 1 = **opus 16콜** | 애널 4 + 토론 4 + ACE 1 + 위원회 3 + PM 1 = **opus 13콜** |
| `scalp`·`attack` | 변동 없음 (애널 2 + 스캘핑 2 + ACE 1) | 변동 없음 |

신규 3인은 `requiresKi: true` 다. 엔진의 `filterByKi()` 가 원장 실측이 없는 런에서는
명단에서 뺀다 — 볼 것이 없는 에이전트를 돌리면 opus 콜만 태우고 "데이터 없음"만
돌아온다. **통합 이전 대상(코인·해외주식)의 비용은 그대로다.**

RED 는 `RISK_ORDER` 의 마지막 바로 앞(`risky → safe → red → neutral`)에 둔다.
NEUTRAL 이 RED 의 지적까지 중재하게 하기 위해서다.

### 4.7 KR_STOCKS 밖의 종목 — 포트폴리오사

`trading-floor` 는 원래 하이닉스·삼성전자 둘만 한국 주식으로 알았다. USDT 무기한
선물이 상장돼 있어 24시간 체결 차트를 읽을 수 있는 종목들이다.

회수 판단 대상은 그렇지 않다. 무기한 선물이 없는 보통의 상장사이고, 그래도
**원장에 시세가 있으면 분석할 수 있어야 한다.**

```bash
node server/export-brief.js --run --symbols 000250,058970 --mode algo
```

`resolveSymbol` 이 KRX 6자리 코드를 받으면 `kind:'krstock'` · `generic:true` 로
해석한다. 그 경로에서 달라지는 것:

| | KR_STOCKS 등재 (하이닉스·삼성전자) | KRX 코드 (`generic`) |
|---|---|---|
| 야후 심볼 | 표에 박혀 있다 (`000660.KS`) | 모르면 `.KS` → `.KQ` 순으로 찾는다 |
| 종목명 | 표에 있다 | **원장이 채워 준다** (`market.nameKo`) |
| `market.perp` | 있다 (바이낸스 무기한) | **없다** |
| `market.board` | 있다 (거래소 전광판) | **없다** |
| 프롬프트 | 이중 가격 체계 안내 | "무기한 선물이 상장돼 있지 않다" 안내 |

**이 경로는 `algo` 모드용이다.** 20배 스캘핑의 전제는 체결 차트(무기한)인데 그것이
없다. 정규장 차트로 20배 포지션을 설계하면 ATR 이 부풀려져 멀쩡한 셋업이 잘못
기각된다. 그래서 기본적 데이터 블록에 그 사실을 명시한다.

종목명은 사이드카(`floor.run/1`)의 `nameKo` 로 실려 리포트에 회사명으로 찍힌다 —
회의 자료에 `000250` 이 아니라 `삼천당제약` 이 보여야 한다.

---

## 5. 방향 ② — 데스크가 원장 리포트에 판정을 준다

### 5.1 사이드카 — `floor.run/1`

엔진이 런마다 마크다운 옆에 같은 이름의 `.json` 을 쓴다.

```
reports/2026-09-04-SKHYNIX-1030.md      사람이 읽는 것
reports/2026-09-04-SKHYNIX-1030.json    기계가 읽는 것 (floor.run/1)
```

마크다운을 되파싱하지 않는다 — 서식이 조금만 바뀌어도 조용히 깨진다. 같은 재료로
JSON 을 한 벌 더 쓸 뿐이고, 여기서 새로 계산하거나 요약하지 않는다.

```jsonc
{
  "schema": "floor.run/1", "ts": "2026-09-04T01:30:00.000Z",
  "symbol": "SKHYNIX", "display": "SKHYNIX", "kind": "krstock",
  "nameKo": "SK하이닉스",
  "krCode": "000660",          // 워치리스트와 조인하는 키. 한국 주식이 아니면 null
  "mode": "algo", "mock": false,
  "reportFile": "2026-09-04-SKHYNIX-1030.md",
  "priceLine": "...", "perpPriceLine": "...",
  "kiAsOf": "2026-08-12",      // 이 판단이 참고한 원장 기준일

  "decision": {
    "action": "BUY", "confidence": 64,
    "entry": "1,480,000원", "stop": "1,400,000원", "target": "1,700,000원",
    "rationale": "...", "verdict": "APPROVE", "sizing": "계좌 대비 2%",
    "riskDowngraded": false, "scalp": null,
    "risk": { "rr": 2.75, "ok": true, "minRR": 1.5, "reasons": [] }
  },
  "analysts":      [{ "id": "diana", "name": "DIANA", "bubble": "...", "report": "..." }],
  "debate":        [{ "turn": 1, "id": "bull", "name": "BULL", "bubble": "...", "report": "..." }],
  "scalpDesk":     [...], "riskCommittee": [...],
  "pm":            { "failed": false, "verdict": "APPROVE", "sizing": "...", "rationale": "...", ... },
  "memory":        ["직전 판정(2026-08-20 BUY) 이후 -3.1%"],
  "disclaimer":    "본 판정은 AI 시뮬레이션 결과이며 투자 조언이 아닙니다. ..."
}
```

없는 값은 `null` 이다. 확신도 없음이 `0` 으로 둔갑하면 성적표 집계까지 틀어진다.

### 5.1-b 판정 성적표 — `server/scorecard.js` → `agent.scorecard/1`

이 데스크는 매주 의견을 만든다. 그런데 그 의견이 맞았는지 아무도 채점하지 않으면
회의에서 17명의 말이 전부 같은 무게로 읽힌다. **이것이 통합 이후 가장 큰 구멍이었다.**

부품은 이미 있었다. `stats.js` 가 확신도 캘리브레이션을 계산하고, `decisions.json` 에
판정이 쌓이고, 사이드카에 목표가·손절가가 남는다. 셋이 서로 연결돼 있지 않았을 뿐이다.

```jsonc
{
  "ok": true, "schema": "agent.scorecard/1",
  "total": 40,
  "overall": { "evaluated": 31, "pending": 5, "flat": 4,
               "hitRate": 61.3, "avgReturnPct": 3.2 },
  "calibration": [                       // 스스로 말한 확률 vs 실제
    { "bucket": "80-89", "n": 11, "predicted": 83.0, "actual": 63.6, "gap": 19.4 }
  ],
  "levels": {                            // 제시한 가격에 실제로 닿았는가
    "n": 9, "target_hit": 4, "stop_hit": 2, "still_open": 3, "ambiguous": 0,
    "target_rate": 66.7, "median_days_to_target": 18,
    "rows": [ { "ts": "...", "code": "462350", "action": "SELL",
                "target": 120000, "stop": 90000, "outcome": "target", "days": 12 } ]
  },
  "limits": [ "개별 에이전트의 적중률은 아직 낼 수 없다 …" ],
  "note": "표본 31건 — 참고용(표본 편향 가능)"
}
```

| 규칙 | 왜 |
|---|---|
| **원장으로 채점한다** (`makeLedgerPriceLookup`) | `stats.js` 의 기본 경로는 야후다. 포트폴리오사는 그쪽에 없고 사내망에서는 야후 자체가 막힌다. 이미 받아 둔 KRX 공식 일봉을 쓴다 |
| **같은 날 목표·손절에 모두 닿으면 어느 쪽으로도 세지 않는다** (`ambiguous`) | 일봉으로는 순서를 알 수 없다. 유리한 쪽으로 세면 성적이 조용히 부풀려진다 |
| **판정 이후 시세가 없으면 `pending`** | 추측하지 않는다. 승률 계산에서 빠진다 |
| **개별 에이전트 적중률은 내지 않는다** | 애널리스트는 자유 문장을 내고 방향 라벨이 없다. 텍스트에서 방향을 추정하면 **없는 성적을 지어내는 것**이다. `limits` 에 그 사실을 적는다 |
| **표본 수를 항상 함께 낸다** | 3건으로 낸 60% 와 300건으로 낸 60% 는 다른 숫자다. 30건 미만은 리포트에 경고를 붙인다 |
| 성적표를 못 만들어도 브리핑은 나간다 (`scorecard: null`) | 성적표 없는 회의 자료가, 회의 자료가 아예 없는 것보다 낫다 |

리포트에서는 **에이전트 절 바로 뒤**에 붙는다(`#ss`). 판정을 읽은 직후에 그 판정을
얼마나 믿을지 알아야 하기 때문이다 — 절을 떨어뜨려 놓으면 아무도 뒤까지 넘기지 않는다.

`--no-scorecard` 로 끌 수 있다. 껐을 때의 브리핑은 성적표 도입 이전과 같다.

### 5.2 브리핑 — `server/export-brief.js` → `agent.brief/1`

```bash
node server/export-brief.js --run --symbols SKHYNIX,SAMSUNG --mode algo
node server/export-brief.js                    # 기존 리포트만 모은다 (분석 안 함)
node server/export-brief.js --run --demo       # claude 없이 목업으로 (연결 시험)
node server/export-brief.js --max-age-hours 24 # 하루 지난 분석은 뺀다
```

| 옵션 | 뜻 |
|---|---|
| `--run` | **실제로 분석을 실행한다.** 없으면 저장된 리포트를 모으기만 한다 |
| `--symbols A,B` | 대상. 없으면 `config.json` 의 `watchlist` |
| `--mode algo\|scalp\|attack` | `--run` 일 때의 파이프라인 |
| `--demo` | `--run` 과 함께 — 목업 응답 (claude 불필요) |
| `--out <경로>` | 기본 `reports/agent-brief.json` |
| `--max-age-hours N` | 수집 시 N시간보다 오래된 건 제외 |

**`--run` 없이는 절대 분석을 돌리지 않는다.** 실전 런은 에이전트 최대 17명 × claude opus 라
비용이 크다. 실수로 돌아가면 안 된다.

`stdout` 은 **사람용 진행 상황**이고 결과는 파일로 쓴다 — `facts` 와 반대다.
방향이 다르기 때문이다. 여기서는 몇 분씩 걸리는 진행을 사람이 봐야 한다.

```jsonc
{
  "schema": "agent.brief/1",
  "generated_at": "2026-09-04T01:58:00.000Z",
  "source": "PIXEL TRADING FLOOR",
  "mode": "algo",
  "executed": true,            // 이번에 돌렸는가, 저장된 것을 모았을 뿐인가
  "disclaimer": "본 브리핑은 AI 에이전트의 분석·토론 결과이며 투자 조언이 아닙니다. ...",
  "runs": { "000660": <floor.run/1>, "BTC": <floor.run/1> },   // 키: KRX 코드 ?? 표시명
  "by_code": ["000660", "005930"],   // 한국 상장 — 워치리스트와 조인 가능
  "others":  ["BTC"],                // 그 외
  "errors":  [{ "symbol": "SAMSUNG", "message": "Yahoo chart HTTP 403" }]
}
```

실패한 종목은 `errors` 에 이유가 남는다. 조용히 빠지지 않는다.

### 5.3 리포트에 싣기 — `ki_monitor.py report --with-agents`

```bash
python ki_monitor.py report --with-agents
python ki_monitor.py report --with-agents --brief ../trading-floor/reports/agent-brief.json
python ki_monitor.py daily  --with-agents        # 적재 → 리포트 한 번에
```

기본 경로는 `../trading-floor/reports/agent-brief.json` 이다.

| Python 쪽 | 설명 |
|---|---|
| `agent_brief_load(path=None)` | 브리핑을 읽는다. 없거나 깨졌으면 `None` — **예외를 올리지 않는다** |
| `render_agents_block(brief, codes=None)` | 절 본문 HTML. `codes` 순서를 우선한다 |
| `ctx["agents_enabled"]` / `ctx["agents"]` | 렌더러가 보는 스위치와 데이터 |

리포트에서 이 절이 지키는 것:

1. **측정값과 판정을 섞지 않는다.** 별도의 절이고, 머리에 "AI 에이전트의 판정입니다 —
   위 절들의 측정값과 성격이 다릅니다" 배너가 붙는다.
2. **판정을 요약하거나 재해석하지 않는다.** 에이전트가 쓴 문장을 그대로 옮긴다.
   애널리스트 리포트·토론 로그·리스크 위원회 의견이 접이식으로 전문 그대로 실린다.
3. **언제 분석한 것인지 밝힌다.** 분석 시각, `executed`(새로 돌렸는지 모은 것인지),
   참고한 원장 기준일(`kiAsOf`), 데모 런이면 그 사실까지.
4. **강등을 숨기지 않는다.** 리스크 게이트가 판정을 강등했으면 그 사실과 사유를 함께 싣는다.
5. **에이전트 출력을 HTML 이스케이프한다.** 언어모델이 만든 문자열이 그대로 들어가면
   리포트가 깨지거나 스크립트가 실행된다. `selftest` 가 이것을 검사한다.
6. **없으면 없다고 적는다.** 브리핑이 없으면 만드는 방법을 안내한다.

### 5.4 절 번호

`--with-agents` 를 주면 목차가 이렇게 된다.

```
1 무엇을 결정해야 하는가   2 팔 수 있는가      3 어떻게 팔 것인가
4 지금이 그 때인가         5 에이전트 분석 ←   6 종목별 상세
7 밸류에이션               8 시장 배경         9 출처
```

주지 않으면 원래의 1~8 그대로다. **에이전트 절을 끄면 생성되는 HTML 이 통합 이전
원본 코드의 출력과 바이트 단위로 같다** — 이것이 회귀가 없다는 증거다.

---

## 6. 기존 모듈에 붙은 것 — 전부 더하기만 했다

| 파일 | 변경 | 내용 |
|---|---|---|
| `stock-monitor/ki_monitor.py` | +약 700 / −0 | 파일 끝 '11. 통합 계층' 섹션 · 서브커맨드 · 자리표시자 |
| `trading-floor/server/config.js` | +12 / −0 | `DEFAULTS.ki` 블록 |
| `trading-floor/server/market.js` | +약 100 / −12 | `krstock` 경로에 원장 조회·캔들 폴백·임의 KRX 코드, 반환에 `krCode`·`ki` |
| `trading-floor/server/agents.js` | +약 50 / −0 | `kiLines()` 헬퍼 + DIANA·ACE·공통 푸터 주입 지점 |
| `trading-floor/server/server.js` | +68 / −0 | `GET /api/ki` 라우트 |
| `trading-floor/server/engine.js` | +약 90 / −0 | `_runRecord()` + 사이드카 저장 |

기존 SSE 이벤트·모드·리포트(.md) 형식·`decisions.json` 은 **하나도 바뀌지 않았다.**

---

## 7. 한 번에 돌리기

```bash
# 0) 원장 준비 (하루 한 번, 자동화)
cd stock-monitor
python ki_monitor.py daily --market KOSPI

# 1) 에이전트 분석 (회의 전, 수 분/종목)
cd ../trading-floor
echo '{ "ki": { "enabled": true } }' > config.json     # 원장 실측을 프롬프트에 넣는다
node server/export-brief.js --run --symbols SKHYNIX,SAMSUNG --mode algo

# 2) 회의 자료 생성
cd ../stock-monitor
python ki_monitor.py report --market KOSPI --with-agents
#   → out/KI_exit_YYYYMMDD.html  (측정값 §1~§4 + 에이전트 판정 §5)
```

어느 단계가 실패해도 앞 단계의 산출물은 살아 있다. 에이전트 분석이 없으면 리포트는
"에이전트 분석이 없습니다"라고 적고 나머지 절을 그대로 낸다.

---

## 7-b. `ki.factors/1` — 논문 팩터

`python ki_monitor.py factors <코드>... [--window 60] [--indent N]`

**원장의 일봉만** 쓴다. KIS·ECOS·FRED 를 부르지 않으므로 사내 방화벽 안에서도
나오고, 네트워크 호출이 0이다(`selftest` 가 소스에서 이를 강제한다).

```jsonc
{
  "ok": true, "schema": "ki.factors/1", "code": "000660", "window": 60,
  "factors": [
    { "key": "amihud", "name": "Amihud 비유동성", "unit": "×1e6",
      "value": 0.1234, "n": 60, "paper": "amihud2002",
      "citation": "Amihud, Y. (2002) ... doi:10.1016/S1386-4181(01)00024-6",
      "claim":  "논문이 주장한 것",
      "limits": "논문이 주장하지 않는 것 · 이 종목에 적용할 때의 유보",
      "reason": null }
  ],
  "papers": { "amihud2002": { "authors": "...", "doi": "..." } },
  "impact_model": { "assumption": "...", "paper": "athl2005", "citation": "...", "limits": "..." }
}
```

지켜야 할 것.

- **`value` 가 `null` 이면 `reason` 이 반드시 있다.** 없는 값을 만들지 않는다 —
  Roll 추정량은 자기공분산이 양수면 정의되지 않고, 고유변동성은 시장지수가 없으면
  총변동성으로 대신하지 않는다. 대신했다면 그 인용이 거짓이 된다.
- **`paper` 는 `stock-monitor/.papers.json` 에 실재해야 한다.** `selftest` 가 검사한다.
- **판정 어휘를 담지 않는다.** 매수·매도·저평가·목표가는 여기 없다 (`selftest` 검사).
- 논문은 **연도별로** 관리한다. 각 항목에 `year` 와 `question`(q1~q4)이 붙고,
  파일은 연도순이다 — 어느 연대가 비었는지 파일만 열어도 보이게.

  ```bash
  python docs/fetch_papers.py                     # 연도별 현황 (네트워크 불필요)
  python docs/fetch_papers.py --harvest 2013-2026 # 그 구간을 연도별로 훑어 후보에 쌓기
  python docs/fetch_papers.py --verify [--write]  # 채택본 발행정보 재대조 (Crossref)
  ```

  수확 결과는 `.papers_candidates.json`(gitignore)에 `adopted:false` 로 쌓이고
  **인용되지 않는다.** `papers()` 가 걸러내고 `selftest` 가 검사한다.

받는 쪽은 `ki-bridge.js` 의 `fetchKiFactors()` → `formatKiFactorLines()` 이고,
**퀀트 데스크(QUANT) 한 명에게만** 간다. QUANT 는 그것을 읽고 *다른 에이전트에게
어떻게 볼지 제안*하며, 그 제안은 DIANA·FLOW·RED·ACE·PM 다섯 자리에 "판정 아님"
라벨과 함께 붙는다.

---

## 8. 검증

```bash
cd stock-monitor  && python ki_monitor.py selftest    # 127개 (기존 64 + 통합 53)
cd trading-floor  && npm test                          # 200개 (기존 68 + 통합 125)
```

통합이 지키기로 한 것 중 **테스트가 실제로 강제하는 것**:

| 검사 | 어디 |
|---|---|
| 결측은 `null` 로 나간다 (0 으로 채우지 않는다) | `selftest` · `export-brief.test.mjs` |
| `units` 에 없는 컬럼은 내보내지 않는다 | `selftest` |
| `facts` 가 등급·점수·권고를 내보내지 않는다 | `selftest` |
| 원장 → JSON 왕복에 `NaN`·`Infinity` 가 없다 | `selftest` |
| 브리핑이 없거나 깨져도 리포트 생성을 막지 않는다 | `selftest` |
| **에이전트 출력을 HTML 이스케이프한다** | `selftest` |
| 강등된 판정은 강등 사실과 사유를 함께 싣는다 | `selftest` |
| 레벨이 없으면 지어내지 않는다 | `selftest` |
| 꺼져 있으면 파이썬을 스폰하지 않는다 | `ki-bridge.test.mjs` |
| 파이썬이 없어도·시간을 넘겨도 앱을 막지 않는다 | `ki-bridge.test.mjs` |
| `DEFAULTS.ki` 와 `DEFAULT_KI` 의 키가 같다 | `ki-bridge.test.mjs` |
| 원장이 묵으면 "현재가가 아니다" 경고가 붙는다 | `ki-bridge.test.mjs` |
| 실측 블록에 매수·매도·권고·목표주가가 없다 | `ki-bridge.test.mjs` |
| 사이드카가 조인 키(`krCode`)와 `kiAsOf` 를 담는다 | `export-brief.test.mjs` |
| 종목별 최신 판정만 모은다 | `export-brief.test.mjs` |
| 장부·성적표·자기 출력물을 런으로 오해하지 않는다 | `export-brief.test.mjs` |
| `--run` 없이는 분석을 실행하지 않는다 | `export-brief.test.mjs` |
| 일봉의 `t` 가 거래일 UTC 자정이다 (날짜가 밀리지 않는다) | `selftest` |
| OHLC 결측 봉을 자르기 전에 버린다 | `selftest` |
| 일봉 기본은 수정주가다 | `selftest` |
| facts 와 candles 가 캐시를 공유하지 않는다 | `ki-bridge.test.mjs` |
| 원장 시세 줄이 "실시간이 아니다"를 밝힌다 | `ki-bridge.test.mjs` |
| 캔들이 없으면 시세 줄을 만들지 않는다 | `ki-bridge.test.mjs` |
| KRX 6자리 코드가 한국 주식으로 해석된다 | `krstock.test.mjs` |
| KR_STOCKS 등재 종목은 무기한 선물 경로를 그대로 탄다 | `krstock.test.mjs` |
| 종목명은 원장이 채워 준 값을 우선하고, 없으면 null | `krstock.test.mjs` |
| ACE 가 실측을 직접 받는다 | `krstock.test.mjs` |
| **실행 시뮬레이션·매물대는 FLOW 만 본다** | `roster.test.mjs` |
| **자본구조는 FILING 만 본다** | `roster.test.mjs` |
| **가정·측정 한계는 RED 만 본다** | `roster.test.mjs` |
| 신규 3인의 지시문이 서로 다르다 (같은 일을 시키지 않는다) | `roster.test.mjs` |
| 원장이 없으면 신규 3인에게 실측 블록이 붙지 않는다 | `roster.test.mjs` |
| 기존 13인의 id·상대순서가 유지된다 | `agents.test.mjs` |

추가로 **에이전트 절을 끈 리포트가 통합 이전 원본 출력과 바이트 단위로 같은지**를
회귀 확인에 쓴다 (원본 `ki_monitor.py` 로 같은 원장을 렌더해 비교).

---

## 9. 넣지 않기로 한 것

- **실주문 연동.** 두 프로젝트 모두 원래 없고, 앞으로도 넣지 않는다.
- **원장(`ki.sqlite`)에 AI 판정 쓰기.** 리포트에는 싣고 원장에는 쓰지 않는다 (§3).
- **npm 패키지.** 브리지·내보내기 모두 Node 내장만 쓴다.
- **원장의 자동 갱신.** 브리지는 원장을 읽기만 한다. `ingest` 는 사람이 돌린다 —
  분석 요청이 KRX API 호출을 유발하면 할당량이 조용히 소진된다.
- **캔들 보간·합성.** 폴백은 원장에 있는 봉만 낸다. 빈 날을 메우거나 분봉을
  만들어 내지 않는다. 없으면 원래 오류를 올린다.
- **분석의 자동 실행.** `--run` 없이는 에이전트를 돌리지 않는다.
- **대외비 데이터의 저장소 반입.** `watchlist.csv`·`exit_plan.csv`·`positions.csv`·
  `ki.sqlite`·`.env`·`config.json` 은 `.gitignore` 에 있다. 저작권이 아니라
  영업비밀·미공개중요정보 문제다.

---

## 10. 면책

`trading-floor` 의 판정은 **AI 시뮬레이션**이며 투자 조언이 아니다. 실제 주문·거래·자금
이동은 발생하지 않는다.

`stock-monitor` 가 만드는 리포트는 **대외비 문서**이고 투자권유·투자자문 자료가 아니다.
에이전트 판정이 그 리포트에 실려도 성격은 바뀌지 않는다 — 회의에서 사람이 읽고
결정하기 위한 자료다.
