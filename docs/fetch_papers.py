"""논문을 **연도별로 훑어** 온다. 그리고 채택본의 발행 정보를 다시 대조한다.

왜 연도별인가 — 손으로 고른 목록은 고른 날짜에서 멈춘다. 지금 채택본의 최신은
2012년이다. 그대로 두면 이 데스크는 십 년 전 문헌만 아는 데스크가 된다.

그렇다고 검색 결과를 그대로 쓰지도 않는다. 이 저장소의 규율(CLAUDE.md 5항)은
**등급을 먼저 정하고 재료를 붙이라**는 것이다. 그래서 두 칸으로 나눈다.

    .papers.json             채택본. 팩터가 인용할 수 있다.
    .papers_candidates.json  후보. 연도별로 쌓이기만 하고 **인용되지 않는다.**

후보에서 채택본으로 올리는 기준은 하나다 — **이 데스크가 묻는 네 질문 중 하나를
바꾸는가.** 얼마나 왔는가 / 팔 수 있는가 / 어떻게 팔 것인가 / 지금이 그 때인가.
"퀀트 논문이니까"는 이유가 아니다. 여기는 진입 신호를 찾는 데스크가 아니라
이미 보유한 것을 파는 시점을 정하는 데스크다.

    python docs/fetch_papers.py                       # 연도별 현황 (네트워크 불필요)
    python docs/fetch_papers.py --verify              # 채택본 재대조 (Crossref)
    python docs/fetch_papers.py --harvest 2013-2026   # 그 구간을 연도별로 훑기
    python docs/fetch_papers.py --harvest 2024-2026 --max-per-year 30

수확은 Crossref 공개 API 만 쓴다. 저널 화이트리스트 밖은 버린다 — 아무 곳에나
실린 글을 근거 등급으로 올리면 이 규율 전체가 무의미해진다.
"""
import argparse
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "stock-monitor"
ADOPTED = ROOT / ".papers.json"
CANDIDATES = ROOT / ".papers_candidates.json"
API = "https://api.crossref.org/works"
UA = {"User-Agent": "ki-monitor-paper-harvest (contact via repository owner)"}

# 근거 등급으로 올릴 수 있는 게재지. 여기 없으면 후보에도 넣지 않는다.
JOURNALS = (
    "journal of finance",
    "journal of financial economics",
    "review of financial studies",
    "journal of financial markets",
    "journal of financial and quantitative analysis",
    "review of finance",
    "management science",
    "journal of banking & finance",
    "journal of banking and finance",
    "journal of empirical finance",
    "quantitative finance",
    "journal of portfolio management",
    "financial analysts journal",
    "pacific-basin finance journal",      # 한국 시장 연구가 자주 실린다
    "journal of financial econometrics",
    "journal of risk",
    "review of asset pricing studies",
)

# 이 데스크가 묻는 네 질문 → 그 질문을 건드리는 검색어.
# 검색어를 넓히면 후보가 폭증하고, 폭증한 후보는 아무도 안 읽는다.
TERMS = {
    "q1": ["momentum returns stocks", "short-term reversal stock returns",
           "52-week high momentum"],
    "q2": ["stock illiquidity measure", "bid-ask spread estimator daily data",
           "market liquidity commonality stocks", "IPO lockup expiration"],
    "q3": ["optimal execution market impact", "implementation shortfall trading cost",
           "price impact of large trades"],
    "q4": ["idiosyncratic volatility cross-section", "market states momentum crashes",
           "long-run performance initial public offerings"],
}


def load(path: Path, default: dict) -> dict:
    try:
        return json.loads(io.open(path, encoding="utf-8").read())
    except (OSError, ValueError):
        return dict(default)


def save(path: Path, doc: dict) -> None:
    io.open(path, "w", encoding="utf-8").write(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n")


def get(url: str) -> dict | None:
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read())
    except (urllib.error.URLError, OSError, ValueError):
        return None


def norm(s) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def journal_ok(name: str) -> bool:
    n = str(name or "").lower()
    return any(j in n for j in JOURNALS)


