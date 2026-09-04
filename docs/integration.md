# 주가 모니터링 ↔ PIXEL TRADING FLOOR — 통합 계약 (단일 진실 소스)

두 프로젝트는 한 저장소에 있지만 **합쳐지지 않았다.** 각자 원래대로 혼자 돌아가고,
사이에 얇은 계층 하나가 있을 뿐이다. 이 문서는 그 계층의 계약이다.

---

## 0. 왜 합치지 않았는가

두 프로젝트는 목적이 반대다.

| | 주가 모니터링 (`stock-monitor/`) | PIXEL TRADING FLOOR (`trading-floor/`) |
|---|---|---|
| 언어 | Python (pandas·numpy·scipy) | Node 20+ (내장 모듈만, npm 의존성 0) |
| 데이터 | KRX·DART **공식 API**, 인증키 필요 | 키 없는 공개 API (Binance·Yahoo·CoinGecko) |
| 시간축 | **일별 종가** 원장 (SQLite) | 실시간~15분봉, 24시간 무기한 선물 |
| 대상 | 상장 포트폴리오사 (KOSPI·KOSDAQ 전체) | 하이닉스·삼성전자·주요 코인 |
| 산출물 | 단일 HTML 리포트 | 픽셀 오피스 웹앱 + 마크다운 리포트 |
| **핵심 원칙** | **판단하지 않는다.** 등급·점수·권고를 내지 않는다 | **판정한다.** BUY/SELL/HOLD 를 낸다 |

마지막 줄이 결정적이다. 한쪽은 "판단은 사람이 합니다"가 설계 원칙이고, 다른 쪽은
판정을 내리는 것이 존재 이유다. 코드를 섞으면 둘 중 하나의 원칙이 깨진다.

그래서 **합치지 않고 잇는다.** 원장은 측정값만 내보내고, 데스크는 그것을 재료로
받아 판정한다. 판정의 책임은 데스크에 있고, 원장은 끝까지 판단하지 않는다.

---

## 1. 배치

```
Stock-Agent/
├─ stock-monitor/     주가 모니터링 — 원본 그대로
│   └─ ki_monitor.py  5,317줄 원본 + `facts` 명령 (파일 끝 '11. 통합 계층')
├─ trading-floor/     PIXEL TRADING FLOOR — 원본 그대로
│   └─ server/ki-bridge.js   통합 계층의 유일한 신규 모듈
└─ docs/integration.md       이 문서
```

각 하위 프로젝트는 **단독으로 떼어내도 그대로 돈다.** 각자의 `README.md`·`CLAUDE.md`·
`.gitignore`·테스트가 원본 그대로 남아 있다. 통합을 꺼도(기본값) 두 프로젝트의
동작은 통합 이전과 같다.

---

## 2. 데이터가 흐르는 방향 — 한 방향뿐이다

```
  [stock-monitor]                              [trading-floor]
  KRX Open API ─┐
  DART Open API ─┼─▶ ki.sqlite ─▶ facts (JSON) ─▶ ki-bridge.js ─┐
  FRED (선택) ──┘      원장         stdout          자식 프로세스 │
                                                                 ▼
                                                   market.ki ─▶ 프롬프트
                                                                 │
                                                                 ▼
                                                  DIANA · GUARD · SAFE
                                                                 │
                                                                 ▼
                                                    BULL⇄BEAR → ACE → PM
                                                        판정 (BUY/SELL/HOLD)
```

**역방향은 없다.** 데스크의 판정·포지션·성적표는 원장으로 돌아가지 않는다.
원장은 공식 API 로 측정한 사실만 담는 장부이고, AI 판정은 사실이 아니다.
그것을 섞으면 다음 리포트의 신뢰가 무너진다.

---

## 3. Python 쪽 계약 — `ki_monitor.py facts`

```bash
python ki_monitor.py facts --code 000660
python ki_monitor.py facts --codes 000660,005930 --indent 2
python ki_monitor.py facts                      # watchlist.csv 의 상장 종목 전부
python ki_monitor.py facts --code 000660 --with-disclosures   # DART 공시까지
```

- **stdout 은 JSON 만.** 진단 메시지는 전부 stderr 로 간다. 이게 깨지면 통합이 깨진다.
- **네트워크를 쓰지 않는다** (기본값). 원장에 있는 것만 낸다.
  `--with-disclosures` 를 줄 때만 DART 를 부른다.
