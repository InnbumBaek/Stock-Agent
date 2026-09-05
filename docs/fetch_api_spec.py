"""공식 예제 코드에서 API 응답 필드 목록을 뽑아 얼려 둔다.

왜 이게 필요한가 — "API 가 된다"와 "내가 읽는 필드가 맞다"는 다른 문제다.
호출이 200 으로 성공해도 필드 이름을 하나 잘못 적으면 그 값은 조용히 None 이
되고, 리포트에는 "데이터 없음"이 찍힌다. 틀렸다는 신호가 어디에도 안 뜬다.

그래서 각 기관의 **공식 예제 코드**에서 응답 필드 목록을 뽑아
`stock-monitor/.api_fields.json` 에 얼려 두고, selftest 가 매번
"내 매핑이 이 목록 안에 있는가"를 검사한다. 네트워크 없이 돈다.

이 스크립트는 그 목록을 **갱신할 때만** 쓴다 (인터넷 필요).

    python docs/fetch_api_spec.py

출처는 전부 1차다 — 기관이 직접 낸 예제이거나, 그 기관 API 만을 위해
널리 쓰이는 표준 클라이언트다. 블로그·기억은 쓰지 않는다.
"""
import ast
import io
import json
import re
import sys
import tarfile
import urllib.request
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "stock-monitor" / ".api_fields.json"
UA = {"User-Agent": "ki-monitor-spec-fetch"}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def column_mapping(src: str) -> list[str]:
    """공식 예제의 COLUMN_MAPPING 에서 응답 필드 이름을 뽑는다."""
    m = re.search(r"COLUMN_MAPPING\s*=\s*(\{.*?\n\})", src, re.S)
    if not m:
        raise RuntimeError("COLUMN_MAPPING 을 찾지 못했습니다 — 예제 형식이 바뀌었습니다.")
    return sorted(ast.literal_eval(m.group(1)).keys())


def pypi_sdist(pkg: str) -> tuple[str, bytes]:
    meta = json.loads(get(f"https://pypi.org/pypi/{pkg}/json"))
    ver = meta["info"]["version"]
    for f in meta["urls"]:
        if f["packagetype"] == "sdist":
            return ver, get(f["url"])
    raise RuntimeError(f"{pkg}: sdist 가 없습니다")


def member(blob: bytes, suffix: str) -> str:
    with tarfile.open(fileobj=io.BytesIO(blob)) as tf:
        for n in tf.getnames():
            if n.endswith(suffix):
                return tf.extractfile(n).read().decode("utf-8", "replace")
    raise RuntimeError(f"{suffix} 를 찾지 못했습니다")


