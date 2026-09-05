"""저장소 최종 감사 — 넘기기 전에 조용히 깨질 수 있는 것을 전부 본다.

    python tools_audit.py

테스트가 잡지 못하는 종류의 실패를 본다.

  · 줄바꿈이 바뀌어 diff 가 통째로 뜨는 것
  · 배치 파일의 괄호가 안 맞아 스케줄러에서만 죽는 것
  · config.js 와 ki-bridge.js 의 키가 어긋나 설정이 조용히 무시되는 것
  · 옵트인 스위치가 켜진 채로 나가는 것
  · 자격증명·포트폴리오사 실명이 저장소에 새는 것
  · 문서의 테스트 개수가 실제와 어긋나는 것

원본(0f8b36e)에 이미 있던 내용은 유출 검사에서 제외한다 — 원본을 지우는 것은
그 자체가 회귀이기 때문이다.
"""
import io
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
fails = []
warns = []


def ok(label):
    print(f"  O  {label}")


def bad(label):
    fails.append(label)
    print(f"  X  {label}")


def warn(label):
    warns.append(label)
    print(f"  !  {label}")


print("[1] 줄바꿈 — 편집 도구가 바꾸면 diff 가 통째로 뜬다")
CRLF = ["stock-monitor/ki_monitor.py", "trading-floor/server/agents.js",
        "trading-floor/server/engine.js", "trading-floor/server/server.js"]
LF = ["trading-floor/server/market.js", "trading-floor/server/config.js",
      "trading-floor/server/ki-bridge.js", "trading-floor/server/scorecard.js",
      "trading-floor/server/export-brief.js"]
for p in CRLF:
    b = (ROOT / p).read_bytes()
    (ok if b.count(b"\r\n") > 100 else bad)(f"{p} = CRLF")
for p in LF:
    b = (ROOT / p).read_bytes()
    (ok if b.count(b"\r\n") == 0 else bad)(f"{p} = LF")

print("\n[2] 배치 파일 — 스케줄러가 부르면 조용히 실패한다")
for p in sorted(ROOT.glob("*.cmd")):
    b = p.read_bytes()
    if b.count(b"\r\n") == 0:
        bad(f"{p.name} 가 LF — 윈도우 배치는 CRLF 여야 한다")
        continue
    txt = b.decode("utf-8")
    depth = 0
    for ln in txt.split("\r\n"):
        t = ln.strip()
        if t.lower().startswith("rem") or t.startswith("::"):
            continue
        core = re.sub(r"\^[()]", "", ln)
        core = re.sub(r'"[^"]*"', '""', core)
        depth += core.count("(") - core.count(")")
    (ok if depth == 0 else bad)(f"{p.name} 괄호 균형 ({depth:+d})")

print("\n[3] 배치가 부르는 파일이 실재하는가")
for p in sorted(ROOT.glob("*.cmd")):
    txt = p.read_bytes().decode("utf-8")
    for m in re.finditer(r"%~dp0([0-9A-Za-z_\\.]+\.cmd)", txt):
        (ok if (ROOT / m.group(1)).exists() else bad)(f"{p.name} → {m.group(1)}")
    for sub_ in re.finditer(r"(?:pushd|cd /d \"%~dp0)([a-z-]+)", txt):
        d = sub_.group(1)
        if d in ("stock-monitor", "trading-floor"):
            (ok if (ROOT / d).is_dir() else bad)(f"{p.name} → {d}/")

print("\n[4] 설정 키 동기화 — 한쪽에만 생기면 조용히 무시된다")
r = subprocess.run(
    ["node", "-e",
     "const{DEFAULTS}=require('./server/config.js');const ki=require('./server/ki-bridge.js');"
     "const a=Object.keys(DEFAULTS.ki).sort(),b=Object.keys(ki.DEFAULT_KI).sort();"
     "process.stdout.write(JSON.stringify(a)===JSON.stringify(b)?'SYNC':'DIFF '+JSON.stringify([a,b]))"],
    cwd=ROOT / "trading-floor", capture_output=True, text=True)
(ok if r.stdout.strip() == "SYNC" else bad)(f"config.js ↔ ki-bridge.js  ({r.stdout.strip()[:80]})")

print("\n[5] 옵트인 — 켜기 전에는 통합 이전과 같아야 한다")
r = subprocess.run(
    ["node", "-e",
     "const ki=require('./server/ki-bridge.js');const d=ki.DEFAULT_KI;"
     "process.stdout.write(JSON.stringify({enabled:d.enabled,realtime:d.realtime,macro:d.macro}))"],
    cwd=ROOT / "trading-floor", capture_output=True, text=True)
d = json.loads(r.stdout)
for k, v in d.items():
    (ok if v is False else bad)(f"ki.{k} 기본값 = false (실제 {v})")

print("\n[6] 파이썬 서브커맨드가 전부 도는가 (키 없이)")
for args, want in [(["selftest"], "passed"), (["macro"], "ki.macro/1"),
                   (["quote", "--code", "000660"], "ki.quote/1"),
                   (["facts", "--code", "000660"], "ki.facts/1"),
                   (["candles", "--code", "000660"], "ki.candles/1"),
                   (["doctor"], "[1] 패키지"), (["check-auth"], "KIS 필드매핑"),
                   (["catalog"], ""), (["--help"], "quote")]:
    r = subprocess.run([sys.executable, "ki_monitor.py"] + args,
                       cwd=ROOT / "stock-monitor", capture_output=True, text=True, timeout=120)
    out = r.stdout + r.stderr
    crashed = "Traceback" in out
    if crashed:
        bad(f"{' '.join(args)} — 예외 발생")
    elif want and want not in out:
        bad(f"{' '.join(args)} — 기대 문자열 없음 ({want})")
    else:
        ok(f"{' '.join(args)}")