- 종료코드: 정상 `0`, 실패 `1`. **실패해도 stdout 에는 JSON 이 나간다**
  (`{"ok": false, "reason": "..."}`). 받는 쪽이 이유를 알아야 하기 때문이다.
- 시장(`--market`)을 물어보지 않는다. 종목코드로 원장에 직접 물어 KOSPI/KOSDAQ 를 가른다.

### 스키마 `ki.facts/1`

```jsonc
{
  "ok": true,
  "schema": "ki.facts/1",
  "calc_version": "single-v1",
  "generated_at": "2026-09-04T10:21:00",
  "stage": "personal",

  "units":       { "days_3pct": "영업일 (시총 3% 처분, 평균 거래량 기준)", ... },
  "assumptions": ["처분 소요일수 — 거래량의 10%만 소화한다고 가정합니다. ...", ...],
  "notes":       ["이 데이터는 측정값입니다. 등급·점수·권고가 아닙니다.", ...],

  "markets": {
    "KOSPI": {
      "as_of": "2026-08-12",      // 원장의 마지막 영업일
      "stale_days": 23,           // 오늘로부터 며칠 지났는가
      "n_days": 243,              // 관측기간 — 분위(pctile)의 의미가 여기 달렸다
      "n_stocks": 1885,
      "benchmark": "코스피",       // 베타·트래킹에러의 잣대
      "regime": {                 // 시장 국면 — 수준이 아니라 분위로 본다
        "rate": { "label": "국고채 3년", "value": 3.799, "display": "3.799%",
                  "pctile": 0.91, "chg20": -0.084, "what": "국채전문유통시장 지표물 종가수익률" }
      },
      "fs_companies": 1799
    }
  },

  "stocks": {
    "000660": {
      "found": true,
      "code": "000660", "name": "SK하이닉스", "market": "KOSPI", "sector": null,
      "as_of": "2026-08-12", "stale_days": 23, "close": 1504000.0,
      "measures":     { "days_3pct": 37.27, "days_3pct_med": 42.17, "beta": null, ... },
      "observations": { "liq": [...], "px": [...], "cap": [...], "fin": [...], "events": [...] },
      "volume_profile": [{ "price": 1200000.0, "share": 0.08 }, ...]
    },
    "999999": { "found": false, "code": "999999", "reason": "원장에 이 종목의 시세가 없습니다" }
  },

  "missing": ["999999"]
}
```

### 이 스키마가 지키는 것

| 규칙 | 왜 |
|---|---|
| 모르면 `null`. 0 으로 채우지 않는다 | 받는 쪽이 '측정 못 함'과 '0으로 측정됨'을 구분해야 한다 |
| `units` 가 값과 함께 나간다 | 금융 데이터는 단위가 틀려도 계산이 돌아간다. 조용히 틀린다 |
| `assumptions` 가 값과 함께 나간다 | 처분 소요일수는 참여율 가정 위에 서 있다. 숫자만 넘기면 가정이 사라진다 |
| `stale_days` 가 항상 나간다 | 원장은 일별 종가다. 며칠 지난 값을 현재가로 읽으면 판정이 통째로 틀어진다 |
| `found:false` 를 명시한다 | 없는 종목을 조용히 빼면 받는 쪽이 "조회했는데 값이 없다"와 구분 못 한다 |
| 등급·점수·권고 키가 없다 | 원장은 판단하지 않는다. `selftest` 가 이 금칙을 검사한다 |

`measures` 는 `units` 에 등재된 키만 나간다. 중간 계산 컬럼이 새어 나가면 받는 쪽이
뜻 모르는 숫자를 근거로 쓴다.

---

## 4. Node 쪽 계약 — `server/ki-bridge.js`

```js
module.exports = { DEFAULT_KI, DEFAULT_SCRIPT, isEnabled, kiConfig, krCodeOf,
                   fetchKiFacts, formatKiLines, clearCache, _setSpawn }
```

| 함수 | 시그니처 | 설명 |
|---|---|---|
| `isEnabled(cfg?)` | `=> boolean` | `ki.enabled`. 꺼져 있으면 이 모듈은 아무것도 하지 않는다 |
| `kiConfig(cfg?)` | `=> object` | DEFAULTS 와 병합된 `ki` 설정 사본 |
| `krCodeOf(x)` | `=> '000660'\|null` | `'000660'` · `'000660.KS'` → 코드. 그 외 `null` |
| `fetchKiFacts(code, {cfg}?)` | `=> Promise<facts\|null>` | 파이썬 스폰 → JSON. **절대 reject 하지 않는다** |
| `formatKiLines(facts, code, {staleWarnDays}?)` | `=> string[]` | 프롬프트에 넣을 한국어 줄. 붙일 게 없으면 `[]` |
| `clearCache()` | `=> void` | 캐시 비우기 |
| `_setSpawn(fn)` | `=> void` | 테스트 주입구 |

