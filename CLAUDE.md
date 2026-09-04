# Stock-Agent — Claude Code 안내 (저장소 루트)

주식 관련 두 프로젝트를 담은 저장소다. **합쳐진 것이 아니라 이어 붙인 것이다.**

```
stock-monitor/    주가 모니터링 (Python) — 회수 판단 리포트
trading-floor/    PIXEL TRADING FLOOR (Node) — AI 에이전트 매매 판정 데스크
docs/integration.md   두 프로젝트를 잇는 계층의 계약 (단일 진실 소스)
```

**작업 전에 해당 하위 프로젝트의 안내를 먼저 읽어라.**
`trading-floor/CLAUDE.md` 가 그 프로젝트의 규칙이고, `stock-monitor/README.md` 의
"설계 원칙"이 그쪽 규칙이다. 이 문서는 **두 프로젝트에 걸치는 일**에만 적용된다.

---

## 절대 깨지 말아야 할 것

### 1. 두 프로젝트의 원칙이 정반대다 — 섞지 마라

| | stock-monitor | trading-floor |
|---|---|---|
| 핵심 원칙 | **판단하지 않는다.** 등급·점수·권고를 내지 않는다 | **판정한다.** BUY/SELL/HOLD 를 낸다 |

원장은 측정값만 내보내고, 데스크가 그것을 재료로 판정한다. 판정의 책임은 데스크에
있고 원장은 끝까지 판단하지 않는다. `ki_monitor.py` 에 점수·등급·시그널을 넣지 마라 —
`selftest` 가 이 금칙을 검사한다.

### 2. 데이터는 한 방향으로만 흐른다

```
stock-monitor ──▶ trading-floor        (원장의 측정값 → 에이전트 프롬프트)
stock-monitor ◀── trading-floor        ✗ 없다. 만들지 마라
```

AI 판정·가상 포지션·성적표를 `ki.sqlite` 에 쓰지 마라. 그 원장은 공식 API 로 측정한
사실만 담는 장부다. AI 판정은 사실이 아니다.

### 3. 원본에서 크게 벗어나지 않는다

두 프로젝트는 각각 단독으로 떼어내도 돌아가야 한다. 통합 때문에 원본 구조를
재배치하거나, 공통 모듈로 추출하거나, 언어를 통일하지 마라. 통합 계층은
`stock-monitor` 의 `facts` 명령과 `trading-floor/server/ki-bridge.js` **둘뿐**이고,
그 상태를 유지한다.

기존 파일을 고칠 때는 **더하기만 한다.** 삭제·재작성은 그 자체가 회귀다.
지금까지의 실적: `ki_monitor.py` 5,317줄에 대해 삭제·수정 0줄.

### 4. 통합은 기본이 꺼짐이다

`config.json` 의 `ki.enabled` 가 `false` 인 상태에서 `trading-floor` 는 통합 이전과
똑같이 동작해야 한다. 파이썬이 없어도, 원장이 없어도, 원장이 깨져 있어도 데스크는
돌아야 한다 — 실측만 빠진다.

### 5. 대외비·자격증명을 저장소에 넣지 마라

`.env` · `ki.sqlite` · `watchlist.csv` · `exit_plan.csv` · `positions.csv` ·
`config.json` 은 `.gitignore` 에 있다. 저작권이 아니라 **영업비밀·미공개중요정보**
문제다. 커밋 전에 확인해라.

### 6. 줄바꿈을 바꾸지 마라

`ki_monitor.py` · `agents.js` · `server.js` · `engine.js` 는 **CRLF** 파일이고,
`market.js` · `config.js` 는 LF 다. 편집 도구가 이걸 바꾸면 파일 전체가 diff 에
잡혀 실제 변경이 묻힌다. 편집 후 `file <파일>` 로 확인해라.

---

## 검증

두 쪽 다 통과해야 통합이 성립한다.

```bash
cd stock-monitor && python ki_monitor.py selftest   # 71개 (키·네트워크 불필요)
cd trading-floor && npm test                         # 89개
```

통합 계층을 건드렸다면 실제 원장으로 종단 확인까지 해라.

```bash
cd stock-monitor && python ki_monitor.py facts --code 000660 --indent 2
cd ../trading-floor && node server/server.js &
curl "http://localhost:8000/api/ki?symbol=SKHYNIX"
```

---

## 통합 계층을 고칠 때

`docs/integration.md` 가 단일 진실 소스다. 시그니처·JSON 스키마·라우트를 바꾸면
그 문서를 **같은 커밋에서** 고쳐라.

특히 이 두 가지는 깨지면 통합 전체가 조용히 죽는다.

- `ki_monitor.py facts` 의 **stdout 은 JSON 만.** 사람용 메시지는 전부 stderr 로.
- `server/config.js` 의 `DEFAULTS.ki` 와 `ki-bridge.js` 의 `DEFAULT_KI` 는 **키가 같아야**
  한다. 한쪽에만 키가 생기면 설정이 조용히 무시된다.
