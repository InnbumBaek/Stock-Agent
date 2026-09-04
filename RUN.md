# 실행 안내 (RUN.md)

압축을 풀고 이 순서대로만 하면 됩니다. 자세한 내용은 `README.md`,
계약은 `docs/integration.md` 를 보십시오.

---

## 0. 전제

| | 필요한 것 |
|---|---|
| `stock-monitor` (Python) | Python 3.11+ · `pip install pandas numpy scipy requests lxml` |
| `trading-floor` (Node) | Node 20+ · **npm install 불필요** (의존성 0개) |
| 실전 에이전트 런 | `claude` CLI 가 PATH 에 있고 로그인돼 있을 것 |
| 원장 적재 | KRX Open API 키 · DART Open API 키 |

---

## 1. 먼저 돌려 볼 것 — 키·네트워크 없이 되는 검증

```bash
cd stock-monitor
python ki_monitor.py selftest        # 86개 통과해야 정상

cd ../trading-floor
npm test                             # 130개 통과해야 정상
```

둘 다 통과하면 코드는 정상입니다. 여기서 실패하면 아래로 진행하지 마십시오.

---

## 2. 키 설정

```bash
cd stock-monitor
cp .env.example .env
```

`.env` 를 열어 채웁니다.

```
KRX_API_KEY=...      # 한국거래소 — 서비스별 URL 사용신청도 별도로 필요합니다
DART_API_KEY=...     # 금융감독원
FRED_API_KEY=...     # 선택 (해외 매크로)
```

```bash
python ki_monitor.py check-auth      # 키가 읽히는지만 확인 (값은 출력 안 함)
```

> `.env` 는 `.gitignore` 에 있습니다. 절대 커밋하지 마십시오.

---

## 3. 감시 대상 지정

```bash
cp watchlist.sample.csv watchlist.csv
cp exit_plan.sample.csv exit_plan.csv
```

`watchlist.csv` 를 실제 포트폴리오사로 바꿉니다. 상장사는 `code` 에 6자리,
비상장사는 `code` 를 비우고 `name` 만 적습니다.

```csv
code,name,memo
000660,SK하이닉스,코스피
035720,카카오,코스피
,예시비상장회사,비상장
```

> 아래 예시의 종목은 **배선 확인용 공개 대형주**입니다. 실제 대상으로 바꿔 쓰십시오.

> 이 세 CSV 도 `.gitignore` 대상입니다. 포트폴리오사 실명은 영업비밀입니다.

---

## 4. 원장 적재 (최초 1회, 약 30분)

```bash
python ki_monitor.py ingest --from 20250101 --universe KOSDAQ
python ki_monitor.py fundamentals --market KOSDAQ
```

코스피 종목도 보려면 `--universe KOSPI` 로 한 번 더 돌립니다.

이후로는 하루 한 번 이것만 돌리면 됩니다.

```bash
python ki_monitor.py daily --market KOSDAQ
```

---

## 5. 리포트만 먼저 (에이전트 없이)

```bash
python ki_monitor.py report --market KOSDAQ
#   → out/KI_exit_YYYYMMDD.html
```

여기까지가 **통합 이전 원본과 완전히 같은 동작**입니다. 이 리포트가 제대로
나오는지 먼저 확인하십시오.

---

## 6. 에이전트 붙이기

### 6-1. 배선부터 확인 (claude 호출 없음, 무료)

```bash
cd ../trading-floor
```

`config.json` 을 만듭니다.

```json
{
  "ki": { "enabled": true },
  "watchlist": ["000660", "035720"]
}
```

```bash
node server/export-brief.js --run --demo --symbols 000660 --mode algo
```

`--demo` 는 고정 목업 응답으로 전체 배선만 돌립니다. 여기서
`판정 1건` 이 나오면 배선은 정상입니다.

### 6-2. 실전 런

```bash
node server/export-brief.js --run --symbols 000660,035720 --mode algo
```

**종목당 claude opus 를 최대 16번 호출합니다.** 수 분 걸립니다.