print("\n[7] 주문 API 차단 — KIS 는 같은 서버에 주문이 있다")
# selftest 는 통과 항목명을 출력하지 않는다(실패만 찍는다). 그래서 출력이 아니라
# 소스에 그 검사가 실재하는지를 본다.
src = (ROOT / "stock-monitor" / "ki_monitor.py").read_text(encoding="utf-8")
for need in ["주문 API 는 호출 불가", "화이트리스트 밖 이름도 호출 불가",
             "시세 화이트리스트는 두 개뿐", "실시간 스냅샷은 원장에 쓰지 않는다"]:
    (ok if f'check("{need}"' in src else bad)(f"selftest 검사 존재: {need}")

print("\n[8] 저장소에 비밀·대외비가 없는가")
env = ROOT / "stock-monitor" / ".env"
if env.exists():
    vals = [l.split("=", 1)[1].strip() for l in io.open(env, encoding="utf-8")
            if "=" in l and not l.startswith("#") and len(l.split("=", 1)[1].strip()) >= 12]
    if vals:
        r = subprocess.run(["git", "grep", "-l", "-z", "-F", "-f", "/dev/stdin"],
                           input="\n".join(vals), capture_output=True, text=True, cwd=ROOT)
        (ok if not r.stdout.strip() else bad)(f"API 키 유출 — {r.stdout.strip() or '없음'}")
    else:
        warn(".env 에 검사할 키가 없다")
else:
    warn(".env 가 없어 키 유출 검사를 건너뛴다")

# 검사할 이름을 여기 적지 않는다. 적는 순간 이 파일이 유출이 된다
# (감사기가 자기 자신을 잡는다). watchlist.csv 에서 읽는다 — 그 파일은
# .gitignore 대상이고, 없으면 이 검사를 건너뛴다.
NAMES = []
_wl = ROOT / "stock-monitor" / "watchlist.csv"
if _wl.exists():
    for _line in io.open(_wl, encoding="utf-8-sig"):
        _line = _line.strip()
        if not _line or _line.startswith("#") or _line.startswith("code,"):
            continue
        _parts = _line.split(",")
        if len(_parts) >= 2 and _parts[1].strip():
            NAMES.append(_parts[1].strip())
if not NAMES:
    warn("watchlist.csv 가 없어 실명 유출 검사를 건너뛴다")
# -z 로 받는다. 한글 경로를 git 이 8진수로 이스케이프해 git show 가 못 찾는다.
r = (subprocess.run(["git", "grep", "-l", "-z", "-F", "-f", "/dev/stdin"],
                    input="\n".join(NAMES), capture_output=True, text=True, cwd=ROOT)
     if NAMES else subprocess.CompletedProcess([], 0, "", ""))
hit = [h for h in r.stdout.split("\0") if h.strip()]
# 원본 커밋에 이미 있던 파일은 제외한다 — 통합 작업이 새로 넣은 것만 본다.
# (원본을 지우는 것은 그 자체가 회귀다. CLAUDE.md 3항)
BASE = "0f8b36e"
added = []
for h in hit:
    p = h.strip().strip('"')
    was = subprocess.run(["git", "show", f"{BASE}:{p}"],
                         capture_output=True, text=True, cwd=ROOT)
    if was.returncode != 0 or not any(n in was.stdout for n in NAMES):
        added.append(p)
(ok if not added else bad)(f"통합이 새로 넣은 실명 — {added or '없음'}")
if hit and not added:
    print(f"     (원본에 이미 있던 파일 {len(hit)}건은 제외)")

r = subprocess.run(["git", "ls-files"], capture_output=True, text=True, cwd=ROOT)
tracked = r.stdout.split()
FORBIDDEN = [".env", "ki.sqlite", "watchlist.csv", "exit_plan.csv", "positions.csv",
             "config.json", ".kis_token.json"]
leaked = [t for t in tracked
          if any(t.endswith(f) for f in FORBIDDEN) and not t.endswith(".example")
          and "sample" not in t]
(ok if not leaked else bad)(f"금지 파일 추적 — {leaked or '없음'}")

print("\n[9] 문서의 테스트 개수가 실제와 맞는가")
py = subprocess.run([sys.executable, "ki_monitor.py", "selftest"],
                    cwd=ROOT / "stock-monitor", capture_output=True, text=True)
n_py = int(re.search(r"(\d+) passed", py.stdout).group(1))
js = subprocess.run(["npm", "test"], cwd=ROOT / "trading-floor",
                    capture_output=True, text=True)
n_js = int(re.search(r"# pass (\d+)", js.stdout).group(1))
n_fail = int(re.search(r"# fail (\d+)", js.stdout).group(1))
print(f"     실제: selftest {n_py} · npm test {n_js} (실패 {n_fail})")
(ok if n_fail == 0 else bad)("npm test 실패 0")
for p in ["README.md", "RUN.md", "CLAUDE.md", "docs/integration.md",
          "stock-monitor/README.md", "trading-floor/CLAUDE.md"]:
    txt = (ROOT / p).read_text(encoding="utf-8")
    stale = []
    for m in re.finditer(r"(\d+)개", txt):
        v = int(m.group(1))
        if 60 <= v <= 400 and v not in (n_py, n_js):
            ctx = txt[max(0, m.start() - 40):m.end()]
            if "test" in ctx.lower() or "selftest" in ctx or "검증" in ctx:
                stale.append(v)
    (ok if not stale else bad)(f"{p} 테스트 개수 ({stale or '일치'})")

print("\n" + "=" * 60)
if fails:
    print(f"실패 {len(fails)}건")
    for f in fails:
        print(f"  · {f}")
    raise SystemExit(1)
print(f"전부 통과 ({len(warns)}건 경고)" if warns else "전부 통과")
