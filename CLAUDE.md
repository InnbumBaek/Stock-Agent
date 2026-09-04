# Stock-Agent — Claude Code 안내 (저장소 루트)

주식 관련 두 프로젝트를 담은 저장소다. **합쳐진 것이 아니라 이어 붙인 것이다.**

```
stock-monitor/    주가 모니터링 (Python) — 사실을 재고, 회의 자료(HTML 리포트)를 만든다
trading-floor/    PIXEL TRADING FLOOR (Node) — 그 사실을 보고 에이전트가 분석·판정한다
docs/integration.md   두 프로젝트를 잇는 계층의 계약 (단일 진실 소스)
```

**만들려는 것** — 에이전트가 분석·판단하고, 그 결과를 회수 판단 리포트에 실어
오프라인 회의에 올린다. 최종 의사결정은 회의에서 사람이 한다.

**작업 전에 해당 하위 프로젝트의 안내를 먼저 읽어라.**
`trading-floor/CLAUDE.md` 가 그 프로젝트의 규칙이고, `stock-monitor/README.md` 의
"설계 원칙"이 그쪽 규칙이다. 이 문서는 **두 프로젝트에 걸치는 일**에만 적용된다.

---

## 절대 깨지 말아야 할 것

### 1. 재는 쪽과 판단하는 쪽을 섞지 마라

| | stock-monitor | trading-floor |
|---|---|---|
| 역할 | **사실을 잰다** — 측정값·가정·한계 | **판단한다** — 분석·토론·판정 |

`ki_monitor.py` 의 계산 코드에 점수·등급·시그널을 넣지 마라. 그건 데스크의 일이다.
반대로 데스크가 측정값을 스스로 다시 계산하게 하지 마라. 그건 원장의 일이다.

리포트에서도 둘은 **절이 다르다.** §1~§4 는 공식 API 로 잰 값, §5 는 언어모델의 의견이다.
같은 표에 섞으면 회의에서 그 구분이 사라지고, 근거 없는 결론이 근거 있는 숫자처럼
읽힌다. `selftest` 가 `facts` 출력에 판정 어휘가 없는지 검사한다.

### 2. 원장(`ki.sqlite`)에는 절대 쓰지 마라

데이터는 두 방향으로 흐르지만, 되돌아오는 것은 **리포트**이지 **원장**이 아니다.

```
stock-monitor ──▶ trading-floor    원장의 측정값 → 에이전트 프롬프트     ✔
trading-floor ──▶ stock-monitor    에이전트 판정 → HTML 리포트의 §5     ✔
trading-floor ──▶ ki.sqlite        AI 판정을 원장에 기록                 ✘ 하지 마라
```

`ki.sqlite` 는 공식 API 로 측정한 사실만 담는 장부다. AI 판정·가상 포지션·성적표를
여기에 쓰면 다음번 측정이 오염되고, 그 오염은 되돌릴 수 없다.

### 3. 원본에서 크게 벗어나지 않는다

두 프로젝트는 각각 단독으로 떼어내도 돌아가야 한다. 통합 때문에 원본 구조를
재배치하거나, 공통 모듈로 추출하거나, 언어를 통일하지 마라.

기존 파일을 고칠 때는 **더하기만 한다.** 삭제·재작성은 그 자체가 회귀다.

### 4. 통합 기능은 전부 옵트인이다

- `config.json` 의 `ki.enabled` 가 `false` 면 `trading-floor` 는 통합 이전과 똑같이 동작한다.
- `--with-agents` 없이 만든 리포트는 통합 이전 원본 코드의 출력과 **바이트 단위로 같다.**
- `--run` 없이는 에이전트를 절대 돌리지 않는다. 실전 런은 13명 × claude opus 다.
- 원장 일봉 폴백은 **야후가 실패했을 때만** 켜진다. 그것도 없으면 원래 오류를
  그대로 올린다 — 없는 값을 만들지 않는다.

하나라도 깨지면 통합이 원본을 침범한 것이다. 회귀 확인은 §검증 참조.

### 5. 에이전트 출력은 신뢰할 수 없는 입력이다

에이전트 리포트는 언어모델이 만든 문자열이고, 그것이 HTML 리포트에 들어간다.
반드시 `_esc()` 로 이스케이프해라. `selftest` 가 `<script>` 주입을 검사한다.

### 6. 대외비·자격증명을 저장소에 넣지 마라

`.env` · `ki.sqlite` · `watchlist.csv` · `exit_plan.csv` · `positions.csv` ·
`config.json` · `reports/` 는 `.gitignore` 에 있다. 저작권이 아니라 **영업비밀·
미공개중요정보** 문제다. 커밋 전에 확인해라.

### 7. 줄바꿈을 바꾸지 마라

`ki_monitor.py` · `agents.js` · `server.js` · `engine.js` 는 **CRLF** 파일이고,
`market.js` · `config.js` · 신규 파일은 LF 다. 편집 도구가 이걸 바꾸면 파일 전체가
diff 에 잡혀 실제 변경이 묻힌다. 편집 후 `file <파일>` 로 확인해라.

---

## 검증

두 쪽 다 통과해야 통합이 성립한다.

```bash
cd stock-monitor && python ki_monitor.py selftest   # 86개 (키·네트워크 불필요)
cd trading-floor && npm test                         # 117개
```

통합 계층을 건드렸다면 **회귀 확인**까지 해라 — 에이전트 절을 끈 리포트가 통합 이전
원본 코드의 출력과 같아야 한다.

```bash
# 원본 ki_monitor.py 를 임시 디렉터리에 두고 같은 원장으로 렌더한 뒤
# 생성 시각만 정규화해 현재 코드의 출력과 비교한다 (바이트 단위로 같아야 한다)
```

종단 확인:

```bash
cd stock-monitor && python ki_monitor.py facts --code 000660 --indent 2
cd ../trading-floor && node server/export-brief.js --run --demo --symbols SKHYNIX
cd ../stock-monitor && python ki_monitor.py report --with-agents
```

---

## 통합 계층을 고칠 때

`docs/integration.md` 가 단일 진실 소스다. 시그니처·JSON 스키마·라우트·CLI 를 바꾸면
그 문서를 **같은 커밋에서** 고쳐라.

특히 이 셋은 깨지면 통합 전체가 조용히 죽는다.

- `ki_monitor.py facts` 의 **stdout 은 JSON 만.** 사람용 메시지는 전부 stderr 로.
  (반대로 `export-brief.js` 는 stdout 이 사람용이고 결과는 파일이다. 방향이 다르다.)
- `server/config.js` 의 `DEFAULTS.ki` 와 `ki-bridge.js` 의 `DEFAULT_KI` 는 **키가 같아야**
  한다. 한쪽에만 키가 생기면 설정이 조용히 무시된다.
- 엔진의 사이드카(`floor.run/1`)는 마크다운과 **같은 재료만** 쓴다. 여기서 새로 계산하거나
  요약하면 리포트와 리포트가 어긋난다.