| 옵션 | 뜻 |
|---|---|
| `--run` | **이게 없으면 분석을 실행하지 않습니다.** 기본은 저장된 결과 수집만 |
| `--symbols A,B` | 없으면 `config.json` 의 `watchlist` |
| `--mode algo` | 회수 판단은 `algo` 를 쓰십시오 (`scalp`·`attack` 은 무기한 선물 전제) |
| `--demo` | claude 없이 목업 |
| `--max-age-hours 24` | 수집 시 하루 지난 분석은 제외 |

### 6-3. 회의 자료 생성

```bash
cd ../stock-monitor
python ki_monitor.py report --market KOSDAQ --with-agents
#   → out/KI_exit_YYYYMMDD.html   (§5 에 에이전트 판정이 실림)
```

한 번에:

```bash
python ki_monitor.py daily --market KOSDAQ --with-agents
```

---

## 7. 자본구조까지 보려면

`FILING` 에이전트가 볼 미상환 전환사채·최대주주 지분은 DART 조회가 필요합니다.

```bash
python ki_monitor.py facts --code 000660 --with-disclosures --indent 2
```

주지 않으면 FILING 이 *"자본구조 미조회 — 희석 규모를 모르는 상태"* 라고
정직하게 적습니다. 없는 것과 안 본 것은 다르기 때문입니다.

---

## 에이전트 16명

| 방 | 에이전트 |
|---|---|
| 애널리스트 | TARO(기술) · DIANA(기본) · **FLOW(유동성·체결)** · **FILING(공시·자본구조)** · NOVA(뉴스) · VIBE(센티먼트) |
| 리서치 | BULL ⇄ BEAR (4턴 토론) |
| 스캘핑 | BLITZ · GUARD (`scalp`·`attack` 모드에서만) |
| 리스크 위원회 | RISKY · SAFE · **RED(가정 반대심문)** · NEUTRAL |
| 트레이딩 | ACE(수석) · PM(승인) |

굵은 셋은 **원장 실측이 있어야 도는 역할**입니다. 코인·해외주식 런에서는
명단에서 자동으로 빠지므로 그쪽 비용은 늘지 않습니다.

- **FLOW** — 실행 시뮬레이션·매물대 전담. 방향이 아니라 "어떻게 팔면 얼마에 팔리는가"
- **FILING** — 희석·최대주주 물량 전담. 가격이 아니라 주식수와 물량
- **RED** — 가정 반대심문. 판정이 아니라 **판정의 토대**를 공격

---

## 문제가 생기면

| 증상 | 원인·조치 |
|---|---|
| `selftest` 실패 | 패키지 누락. `pip install pandas numpy scipy requests lxml` |
| `ingest` 가 401 | KRX 는 키 발급과 별개로 **서비스별 URL 사용신청**이 필요합니다 |
| 에이전트 절이 "분석이 없습니다" | `export-brief.js` 를 먼저 돌리십시오. 경로는 `--brief` 로 지정 가능 |
| `Yahoo chart HTTP 403` 인데 계속 진행됨 | 정상입니다. 원장의 KRX 공식 일봉으로 대체된 것이고 시세 줄에 그 사실이 표시됩니다 |
| FLOW 가 "실행 시뮬레이션 산출 실패" | 관측기간이 짧습니다(85영업일 이상 필요). `ingest --from` 을 앞당기십시오 |
| 리포트에 종목이 코드로 표시 | 원장에 그 종목 시세가 없습니다. `ingest --universe` 로 해당 시장을 적재하십시오 |

---

## 저장소에 넣지 마십시오

`.env` · `ki.sqlite` · `watchlist.csv` · `exit_plan.csv` · `positions.csv` ·
`config.json` · `out/` · `reports/` — 전부 `.gitignore` 에 있습니다.
저작권이 아니라 **자격증명·영업비밀** 문제입니다.

---

## 면책

`trading-floor` 의 판정은 **AI 시뮬레이션**이며 투자 조언이 아닙니다. 실제
주문·거래·자금 이동은 발생하지 않습니다. `stock-monitor` 가 만드는 리포트는
**대외비 문서**이며 투자권유·투자자문 자료가 아닙니다. 최종 판단과 책임은
이 문서를 읽는 사람에게 있습니다.
