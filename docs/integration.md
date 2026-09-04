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
에이전트 13명이 그 사실을 보고 토론해 판정한다
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
 KRX·DART API                                       에이전트 13명
      ↓                                                   │
  ki.sqlite ──▶ facts (JSON) ──▶ ki-bridge.js ──▶ 프롬프트 │
   원장                                    DIANA·GUARD·SAFE·ACE
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
    "candleDays": 200          // 대체 시 가져올 일수
  }
}
```

`server/config.js` 의 `DEFAULTS.ki` 와 `ki-bridge.js` 의 `DEFAULT_KI` 는 **키가 같아야 한다** —
한쪽에만 키가 생기면 설정이 조용히 무시된다. 테스트가 검사한다.

### 4.5 어느 에이전트가 실측을 받는가

`ki.injectInto` 가 정한다. 기본값은 `["diana", "guard", "safe", "ace"]`.

| 에이전트 | 붙는 자리 | 왜 |
|---|---|---|
| **DIANA** (기본적 분석) | `[기본적 데이터]` 뒤, 지시문 **앞** | 지시문이 "위 기본적 데이터를 근거로"라고 말한다. 데이터가 먼저 와야 한다 |
| **GUARD·SAFE** (리스크) | 공통 푸터 | 처분 소요일수·유동성 집중도는 청산 위험과 다른 축의 리스크다 |
| **ACE** (수석 트레이더) | 애널리스트 리포트 바로 뒤 | 처분에 몇 영업일이 걸리는가는 목표가만큼이나 회수 판단을 좌우한다. 애널리스트를 거친 해석만 받으면 그 숫자가 중간에 사라질 수 있다 |
| TARO·NOVA·VIBE·BULL·BEAR·PM | — | 기본값에서는 붙지 않는다 |

ACE 는 `buildPrompt` 에서 조기 반환하므로 공통 푸터를 타지 않는다. 별도 주입 지점이
있고, 한 프롬프트에 두 번 들어가지 않도록 `kiUsed` 로 막는다.

### 4.6 KR_STOCKS 밖의 종목 — 포트폴리오사

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

**`--run` 없이는 절대 분석을 돌리지 않는다.** 실전 런은 에이전트 13명 × claude opus 라
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

## 8. 검증

```bash
cd stock-monitor  && python ki_monitor.py selftest    # 86개 (기존 64 + 통합 22)
cd trading-floor  && npm test                          # 117개 (기존 68 + 통합 49)
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