def authors_of(item: dict) -> str:
    names = []
    for a in (item.get("author") or [])[:4]:
        fam, given = a.get("family"), a.get("given")
        if fam:
            names.append(f"{fam}, {given[0]}." if given else fam)
    return " and ".join(names) if names else "(저자 미상)"


# ── 연도별 현황 ───────────────────────────────────────────────────────

def coverage() -> int:
    a = load(ADOPTED, {"papers": {}})
    c = load(CANDIDATES, {"by_year": {}})
    ad = Counter(p["year"] for p in a.get("papers", {}).values())
    cd = Counter({int(y): len(v) for y, v in (c.get("by_year") or {}).items()})
    years = sorted(set(ad) | set(cd))
    if not years:
        print("아직 아무것도 없습니다.")
        return 0
    print("연도   채택  후보")
    print("-" * 24)
    for y in range(min(years), max(years) + 1):
        if not (ad[y] or cd[y]):
            continue
        print(f"{y}   {ad[y]:>3}   {cd[y]:>3}")
    print("-" * 24)
    print(f"합계   {sum(ad.values()):>3}   {sum(cd.values()):>3}")
    newest = max(ad) if ad else None
    if newest:
        print(f"\n채택본 최신: {newest}년")
        gap = 2026 - newest
        if gap >= 5:
            print(f"  {gap}년째 갱신이 없습니다 — --harvest {newest + 1}-2026 을 돌려 보십시오.")
    q = Counter(p.get("question", "?") for p in a.get("papers", {}).values())
    print("\n질문별 채택")
    for k, label in (a.get("questions") or {}).items():
        print(f"  {k}  {q[k]:>2}편   {label}")
    return 0


# ── 채택본 재대조 ─────────────────────────────────────────────────────

def verify(write: bool) -> int:
    doc = load(ADOPTED, {"papers": {}})
    bad, skipped, ok = [], [], 0
    for key, p in sorted(doc["papers"].items(), key=lambda kv: kv[1]["year"]):
        if not p.get("doi"):
            skipped.append(f"{key} ({p['year']}) — DOI 없음 · 여기서 확인 불가")
            continue
        m = (get(f"{API}/{urllib.parse.quote(p['doi'])}") or {}).get("message")
        if not m:
            bad.append(f"{key} ({p['year']}) — Crossref 조회 실패")
            continue
        diffs = []
        title = (m.get("title") or [""])[0]
        if norm(title)[:40] != norm(p["title"])[:40]:
            diffs.append(f"제목 '{title}'")
        journal = (m.get("container-title") or [""])[0]
        if norm(journal) not in norm(p["journal"]) and norm(p["journal"]) not in norm(journal):
            diffs.append(f"저널 '{journal}'")
        year = ((m.get("issued") or {}).get("date-parts") or [[None]])[0][0]
        if year and int(year) != int(p["year"]):
            diffs.append(f"연도 {year}")
        pages = m.get("page")
        if pages and norm(pages) != norm(p["pages"]):
            diffs.append(f"쪽수 {pages}")
        if diffs:
            bad.append(f"{key} ({p['year']}) — {' · '.join(diffs)}")
            if write:
                p["title"], p["journal"] = title or p["title"], journal or p["journal"]
                if year:
                    p["year"] = int(year)
                if pages:
                    p["pages"] = pages
        else:
            ok += 1
            print(f"  O  {p['year']}  {key:<12} {p['authors']}")
        time.sleep(0.2)
    for s in skipped:
        print(f"  -  {s}")
    for b in bad:
        print(f"  X  {b}")
    print(f"\n일치 {ok} · 불일치 {len(bad)} · 확인 불가 {len(skipped)}")
    if write and bad:
        doc["papers"] = dict(sorted(doc["papers"].items(),
                                    key=lambda kv: (kv[1]["year"], kv[0])))
        save(ADOPTED, doc)
        print(f"갱신했습니다: {ADOPTED.name}")
    return 1 if (bad and not write) else 0


# ── 연도별 수확 ───────────────────────────────────────────────────────

