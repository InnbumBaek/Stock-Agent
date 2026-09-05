"""팩터가 인용하는 논문의 발행 정보를 다시 대조한다 (인터넷 필요).

`stock-monitor/.papers.json` 은 처음 만들 때 웹 검색으로 확인한 것이다. 다만
"확인했다"는 기록만 남으면 6개월 뒤에 그것이 맞는지 아무도 모른다. 그래서
DOI 가 있는 항목은 Crossref 로 다시 조회해 **제목·저널·연도·쪽수가 그대로인지**
기계적으로 맞춘다.

    python docs/fetch_papers.py            # 대조만 (파일을 고치지 않는다)
    python docs/fetch_papers.py --write    # 어긋난 곳을 Crossref 값으로 갱신

DOI 가 없는 항목(Risk 지 기고문 두 편)은 여기서 확인할 수 없다. 그 사실을
그대로 출력한다 — 확인 못 한 것을 확인했다고 넘기지 않는다.
"""
import argparse
import io
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

P = Path(__file__).resolve().parent.parent / "stock-monitor" / ".papers.json"
API = "https://api.crossref.org/works/"
UA = {"User-Agent": "ki-monitor-paper-check (mailto:noreply@example.com)"}


def crossref(doi: str) -> dict | None:
    try:
        req = urllib.request.Request(API + doi, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["message"]
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        return None


def norm(s) -> str:
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="어긋난 곳을 갱신")
    args = ap.parse_args()

    doc = json.loads(io.open(P, encoding="utf-8").read())
    bad, skipped, ok = [], [], 0
    for key, p in doc["papers"].items():
        if not p.get("doi"):
            skipped.append(f"{key} — DOI 없음 ({p['journal']}) · 여기서 확인 불가")
            continue
        m = crossref(p["doi"])
        if not m:
            bad.append(f"{key} — Crossref 조회 실패 (네트워크 또는 DOI 오류)")
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
            bad.append(f"{key} — {' · '.join(diffs)}")
            if args.write:
                p["title"], p["journal"] = title or p["title"], journal or p["journal"]
                if year:
                    p["year"] = int(year)
                if pages:
                    p["pages"] = pages
        else:
            ok += 1
            print(f"  O  {key:<12} {p['authors']} ({p['year']})")

    for s in skipped:
        print(f"  -  {s}")
    for b in bad:
        print(f"  X  {b}")
    print(f"\n대조 {ok}건 일치 · {len(bad)}건 불일치 · {len(skipped)}건 확인 불가")
    if args.write and bad:
        io.open(P, "w", encoding="utf-8").write(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
        print(f"갱신했습니다: {P}")
    return 1 if bad and not args.write else 0


if __name__ == "__main__":
    sys.exit(main())