### 지키는 규칙

- **외부 npm 의존성 0.** `node:child_process` · `node:fs` · `node:path` 만 쓴다.
  파이썬을 자식 프로세스로 부르는 것은 의존성 추가가 아니다 — 사용자가 끄면(기본값)
  이 모듈은 아무것도 하지 않고, 파이썬이 없어도 앱은 그대로 돈다.
- **절대 throw 하지 않는다.** 분석 파이프라인·감시 루프를 이 모듈이 막으면 안 된다.
  실패는 `console.error` 한 줄 + `null` 반환.
- **성공도 실패도 캐시한다** (기본 30분 / 실패 1분). 분석 한 번에 여러 에이전트가
  같은 값을 본다. 캐시가 없으면 파이썬을 그만큼 스폰한다.
- **`python3` → `python` 순서로 찾는다.** `ki.python` 을 지정하면 그것을 먼저 쓴다.
- **판단을 실어 나르지 않는다.** 받은 측정값을 측정값인 채로 옮긴다.
  `formatKiLines` 의 마지막 줄이 이것을 명시한다:
  *"위 값은 공식 API 로 측정한 사실이다. 등급·점수·권고가 아니다."*

### 설정 (`config.json` 의 `ki` 블록)

```jsonc
{
  "ki": {
    "enabled": false,          // 기본 꺼짐 — 켜기 전까지 통합 이전과 동작이 같다
    "python": "",              // 비우면 python3 → python
    "script": "",              // 비우면 <저장소>/stock-monitor/ki_monitor.py
    "timeoutSec": 30,
    "cacheMin": 30,
    "withDisclosures": false,  // 켜면 DART 공시까지 (네트워크·DART 키 필요)
    "staleWarnDays": 5,        // 원장이 이만큼 묵으면 프롬프트에 경고를 붙인다
    "injectInto": ["diana", "guard", "safe"]
  }
}
```

`config.json` 은 git 이 추적하지 않는다 (`.gitignore`).
`server/config.js` 의 `DEFAULTS.ki` 와 `ki-bridge.js` 의 `DEFAULT_KI` 는 **키가 같아야 한다** —
한쪽에만 키가 생기면 설정이 조용히 무시된다. 테스트가 이것을 검사한다.

---

## 5. 기존 모듈에 붙은 것 — 전부 더하기만 했다

| 파일 | 변경 | 내용 |
|---|---|---|
| `server/config.js` | +12 | `DEFAULTS.ki` 블록 |
| `server/market.js` | +13/−3 | `krstock` 경로의 `Promise.allSettled` 에 원장 조회 한 줄. 반환에 `krCode`·`ki` |
| `server/agents.js` | +40 | `kiLines()` 헬퍼 + DIANA 프롬프트·공통 푸터 주입 지점 |
| `server/server.js` | +68 | `GET /api/ki` 라우트 하나 |

기존 SSE 이벤트·모드·리포트 형식은 **하나도 바뀌지 않았다.**

### `market.ki`

`kind === 'krstock'` 이고 `ki.enabled` 일 때만 존재한다. 그 외에는 키 자체가 없다.
`market.krCode` 가 함께 실려 프롬프트 빌더가 어느 종목의 실측인지 알 수 있다.

원장 조회는 네트워크가 아니라 로컬 파이썬 스폰이므로 기존 `allSettled` 배열에 넣었다.
실패해도 나머지 수집은 그대로 진행된다 (기존 best-effort 정책과 같다).

### 프롬프트 주입

`ki.injectInto` 에 있는 에이전트에게만 붙는다 (기본 `diana`·`guard`·`safe`).

- **DIANA(기본적 분석)** — `[기본적 데이터]` 바로 뒤, 지시문 **앞**에 붙는다.
  지시문이 "위 기본적 데이터를 근거로"라고 말하므로 데이터가 먼저 와야 한다.
- **GUARD·SAFE(리스크)** — 공통 푸터에 붙는다. 처분 소요일수·유동성 집중도는
  청산 위험과 다른 축의 리스크이고, 그 둘이 보는 것이 그것이다.