def harvest(y0: int, y1: int, cap: int) -> int:
    adopted = load(ADOPTED, {"papers": {}})
    have = {norm(p.get("doi")) for p in adopted["papers"].values() if p.get("doi")}
    doc = load(CANDIDATES, {
        "schema": "ki.papers.candidates/1",
        "note": ("연도별로 훑어 온 후보입니다. **인용되지 않습니다.** "
                 "네 질문 중 하나를 바꿀 때만 .papers.json 으로 옮기십시오."),
        "by_year": {},
    })
    for y in doc["by_year"].values():
        have |= {norm(x.get("doi")) for x in y}

    total = 0
    for year in range(y0, y1 + 1):
        found, seen_this_year = [], set()
        for q, terms in TERMS.items():
            for term in terms:
                url = (f"{API}?" + urllib.parse.urlencode({
                    "query.bibliographic": term,
                    "filter": (f"from-pub-date:{year}-01-01,"
                               f"until-pub-date:{year}-12-31,type:journal-article"),
                    "rows": 40,
                    "select": "DOI,title,container-title,issued,page,author",
                    "sort": "is-referenced-by-count", "order": "desc",
                }))
                body = get(url)
                time.sleep(0.25)          # Crossref 예의 — 몰아치지 않는다
                if not body:
                    continue
                for it in (body.get("message") or {}).get("items", []):
                    doi = norm(it.get("DOI"))
                    journal = (it.get("container-title") or [""])[0]
                    if not doi or doi in have or doi in seen_this_year:
                        continue
                    if not journal_ok(journal):
                        continue          # 화이트리스트 밖은 후보에도 안 넣는다
                    seen_this_year.add(doi)
                    found.append({
                        "doi": it.get("DOI"), "title": (it.get("title") or [""])[0],
                        "journal": journal, "year": year,
                        "authors": authors_of(it), "pages": it.get("page"),
                        "question": q, "matched": term, "adopted": False,
                    })
        found = found[:cap]
        if found:
            doc["by_year"][str(year)] = found
            total += len(found)
        print(f"  {year}  후보 {len(found):>3}편"
              + (f"   예: {found[0]['title'][:52]}" if found else ""))

    doc["harvested"] = f"{y0}-{y1}"
    save(CANDIDATES, doc)
    print(f"\n후보 {total}편을 {CANDIDATES.name} 에 적었습니다. **아직 인용되지 않습니다.**")
    print("네 질문 중 하나를 바꾸는 것만 .papers.json 으로 옮기십시오 "
          "— 옮길 때 claim(주장한 것)과 limits(주장하지 않는 것)를 함께 적어야 합니다.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="논문을 연도별로 훑고 채택본을 재대조합니다.")
    ap.add_argument("--verify", action="store_true", help="채택본을 Crossref 로 재대조")
    ap.add_argument("--write", action="store_true", help="재대조에서 어긋난 곳을 갱신")
    ap.add_argument("--harvest", metavar="2013-2026", help="이 연도 구간을 훑어 후보에 쌓기")
    ap.add_argument("--harvest-years", type=int, metavar="N",
                    help="올해를 포함한 최근 N개 연도를 훑기 (자동 실행용 — "
                         "달력이 넘어가도 구간을 고쳐 줄 필요가 없습니다)")
    ap.add_argument("--max-per-year", type=int, default=25, help="연도당 후보 상한 (기본 25)")
    a = ap.parse_args()

    if a.harvest_years:
        # 자동 실행에서 "2013-2026" 을 박아 두면 해가 바뀌는 순간 새 논문을
        # 영영 못 봅니다. 그래서 오늘 날짜에서 셉니다.
        n = max(1, min(int(a.harvest_years), 30))
        this_year = date.today().year
        return harvest(this_year - n + 1, this_year, max(1, a.max_per_year))
    if a.harvest:
        m = re.fullmatch(r"(\d{4})-(\d{4})", a.harvest.strip())
        if not m:
            print("--harvest 는 2013-2026 처럼 씁니다.", file=sys.stderr)
            return 2
        y0, y1 = int(m.group(1)), int(m.group(2))
        if y0 > y1:
            print("시작 연도가 끝 연도보다 큽니다.", file=sys.stderr)
            return 2
        return harvest(y0, y1, max(1, a.max_per_year))
    if a.verify or a.write:
        return verify(a.write)
    return coverage()


if __name__ == "__main__":
    sys.exit(main())