def main() -> int:
    spec: dict = {
        "schema": "ki.apispec/1",
        "generated": date.today().isoformat(),
        "note": ("각 기관 공식 예제/표준 클라이언트에서 뽑은 응답 필드 목록입니다. "
                 "selftest 가 ki_monitor.py 의 매핑이 이 안에 있는지 검사합니다. "
                 "갱신: python docs/fetch_api_spec.py"),
        "sources": {},
    }

    # ── 한국투자증권 — 공식 저장소의 기능별 예제 -------------------------
    kis = "https://raw.githubusercontent.com/koreainvestment/open-trading-api/main"
    for key, folder, fn, url, tr, body in (
        ("kis.quote", "inquire_price", "inquire_price",
         "/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", "output"),
        ("kis.orderbook", "inquire_asking_price_exp_ccn", "inquire_asking_price_exp_ccn",
         "/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn",
         "FHKST01010200", "output1"),
    ):
        p = f"examples_llm/domestic_stock/{folder}/chk_{fn}.py"
        src = get(f"{kis}/{p}").decode("utf-8")
        spec["sources"][key] = {
            "기관": "한국투자증권",
            "출처": f"github.com/koreainvestment/open-trading-api @main · {p}",
            "등급": "1차 — 기관 공식 예제",
            "path": url, "tr_id": tr, "body": body,
            "params": ["FID_COND_MRKT_DIV_CODE", "FID_INPUT_ISCD"],
            "fields": column_mapping(src),
        }
        print(f"  KIS  {key:16} {len(spec['sources'][key]['fields']):3d}개 필드")

    # ── 한국은행 ECOS — 표준 클라이언트 ----------------------------------
    ver, blob = pypi_sdist("PublicDataReader")
    src = member(blob, "PublicDataReader/ecos/ecos.py")
    m = re.search(r"100대 통계지표(.*?)\"\"\"", src, re.S)
    fields = sorted(set(re.findall(r"\(([A-Z_]{3,})\)", m.group(1)))) if m else []
    if not fields:
        raise RuntimeError("ECOS: KeyStatisticList 출력 필드를 찾지 못했습니다")
    spec["sources"]["ecos.key_stats"] = {
        "기관": "한국은행",
        "출처": f"PyPI PublicDataReader {ver} · PublicDataReader/ecos/ecos.py",
        "등급": "1차 — 해당 기관 API 전용 표준 클라이언트",
        "url_shape": "{base}/KeyStatisticList/{인증키}/json/{언어}/{시작}/{종료}",
        "body": "KeyStatisticList.row",
        "실패": "HTTP 200 안에 RESULT.CODE / RESULT.MESSAGE",
        "fields": fields,
    }
    print(f"  ECOS ecos.key_stats   {len(fields):3d}개 필드  {fields}")

    # ── 금융감독원 DART — 표준 클라이언트 --------------------------------
    ver, blob = pypi_sdist("OpenDartReader")
    joined = "\n".join(member(blob, f"opendartreader/{f}")
                       for f in ("dart.py", "dart_list.py", "dart_finstate.py",
                                 "dart_event.py"))
    eps = sorted(set(re.findall(r"opendart\.fss\.or\.kr/api/([A-Za-z]+\.(?:json|xml))",
                                joined)))
    spec["sources"]["dart"] = {
        "기관": "금융감독원",
        "출처": f"PyPI OpenDartReader {ver} · opendartreader/*.py",
        "등급": "1차 — 해당 기관 API 전용 표준 클라이언트",
        "base": "https://opendart.fss.or.kr/api",
        "key_param": "crtfc_key",
        "성공": "status == '000'",
        "실패": "HTTP 200 안에 status / message",
        "endpoints": eps,
    }
    print(f"  DART dart             {len(eps):3d}개 엔드포인트")

    # ── 美 연준 FRED — 표준 클라이언트 -----------------------------------
    ver, blob = pypi_sdist("fredapi")
    src = member(blob, "fredapi/fred.py")
    root = re.search(r"root_url\s*=\s*'([^']+)'", src).group(1)
    spec["sources"]["fred.observations"] = {
        "기관": "미국 세인트루이스 연방준비은행",
        "출처": f"PyPI fredapi {ver} · fredapi/fred.py",
        "등급": "1차 — 해당 기관 API 전용 표준 클라이언트",
        "base": f"{root}/series/observations",
        "params": ["series_id", "api_key", "file_type", "observation_start",
                   "observation_end"],
        "body": "observations",
        "fields": ["date", "value"],
        "결측": "value 가 '.' 로 옵니다 — 0 으로 채우면 안 됩니다",
    }
    print(f"  FRED fred.observations  {root}")

    # ── 한국거래소 KRX — 실응답 대조 기록 --------------------------------
    #
    # KRX 는 공식 예제 저장소도, 이 신 Open API 만을 위한 표준 클라이언트도
    # 없습니다(널리 쓰이는 pykrx 는 구 data.krx.co.kr 화면용 엔드포인트를
    # 씁니다 — 다른 API 입니다). 그래서 여기만 근거가 다릅니다:
    # 2026-08-13 에 실제 응답을 받아 대조한 기록을 그대로 얼려 둡니다.
    spec["sources"]["krx.bydd_trd"] = {
        "기관": "한국거래소",
        "출처": "실응답 대조 2026-08-13 · stk_bydd_trd basDd=20260812 (942건)",
        "등급": "1차 — 실응답 직접 대조 (공식 예제 저장소 없음)",
        "검산": ["거래대금÷거래량이 고가·저가 범위 안 → ACC_TRDVAL 단위는 원",
                 "종가 × LIST_SHRS = MKTCAP 항등식 성립"],
        "fields": ["ACC_TRDVAL", "ACC_TRDVOL", "BAS_DD", "CMPPREVDD_PRC", "FLUC_RT",
                   "ISU_CD", "ISU_NM", "LIST_SHRS", "MKTCAP", "MKT_NM", "SECT_TP_NM",
                   "TDD_CLSPRC", "TDD_HGPRC", "TDD_LWPRC", "TDD_OPNPRC"],
    }
    print(f"  KRX  krx.bydd_trd     {len(spec['sources']['krx.bydd_trd']['fields']):3d}개 필드 (실응답 기록)")

    OUT.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    print(f"\n기록: {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