- **TARO·NOVA·VIBE·BULL·BEAR·ACE·PM** — 기본값에서는 붙지 않는다.
  ACE 는 애널리스트 리포트를 통해 간접적으로 받는다.

### `GET /api/ki?symbol=…`

| 상황 | 응답 |
|---|---|
| 모듈 없음 | `503 {error}` |
| `ki.enabled=false` | `200 {enabled:false, note}` — 파이썬을 스폰하지 않는다 |
| `symbol` 없음 | `400 {error}` |
| 한국 상장 종목 아님 | `200 {enabled:true, found:false, note, supported}` |
| 조회 실패 | `200 {enabled:true, found:false, code, note}` |
| 정상 | `200 {enabled:true, found:true, code, lines, facts}` |

`symbol` 은 `SKHYNIX` 같은 별칭도, `000660` 코드도 받는다.

---

## 6. 켜는 법

```bash
# 1) 원장을 만든다 (stock-monitor)
cd stock-monitor
cp .env.example .env          # KRX_API_KEY · DART_API_KEY 를 채운다
python ki_monitor.py check-auth
python ki_monitor.py ingest --from 20250101 --universe KOSPI
python ki_monitor.py fundamentals --market KOSPI
python ki_monitor.py facts --code 000660 --indent 2    # 여기까지 되면 원장은 준비됨

# 2) 데스크에서 켠다 (trading-floor)
cd ../trading-floor
cat > config.json <<'JSON'
{ "ki": { "enabled": true } }
JSON
node server/server.js
curl "http://localhost:8000/api/ki?symbol=SKHYNIX"
```

원장이 없거나 파이썬이 없어도 데스크는 그대로 돈다. 실측만 빠진다.

---

## 7. 검증

```bash
cd stock-monitor && python ki_monitor.py selftest    # 71개 (기존 64 + facts 7)
cd trading-floor && npm test                          # 89개 (기존 68 + 브리지 21)
```

통합이 지키기로 한 것 중 **테스트가 실제로 강제하는 것**:

| 검사 | 어디 |
|---|---|
| 결측은 `null` 로 나간다 (0 으로 채우지 않는다) | `selftest` |
| `units` 에 없는 컬럼은 내보내지 않는다 | `selftest` |
| 내보내는 키에 등급·점수·권고가 없다 | `selftest` |
| 원장 → JSON 왕복에 `NaN`·`Infinity` 가 없다 | `selftest` |
| 꺼져 있으면 파이썬을 스폰하지 않는다 | `ki-bridge.test.mjs` |
| 파이썬이 없어도·시간을 넘겨도 앱을 막지 않는다 | `ki-bridge.test.mjs` |
| `DEFAULTS.ki` 와 `DEFAULT_KI` 의 키가 같다 | `ki-bridge.test.mjs` |
| 원장이 묵으면 "현재가가 아니다" 경고가 붙는다 | `ki-bridge.test.mjs` |
| 실측 블록에 매수·매도·권고·목표주가가 없다 | `ki-bridge.test.mjs` |
| 요청한 코드와 다른 종목의 값을 섞지 않는다 | `ki-bridge.test.mjs` |
| 값이 없으면 줄 자체를 만들지 않는다 | `ki-bridge.test.mjs` |

---

## 8. 넣지 않기로 한 것

- **실주문 연동.** 두 프로젝트 모두 원래 없고, 앞으로도 넣지 않는다.
- **역방향 기록.** AI 판정을 원장에 쓰지 않는다 (§2).
- **npm 패키지.** 브리지는 Node 내장만 쓴다.
- **원장의 자동 갱신.** 브리지는 원장을 읽기만 한다. `ingest` 는 사람이 돌린다.
  분석 요청이 KRX API 호출을 유발하면 할당량이 조용히 소진된다.
- **대외비 데이터의 저장소 반입.** `watchlist.csv`·`exit_plan.csv`·`positions.csv`·
  `ki.sqlite`·`.env` 는 `.gitignore` 에 있다. 이건 저작권이 아니라 영업비밀·
  미공개중요정보 문제다.

---

## 9. 면책

`trading-floor` 는 **AI 시뮬레이션**이며 투자 조언이 아니다. 실제 주문·거래·자금
이동은 발생하지 않는다.

`stock-monitor` 가 만드는 리포트는 **대외비 문서**이고 투자권유·투자자문 자료가
아니다. 원장 실측값이 데스크 프롬프트로 흘러가도 그 성격은 바뀌지 않는다.
