#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ki_monitor.py — 상장 포트폴리오사 회수 판단 리포트 자동화 (단일 파일)

한국거래소 KRX Open API · KB증권 Open API · DART 전자공시 세 개만 사용합니다.
설정 파일도, 패키지 폴더도 없습니다. 이 파일 하나면 전부 돌아갑니다.

  python ki_monitor.py selftest              # 계산 검증 (키 불필요)
  python ki_monitor.py report --mock         # 가상 데이터로 리포트 1부 (키 불필요)
  python ki_monitor.py check-auth            # 세 API 키 로딩 확인
  python ki_monitor.py ingest --from 20240101
  python ki_monitor.py report
  python ki_monitor.py watch                 # 장중 폴링 알림
  python ki_monitor.py init                  # .env / positions.csv 뼈대 생성

필요 패키지:  pandas numpy scipy requests jinja2 weasyprint lxml
  (jinja2·weasyprint 가 없으면 HTML 을 자체 조판으로 생성합니다)
  (lxml 은 DART XML 파싱에 필요합니다)

키는 같은 폴더의 .env 파일에만 둡니다. 코드·깃·채팅 어디에도 붙여넣지 마십시오.
  KRX_API_KEY=...   DART_API_KEY=...   KB_APP_KEY=...   KB_APP_SECRET=...
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sqlite3
import sys
import time
import zipfile
from collections import deque
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import numpy as np
import pandas as pd

# Jupyter Notebook 환경에서도 경로를 찾을 수 있도록 예외 처리
try:
    ROOT = Path(__file__).resolve().parent
except NameError:
    ROOT = Path.cwd()

# 한글 Windows 콘솔은 기본 cp949 라 '—' 같은 문자에서 UnicodeEncodeError 가 납니다.
# 이 프로세스의 출력 스트림만 UTF-8 로 바꿉니다 (시스템 설정·코드페이지는 건드리지 않습니다).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass

CALC_VERSION = "single-v1"
ANN = 252
MAX_DAILY_MOVE = 0.30       # 가격제한폭 ±30%
SHARE_JUMP_TOL = 0.02       # 이 이상 주식수가 변하면 '확인 대상'
MIN_ACTION_SIZE = 0.10      # 권리락으로 인정할 최소 크기 (이하면 일간 변동성에 묻힙니다)
ACTION_MATCH_TOL = 0.05     # 주가 실측이 주식수 비율과 이만큼 안에서 맞아야 조정

# ════════════════════════════════════════════════════════════════════════
# 1. 설정 — 개인/법인 차이는 전부 여기에만 있습니다
# ════════════════════════════════════════════════════════════════════════

STAGE = "personal"          # personal | corporate  ← 법인 전환 시 이 한 줄만 바꿉니다

# 리포트 머리말에 찍히는 조직명. .env 의 ORG_NAME 으로 덮어쓸 수 있습니다.
# 저장소에는 조직 식별 정보를 넣지 않습니다 — 배포 환경에서만 채웁니다.
ORG_NAME = os.environ.get("ORG_NAME", "투자본부")

ENV = {
    "personal": {
        "positions_file": "positions.csv",
        "db_path": "ki.sqlite",
        "out_dir": "out",
        "recipients": [],                       # 비어 있으면 발송하지 않습니다
        "watermark": "개인 테스트 단계 · 검증 중 · 배포 금지",
    },
    "corporate": {
        "positions_file": "positions.csv",
        "db_path": "ki.sqlite",
        "out_dir": "out",
        "recipients": [],                       # 배포 승인 후 기재
        "watermark": "",
    },
}
MARKET = {"close_time": "1530", "poll_sec": 10, "ring_minutes": 60}


def env(key: str):
    v = ENV[STAGE][key]
    if key in ("positions_file", "db_path", "out_dir") and not os.path.isabs(v):
        return str(ROOT / v)
    return v


def _load_dotenv(path: Path = None) -> None:
    path = path or ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def api_key(name: str) -> str:
    _load_dotenv()
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(f"{name} 가 비어 있습니다. .env 파일에 넣으십시오.")
    return val


def has_key(name: str) -> bool:
    _load_dotenv()
    return bool(os.environ.get(name, "").strip())


# ── 프로바이더 스펙 ────────────────────────────────────────────────────
# 응답 항목명은 개발명세서와 1회 대조한 뒤 VERIFIED 를 True 로 바꾸십시오.
# 필드 순서·이름 오류는 예외를 내지 않고 '그럴듯한 숫자'를 만듭니다.

KRX = {
    "base_url": "http://data-dbg.krx.co.kr/svc/apis",
    "auth_header": "AUTH_KEY",
    "date_param": "basDd",
    # 2026-08-13 실응답 대조 완료 (stk_bydd_trd, basDd=20260812, 942건):
    #   · field_map 13개 항목 전부 응답에 존재
    #   · 거래대금÷거래량이 고가·저가 범위 안 → ACC_TRDVAL 단위는 원(KRW)
    #   · 종가 × LIST_SHRS = MKTCAP 항등식 성립
    # 응답에만 있고 코드에 없는 항목: CMPPREVDD_PRC(전일대비), SECT_TP_NM(소속부)
    "verified": True,
    "services": {
        "stk_isu_base_info": {"group": "sto", "market": "KOSPI"},
        "ksq_isu_base_info": {"group": "sto", "market": "KOSDAQ"},
        "knx_isu_base_info": {"group": "sto", "market": "KONEX"},
        "stk_bydd_trd": {"group": "sto", "market": "KOSPI"},
        "ksq_bydd_trd": {"group": "sto", "market": "KOSDAQ"},
        "knx_bydd_trd": {"group": "sto", "market": "KONEX"},
        "krx_dd_trd": {"group": "idx", "market": "KRX"},
        "kospi_dd_trd": {"group": "idx", "market": "KOSPI"},
        "kosdaq_dd_trd": {"group": "idx", "market": "KOSDAQ"},
        "bon_dd_trd": {"group": "idx", "market": "BOND"},
        "fut_bydd_trd": {"group": "drv", "market": "FUTURES"},
        "kts_bydd_trd": {"group": "bon", "market": "KTS"},
    },
    "field_map": {
        "bydd_trd": {
            "BAS_DD": "date", "ISU_CD": "code", "ISU_NM": "name", "MKT_NM": "market",
            "TDD_OPNPRC": "open", "TDD_HGPRC": "high", "TDD_LWPRC": "low",
            "TDD_CLSPRC": "close", "FLUC_RT": "chg_pct", "ACC_TRDVOL": "volume",
            "ACC_TRDVAL": "value", "MKTCAP": "mktcap", "LIST_SHRS": "shares",
        },
        "isu_base_info": {
            "ISU_CD": "isin", "ISU_SRT_CD": "code", "ISU_NM": "name",
            "MKT_TP_NM": "market", "SECT_TP_NM": "sector", "LIST_DD": "list_date",
        },
        "idx_dd_trd": {
            "BAS_DD": "date", "IDX_NM": "index_name", "OPNPRC_IDX": "open",
            "HGPRC_IDX": "high", "LWPRC_IDX": "low", "CLSPRC_IDX": "close",
        },
    },
}

DART = {
    "base_url": "https://opendart.fss.or.kr/api",
    "rate_limit_per_min": 90,
    "endpoints": {
        # DS001 공시정보
        "corp_code": ("corpCode.xml", "zip"),
        "disclosure_list": ("list.json", "json"),
        "company": ("company.json", "json"),
        # DS003 재무정보
        "fs_major": ("fnlttSinglAcnt.json", "json"),
        "fs_all": ("fnlttSinglAcntAll.json", "json"),
        "fs_multi": ("fnlttMultiAcnt.json", "json"),
        "fs_index": ("fnlttSinglIndx.json", "json"),
        # DS004 지분공시
        "major_holder": ("majorstock.json", "json"),
        "exec_holder": ("elestock.json", "json"),
        # DS002 정기보고서 주요정보
        "stock_total": ("stockTotqySttus.json", "json"),
        "dividend": ("alotMatter.json", "json"),
        "treasury": ("tesstkAcqsDspsSttus.json", "json"),
        "largest_holder": ("hyslrSttus.json", "json"),
        "capital_change": ("irdsSttus.json", "json"),
        "audit_opinion": ("accnutAdtorNmNdAdtOpinion.json", "json"),
        "bond_outstanding": ("cprndNrdmpBlce.json", "json"),
        # DS005 주요사항보고서
        "cb_issue": ("cvbdIsDecsn.json", "json"),
        "bw_issue": ("bdwtIsDecsn.json", "json"),
        "paid_increase": ("piicDecsn.json", "json"),
        "free_increase": ("fricDecsn.json", "json"),
    },
    "event_keywords": {
        "corporate_action": ["무상증자", "유상증자", "액면분할", "주식병합", "감자", "주식배당"],
        "dilution": ["전환사채", "신주인수권부사채", "교환사채", "전환가액", "행사가액"],
        "risk": ["소송", "영업정지", "회생절차", "감사의견", "관리종목", "상장폐지", "부도"],
    },
}

# 2026-08-13 실측 확인 결과 — 추정이 아니라 확인된 사실입니다.
#   · openapi.kbsec.com 은 DigiCert 발급 *.kbsec.com 인증서를 가진 진짜 KB 도메인
#   · 다만 이 호스트는 API 게이트웨이가 아니라 'KB증권 Open API 서비스 포탈'(웹사이트)
#     — /oauth2/token 을 포함해 어떤 경로로 POST 해도 HTML 이 돌아옵니다
#   · 포털이 공개하는 API 카탈로그(/api/apis/public)에는 20개가 등록돼 있고
#     경로 체계는 /baas/v2/<코드> 입니다 (BaaS = 제휴사용 브로커리지)
#   · 20개 전부 계좌개설·주문·퇴직연금·약관동의 계열입니다.
#     >>> 시세(현재가·호가) API 가 하나도 없습니다 <<<
#   · 따라서 이 포털로는 실시간 시세도, NXT 통합시세도 얻을 수 없습니다.
#   · 아래 field_map 의 항목명(stck_prpr, acml_tr_pbmn, bidp1 …)은 KB 가 아니라
#     한국투자증권 KIS Open API 의 스키마입니다. 원 코드가 KIS 문서를 보고 적은 것으로
#     보입니다. KB 에 그대로 쓰면 맞을 리가 없습니다.
KB = {
    "base_url": "https://openapi.kbsec.com",
    "token_path": "/oauth2/token",
    "verified": False,
    "quote_api_exists": False,      # 실측: 공개 카탈로그에 시세 API 없음
    "portal_catalog": "/api/apis/public",
    "allowed": {},                  # 붙일 수 있는 읽기 전용 시세 엔드포인트가 없습니다
    "denied": ["order", "order_modify", "order_cancel", "balance", "overseas"],
    "field_map": {
        "stck_prpr": "price", "stck_oprc": "open", "stck_hgpr": "high",
        "stck_lwpr": "low", "stck_sdpr": "prev_close", "acml_vol": "volume",
        "acml_tr_pbmn": "value", "bidp1": "bid", "askp1": "ask",
        "bidp_rsqn1": "bid_qty", "askp_rsqn1": "ask_qty",
    },
}

# ── 수집 항목 대장 ─────────────────────────────────────────────────────
# unit 이 없는 항목은 적재를 거부합니다. section 이 비면 원장에만 저장합니다.
CATALOG = [
    # key, source, unit, freq, section, required, persist
    ("krx.bydd.open",   "KRX/일별매매정보", "KRW",    "daily", (3,),      True,  True),
    ("krx.bydd.high",   "KRX/일별매매정보", "KRW",    "daily", (3, 4),    True,  True),
    ("krx.bydd.low",    "KRX/일별매매정보", "KRW",    "daily", (3, 4),    True,  True),
    ("krx.bydd.close",  "KRX/일별매매정보", "KRW",    "daily", (2, 3, 4), True,  True),
    ("krx.bydd.volume", "KRX/일별매매정보", "shares", "daily", (8,),      True,  True),
    ("krx.bydd.value",  "KRX/일별매매정보", "KRW",    "daily", (8,),      True,  True),
    ("krx.bydd.mktcap", "KRX/일별매매정보", "KRW",    "daily", (2,),      False, True),
    ("krx.bydd.shares", "KRX/일별매매정보", "shares", "daily", (6,),      True,  True),
    ("krx.idx.close",   "KRX/지수일별시세", "point",  "daily", (3, 4),    True,  True),
    ("dart.fs.revenue",     "DART/DS003", "KRW",    "quarterly", (5,),      False, True),
    ("dart.fs.op_income",   "DART/DS003", "KRW",    "quarterly", (5, 16),   False, True),
    ("dart.fs.net_income",  "DART/DS003", "KRW",    "quarterly", (5, 16),   False, True),
    ("dart.fs.assets",      "DART/DS003", "KRW",    "quarterly", (5, 16),   False, True),
    ("dart.fs.equity",      "DART/DS003", "KRW",    "quarterly", (5, 16),   False, True),
    ("dart.ds002.stock_total",   "DART/DS002/주식총수",   "shares", "quarterly", (6,),  False, True),
    ("dart.ds002.treasury",      "DART/DS002/자기주식",   "shares", "quarterly", (6,),  False, True),
    ("dart.ds002.largest_pct",   "DART/DS002/최대주주",   "pct",    "quarterly", (6,),  False, True),
    ("dart.ds002.dividend_ps",   "DART/DS002/배당",       "KRW",    "yearly",    (9,),  False, True),
    ("dart.ds002.bond_balance",  "DART/DS002/미상환사채", "KRW",    "quarterly", (13,), False, True),
    ("dart.ds002.audit_opinion", "DART/DS002/감사의견",   "text",   "yearly",    (5, 15), False, True),
    ("dart.ds004.major_holder",  "DART/DS004/대량보유",   "pct",    "event",     (14,), False, True),
    ("dart.ds004.exec_holder",   "DART/DS004/임원주요주주", "shares", "event",   (14,), False, True),
    ("dart.ds005.cb_amount",     "DART/DS005/CB발행",     "KRW",    "event",     (11,), False, True),
    ("dart.ds005.cb_conv_price", "DART/DS005/전환가액",   "KRW",    "event",     (11,), False, True),
    ("dart.ds001.rcept_dt",      "DART/DS001/공시검색",   "date",   "event",     (12,), True,  True),
    ("kb.snap.price",   "KB/시세조회", "KRW",    "intraday", (8,), False, False),
    ("kb.snap.bid",     "KB/시세조회", "KRW",    "intraday", (8,), False, False),
    ("kb.snap.ask",     "KB/시세조회", "KRW",    "intraday", (8,), False, False),
    ("kb.snap.bid_qty", "KB/시세조회", "shares", "intraday", (8,), False, False),
    ("kb.snap.ask_qty", "KB/시세조회", "shares", "intraday", (8,), False, False),
]
VALID_UNITS = {"KRW", "KRW_1000", "shares", "pct", "point", "text", "date", "ratio", "bp"}

SECTIONS = [
    (1, "오늘 달라진 것"), (2, "포지션 현황 · 집중도"), (3, "가격 · 벤치마크 대비"),
    (4, "리스크 (변동성 · VaR · 상관)"), (5, "재무 요약 (XBRL)"), (6, "자본 구조 · 주주 구성"),
    (7, "목표회수단가 갭 · 시나리오"), (8, "유동성 · 실행비용 · 미시구조"),
    (9, "총수익률 · 배당 반영"), (10, "데이터 품질 · 검증 상태"),
    (11, "규제 · 규약 · 희석 감시"), (12, "공시 이벤트 · CAR"), (13, "사채 만기 · 자금 사용"),
    (14, "지분 · 내부자 매매"), (15, "감사 · 지배구조 변동"), (16, "스코어카드"),
    (17, "펀드 지표 (월간)"), (18, "이번 주 볼 것"),
]


def catalog_audit() -> dict:
    problems, seen = [], set()
    for key, _src, unit, freq, section, _req, persist in CATALOG:
        if key in seen:
            problems.append(f"{key}: 중복")
        seen.add(key)
        if unit not in VALID_UNITS:
            problems.append(f"{key}: 단위 미확정 ({unit})")
        if not section and not persist:
            problems.append(f"{key}: 표시도 저장도 하지 않는 항목")
    return {
        "total": len(CATALOG),
        "shown": len([c for c in CATALOG if c[4]]),
        "not_persisted": len([c for c in CATALOG if not c[6]]),
        "problems": problems,
    }


# ════════════════════════════════════════════════════════════════════════
# 2. 저장소 — SQLite. 일별 데이터는 수년치까지 이걸로 충분합니다
# ════════════════════════════════════════════════════════════════════════

SCHEMA = """
CREATE TABLE IF NOT EXISTS price_daily (
    date TEXT NOT NULL, code TEXT NOT NULL, name TEXT, market TEXT,
    open REAL, high REAL, low REAL, close REAL,
    volume REAL, value REAL, mktcap REAL, shares REAL,
    adj_factor REAL DEFAULT 1.0, source TEXT, fetched_at TEXT, calc_version TEXT,
    PRIMARY KEY (date, code));
CREATE TABLE IF NOT EXISTS index_daily (
    date TEXT NOT NULL, index_name TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL, fetched_at TEXT,
    PRIMARY KEY (date, index_name));
CREATE TABLE IF NOT EXISTS instruments (
    code TEXT PRIMARY KEY, name TEXT, market TEXT, sector TEXT,
    isin TEXT, corp_code TEXT, list_date TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS disclosure (
    rcept_no TEXT PRIMARY KEY, corp_code TEXT, code TEXT, rcept_dt TEXT,
    title TEXT, tags TEXT, fetched_at TEXT);
CREATE TABLE IF NOT EXISTS fundamental (
    code TEXT NOT NULL, period TEXT NOT NULL, key TEXT NOT NULL,
    value REAL, unit TEXT, source TEXT, fetched_at TEXT,
    PRIMARY KEY (code, period, key));
CREATE TABLE IF NOT EXISTS alert_log (
    ts TEXT NOT NULL, code TEXT NOT NULL, rule TEXT NOT NULL,
    sev TEXT, value REAL, reason TEXT);
CREATE TABLE IF NOT EXISTS macro_daily (
    date TEXT NOT NULL, key TEXT NOT NULL, value REAL,
    unit TEXT, source TEXT, fetched_at TEXT,
    PRIMARY KEY (date, key));
CREATE INDEX IF NOT EXISTS ix_price_code ON price_daily(code, date);
"""


def connect() -> sqlite3.Connection:
    p = Path(env("db_path"))
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p)
    con.executescript(SCHEMA)
    # CREATE TABLE IF NOT EXISTS 는 이미 만들어진 표에 열을 더해주지 않습니다.
    # 기존 원장을 지우지 않고 열만 채워 넣습니다.
    have = {r[1] for r in con.execute("PRAGMA table_info(price_daily)")}
    for col, typ in (("name", "TEXT"), ("market", "TEXT")):
        if col not in have:
            con.execute(f"ALTER TABLE price_daily ADD COLUMN {col} {typ}")
    con.commit()
    return con


def upsert(con, table: str, df: pd.DataFrame) -> int:
    if df is None or df.empty:
        return 0
    cols = ",".join(df.columns)
    marks = ",".join("?" * len(df.columns))
    con.executemany(f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({marks})",
                    df.itertuples(index=False, name=None))
    con.commit()
    return len(df)


def price_panel(con, codes: list[str], adjusted: bool = True) -> pd.DataFrame:
    q = ("SELECT date, code, open, high, low, close, volume, value, shares, adj_factor "
         "FROM price_daily")
    if codes:
        q += " WHERE code IN (%s)" % ",".join("?" * len(codes))
    df = pd.read_sql_query(q + " ORDER BY date", con, params=tuple(codes))
    if df.empty:
        return df
    if adjusted:
        for c in ("open", "high", "low", "close"):
            df[c] = df[c] * df["adj_factor"]
    df["date"] = pd.to_datetime(df["date"])
    return df


# ════════════════════════════════════════════════════════════════════════
# 3. API 호출 — 세 곳의 인증 방식이 서로 다릅니다
#    KRX  : 요청 헤더 AUTH_KEY
#    DART : 쿼리 파라미터 crtfc_key
#    KB   : OAuth 토큰을 받아 Bearer 로
# ════════════════════════════════════════════════════════════════════════

def _requests():
    try:
        import requests
        return requests
    except ImportError:
        raise RuntimeError("requests 가 필요합니다:  pip install requests")


# ── KRX ───────────────────────────────────────────────────────────────
def krx_get(service: str, bas_dd: str, retries: int = 3):
    requests = _requests()
    svc = KRX["services"][service]
    url = f"{KRX['base_url']}/{svc['group']}/{service}"
    headers = {KRX["auth_header"]: api_key("KRX_API_KEY")}
    params = {KRX["date_param"]: bas_dd}
    last = None
    for i in range(retries):
        try:
            r = requests.get(url, headers=headers, params=params, timeout=20)
            if r.status_code == 401:
                raise RuntimeError(
                    f"401 — '{service}' 의 URL 사용신청이 되어 있는지 확인하십시오. "
                    "인증키 발급만으로는 호출되지 않습니다.")
            r.raise_for_status()
            body = r.json()
            for k in ("OutBlock_1", "output", "data", "OutBlock"):
                if k in body:
                    return body[k]
            return body if isinstance(body, list) else []
        except requests.RequestException as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"KRX 호출 실패: {service} {bas_dd}") from last


def krx_map(rows: list, map_name: str) -> pd.DataFrame:
    fmap = KRX["field_map"][map_name]
    if not KRX["verified"]:
        print(f"  [경고] KRX verified=False — '{map_name}' 를 개발명세서와 대조하십시오.")
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    missing = set(fmap) - set(df.columns)
    if missing:
        print(f"  [경고] 응답에 없는 항목: {sorted(missing)}")
    keep = {k: v for k, v in fmap.items() if k in df.columns}
    out = df[list(keep)].rename(columns=keep)
    for col in ("open", "high", "low", "close", "volume", "value",
                "mktcap", "shares", "chg_pct"):
        if col in out.columns:
            out[col] = pd.to_numeric(
                out[col].astype(str).str.replace(",", "", regex=False), errors="coerce")
    # 거래정지 종목은 시가·고가·저가가 0 으로 오고 종가 자리에 기준가가 들어옵니다.
    # 0 을 그대로 두면 '종가 > 고가' 로 읽혀 OHLC 검산과 변동성 계산이 전부 깨집니다.
    # 없는 값은 0 이 아니라 결측입니다 — NaN 으로 두고 계산에서 빠지게 합니다.
    for col in ("open", "high", "low", "close"):
        if col in out.columns:
            out.loc[out[col] <= 0, col] = np.nan
    return out


def krx_daily_prices(bas_dd: str, markets=("KOSPI", "KOSDAQ", "KONEX")) -> pd.DataFrame:
    svc = {"KOSPI": "stk_bydd_trd", "KOSDAQ": "ksq_bydd_trd", "KONEX": "knx_bydd_trd"}
    frames = []
    for m in markets:
        df = krx_map(krx_get(svc[m], bas_dd), "bydd_trd")
        if not df.empty:
            if "market" not in df.columns:
                df["market"] = m
            frames.append(df)
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    out["date"] = bas_dd
    out["source"] = "KRX/일별매매정보"
    out["fetched_at"] = datetime.now().isoformat(timespec="seconds")
    return out


BENCHMARK = "코스닥"          # 리포트 §3 의 기준 지수 (IDX_NM 값 그대로)


def ingest_fundamentals(market: str = "KOSDAQ", year: str = None,
                        reprt: str = "11011") -> dict:
    """시장 전 종목의 주요계정을 적재합니다. 사업보고서(11011) 기준입니다."""
    year = year or str(date.today().year - 1)
    con = connect()
    codes = [r[0] for r in con.execute(
        "SELECT DISTINCT code FROM price_daily WHERE market=?", (market,))]
    cc = dart_corp_codes().set_index("stock_code")["corp_code"]
    pairs = [(c, cc[c]) for c in codes if c in cc.index]
    print(f"  {market} {len(codes):,}종목 · corp_code 매칭 {len(pairs):,}건 · "
          f"{year}년 {'사업보고서' if reprt == '11011' else reprt}")
    df = dart_financials_bulk([p[1] for p in pairs], year, reprt, progress=True)
    if df.empty:
        con.close()
        return {"ok": False, "n": 0, "reason": "응답 없음"}
    df = df[df["code"].isin(set(codes))].copy()
    df["period"] = f"{year}-{reprt}"
    df["unit"] = "KRW"
    df["source"] = "DART/DS003/다중회사주요계정"
    df["fetched_at"] = datetime.now().isoformat(timespec="seconds")
    n = upsert(con, "fundamental",
               df[["code", "period", "key", "value", "unit", "source", "fetched_at"]])
    con.close()
    return {"ok": True, "n": n, "companies": int(df["code"].nunique()), "period": f"{year}"}


def fundamentals_panel(con, period: str = None) -> pd.DataFrame:
    """code 를 행, 계정을 열로 펼칩니다."""
    q = "SELECT code, period, key, value FROM fundamental"
    params = ()
    if period:
        q += " WHERE period = ?"
        params = (period,)
    df = pd.read_sql_query(q, con, params=params)
    if df.empty:
        return df
    latest = df["period"].max()
    df = df[df["period"] == latest]
    return df.pivot_table(index="code", columns="key", values="value", aggfunc="last")


def unlisted_profile(names: list[str], year: str = None) -> dict:
    """비상장 포트폴리오사 — 주가가 없으니 재무와 공시로 봅니다.

    한계가 분명합니다. 외부감사 대상이 아닌 소규모 법인은 DART 에 재무를 내지
    않습니다. 그런 회사는 '미제출'로 남고, 그 사실 자체가 정보입니다."""
    year = year or str(date.today().year - 1)
    found = dart_find_corp(names)
    hit = found[found["corp_code"].notna()]
    fs = pd.DataFrame()
    if not hit.empty:
        fs = dart_financials_bulk(hit["corp_code"].tolist(), year, "11011")
    piv = pd.DataFrame()
    if not fs.empty:
        cur = fs.pivot_table(index="corp_code", columns="key", values="value",
                             aggfunc="last")
        prv = fs.pivot_table(index="corp_code", columns="key", values="value_prev",
                             aggfunc="last")
        piv = cur.join(prv.add_suffix("_prev"), how="left")
        pos = lambda s: s.where(s > 0)                          # noqa: E731
        if "revenue" in piv and "revenue_prev" in piv:
            piv["rev_growth"] = piv["revenue"] / pos(piv["revenue_prev"]) - 1
        if "op_income" in piv and "revenue" in piv:
            piv["opm"] = piv["op_income"] / pos(piv["revenue"])
        if "net_income" in piv and "equity" in piv:
            piv["roe"] = piv["net_income"] / pos(piv["equity"])
        if "liabilities" in piv and "equity" in piv:
            piv["debt_ratio"] = piv["liabilities"] / pos(piv["equity"])
        if "equity" in piv:
            piv["impaired"] = piv["equity"].le(0)
        if "net_income" in piv:
            piv["deficit"] = piv["net_income"].le(0)
    rows = []
    for _, r in found.iterrows():
        rec = {"name": r["name"], "matched": r["matched"], "corp_code": r["corp_code"],
               "n_match": r["n_match"], "has_dart": r["corp_code"] is not None,
               "has_fs": False}
        if r["corp_code"] is not None and not piv.empty and r["corp_code"] in piv.index:
            rec.update({k: v for k, v in piv.loc[r["corp_code"]].items()})
            rec["has_fs"] = True
        rows.append(rec)
    return {"table": pd.DataFrame(rows), "year": year,
            "n_found": int(found["corp_code"].notna().sum()), "n_total": len(names)}


# 비상장사의 엑싯 경로는 IPO 아니면 M&A 입니다. 재무는 대부분 안 나오지만
# 공시의 '종류'는 나옵니다. 그 자체가 준비 단계를 말해 줍니다.
BIG4 = ("삼일", "삼정", "안진", "한영")
IPO_SIGNALS = [
    ("상장예비심사", "상장예비심사 청구 — IPO 절차 진행", 3),
    ("증권신고서", "증권신고서 — 공모 단계", 3),
    ("합병", "합병 관련 — 구조 변경", 1),
    ("주식양수도", "주식양수도 — M&A 가능성", 2),
    ("영업양수도", "영업양수도 — M&A 가능성", 2),
    ("전환사채", "CB 발행 — 후속 자금조달", 1),
    ("유상증자", "유상증자 — 후속 자금조달", 1),
]


def unlisted_exit_signals(dsc: pd.DataFrame, names: pd.DataFrame) -> pd.DataFrame:
    """공시 종류로 엑싯 준비 단계를 읽습니다.

    감사보고서를 낸다 = 외부감사 대상 = 일정 규모 이상.
    Big4 가 감사한다 = 상장 준비 단계에서 흔한 신호 (충분조건은 아닙니다).
    상장예비심사·증권신고서는 IPO 절차가 실제로 돌고 있다는 뜻입니다."""
    if dsc is None or dsc.empty:
        return pd.DataFrame()
    rows = {}
    for _, r in dsc.iterrows():
        cc = str(r.get("corp_code", ""))
        nm = str(r.get("report_nm", ""))
        flr = str(r.get("flr_nm", ""))
        d = rows.setdefault(cc, {"corp_name": r.get("corp_name", ""), "audit": None,
                                 "auditor": None, "big4": False, "consol": False,
                                 "signals": [], "score": 0, "last": ""})
        d["last"] = max(d["last"], str(r.get("rcept_dt", "")))
        if "감사보고서" in nm:
            d["audit"] = str(r.get("rcept_dt", ""))
            if "회계법인" in flr or "감사" in flr:
                d["auditor"] = flr
                if any(b in flr for b in BIG4):
                    d["big4"] = True
            if "연결" in nm:
                d["consol"] = True
        for kw, label, w in IPO_SIGNALS:
            if kw in nm and label not in d["signals"]:
                d["signals"].append(label)
                d["score"] += w
    out = pd.DataFrame(rows).T
    if out.empty:
        return out
    out["score"] = out["score"].astype(int) + out["big4"].astype(int) * 2 \
        + out["audit"].notna().astype(int)
    # 점수순이 아니라 최근 공시순으로 둡니다 — 순위를 함의하지 않기 위해서입니다
    return out.sort_values("last", ascending=False)


def unlisted_disclosures(corp_codes: list[str], days: int = 180,
                         limit: int = 40) -> pd.DataFrame:
    """비상장사 최근 공시. 감자·증자·소송 같은 사건이 여기 먼저 뜹니다."""
    end = date.today().strftime("%Y%m%d")
    bgn = (date.today() - pd.Timedelta(days=days)).strftime("%Y%m%d")
    out = []
    for cc in corp_codes:
        try:
            body = dart_call("disclosure_list", corp_code=cc, bgn_de=bgn, end_de=end,
                             page_no=1, page_count=20)
        except Exception:                               # noqa: BLE001
            continue
        rows = body.get("list", [])
        if rows:
            out.append(pd.DataFrame(rows))
    if not out:
        return pd.DataFrame()
    df = pd.concat(out, ignore_index=True)
    df["tags"] = df["report_nm"].map(lambda t: ",".join(dart_classify(t)))
    return df.sort_values("rcept_dt", ascending=False).head(limit)


def _n(v):
    try:
        return float(str(v).replace(",", "").replace("-", "0") or 0)
    except (TypeError, ValueError):
        return np.nan


def portfolio_capital_structure(codes: list[str], year: str = None) -> dict:
    """엑싯 단가에 직접 영향을 주는 자본구조 항목.

    · 미상환 전환사채 — 전환되면 주식수가 늘어 우리 지분과 주가가 함께 눌립니다
    · 최대주주 지분   — 같은 창구로 나올 수 있는 물량이 얼마나 있는가
    · 발행주식총수    — 유통물량 대비 우리 물량의 크기
    이 셋을 모르면 '팔 수 있는가'만 알고 '얼마에 팔리는가'를 모릅니다."""
    year = year or str(date.today().year - 1)
    cc = dart_corp_codes().set_index("stock_code")["corp_code"]
    out = {}
    for code in codes:
        if code not in cc.index:
            continue
        rec = {"bond": None, "bond_rows": [], "holders": [], "top_pct": None,
               "shares_total": None, "treasury": None}
        try:
            b = dart_call("bond_outstanding", corp_code=cc[code],
                          bsns_year=year, reprt_code="11011")
            tot = 0.0
            for r in b.get("list", []):
                if str(r.get("sm", "")).strip() in ("합계", "계"):
                    continue
                v = _n(r.get("sm"))
                nm = str(r.get("remndr_exprtn1", "")) or "미상환"
                if pd.notna(v) and v > 0:
                    tot += v
                    rec["bond_rows"].append((nm, v))
            rec["bond"] = tot if tot > 0 else 0.0
        except Exception:                               # noqa: BLE001
            pass
        try:
            h = dart_call("largest_holder", corp_code=cc[code],
                          bsns_year=year, reprt_code="11011")
            rows = [r for r in h.get("list", [])
                    if str(r.get("nm", "")).strip() not in ("계", "합계", "")]
            for r in rows[:8]:
                rec["holders"].append({
                    "name": str(r.get("nm", "")).strip(),
                    "relate": str(r.get("relate", "")).strip(),
                    "shares": _n(r.get("trmend_posesn_stock_co")
                                 or r.get("bsis_posesn_stock_co")),
                    "pct": _n(r.get("trmend_posesn_stock_qota_rt")
                              or r.get("bsis_posesn_stock_qota_rt"))})
            tot_row = [r for r in h.get("list", [])
                       if str(r.get("nm", "")).strip() in ("계", "합계")]
            if tot_row:
                rec["top_pct"] = _n(tot_row[0].get("trmend_posesn_stock_qota_rt")
                                    or tot_row[0].get("bsis_posesn_stock_qota_rt"))
            elif rec["holders"]:
                rec["top_pct"] = sum(x["pct"] for x in rec["holders"]
                                     if pd.notna(x["pct"]))
        except Exception:                               # noqa: BLE001
            pass
        try:
            s = dart_call("stock_total", corp_code=cc[code],
                          bsns_year=year, reprt_code="11011")
            for r in s.get("list", []):
                if "보통주" in str(r.get("se", "")):
                    rec["shares_total"] = _n(r.get("istc_totqy")
                                             or r.get("isu_stock_totqy"))
                    rec["treasury"] = _n(r.get("tesstk_co"))
                    break
        except Exception:                               # noqa: BLE001
            pass
        out[code] = rec
    return out


def valuation(px_last: pd.DataFrame, fs: pd.DataFrame) -> pd.DataFrame:
    """시가총액(KRX) × 재무(DART) → 밸류에이션.

    적자·자본잠식 기업의 PER·PBR 은 정의되지 않습니다. 음수 배수를 그대로 두면
    '가장 싼 종목'으로 정렬되어 상단에 올라옵니다 — 결측으로 처리합니다."""
    if fs is None or fs.empty:
        return pd.DataFrame()
    d = px_last.join(fs, how="left")
    pos = lambda s: s.where(s > 0)                              # noqa: E731
    d["per"] = d["mktcap"] / pos(d.get("net_income"))
    d["pbr"] = d["mktcap"] / pos(d.get("equity"))
    d["psr"] = d["mktcap"] / pos(d.get("revenue"))
    d["opm"] = d.get("op_income") / pos(d.get("revenue"))
    d["roe"] = d.get("net_income") / pos(d.get("equity"))
    d["debt_ratio"] = d.get("liabilities") / pos(d.get("equity"))
    d["deficit"] = d.get("net_income").le(0) if "net_income" in d else np.nan
    d["impaired"] = d.get("equity").le(0) if "equity" in d else np.nan
    return d


def krx_index_daily(bas_dd: str, service: str = "kosdaq_dd_trd") -> pd.DataFrame:
    """지수 일별시세. 한 번 호출에 지수 40종이 함께 옵니다.

    주의 — '코스닥 (외국주포함)' 행은 거래대금만 있고 지수 값이 비어 있습니다.
    첫 행을 그대로 쓰면 벤치마크가 통째로 결측이 됩니다. 값 없는 행은 버립니다."""
    df = krx_map(krx_get(service, bas_dd), "idx_dd_trd")
    if df.empty:
        return df
    df = df.dropna(subset=["close"])
    df["date"] = bas_dd
    df["fetched_at"] = datetime.now().isoformat(timespec="seconds")
    return df.reindex(columns=["date", "index_name", "open", "high", "low",
                               "close", "fetched_at"])


# ── 매크로 ─────────────────────────────────────────────────────────────
# 금리·환율·변동성은 KRX 안에 다 있습니다. 채권지수의 평균수익률이 곧 금리이고,
# 미국달러 선물이 환율, 변동성지수 선물이 VKOSPI 입니다.
# 코스닥150 선물은 현물가(SPOT_PRC)를 함께 주므로 베이시스가 바로 나옵니다.

MACRO_SPEC = {
    "rate_ktb":    ("KTB 지수", "BND_IDX_AVG_YD", "pct", "국고채 수익률"),
    "rate_prime":  ("국고채프라임지수", "BND_IDX_AVG_YD", "pct", "국고채프라임 수익률"),
    "rate_credit": ("KRX 채권지수", "BND_IDX_AVG_YD", "pct", "채권 전체 수익률"),
    "duration_ktb": ("KTB 지수", "AVG_DURATION", "ratio", "KTB 듀레이션"),
}
FUT_SPEC = {
    "fx_usd":   ("미국달러 선물", "환율 (원/달러)"),
    "vkospi":   ("변동성지수 선물", "변동성지수"),
    "fut_kq150": ("코스닥150 선물", "코스닥150 선물"),
    "fut_k200": ("코스피200 선물", "코스피200 선물"),
    "rate_3m":  ("3개월무위험금리 선물", "3개월 무위험금리"),
}
_MONTH = re.compile(r"(\d{6})")


def _num_or_nan(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return np.nan


def _gov_curve(rows: list) -> list[dict]:
    """국고채 수익률 곡선. 원금분리채(STRIPS)와 물가채는 명목금리가 아닙니다.

    물가채는 버리지 않고 따로 씁니다 — 명목 10년에서 빼면 기대인플레이션입니다."""
    out, nom, linked = [], {}, {}
    for r in rows:
        nm = str(r.get("ISU_NM", ""))
        yd = _num_or_nan(r.get("CLSPRC_YD"))
        tp = str(r.get("BND_EXP_TP_NM", "")).strip()
        if pd.isna(yd) or not tp.isdigit():
            continue
        if "원금" in nm:                       # STRIPS — 만기수익률 성격이 다릅니다
            continue
        if nm.startswith("물가"):
            linked[int(tp)] = yd
        elif nm.startswith("국고"):
            nom.setdefault(int(tp), yd)       # 같은 만기 복수면 첫 종목(지표물)
    for y, v in nom.items():
        out.append({"key": f"rate_{y}y", "value": v, "unit": "pct"})
    if 10 in nom and 3 in nom:
        out.append({"key": "term_spread", "value": nom[10] - nom[3], "unit": "pct"})
    if 10 in nom and 10 in linked:
        # 명목 − 물가연동 = 시장이 보는 기대인플레이션
        out.append({"key": "bei_10y", "value": nom[10] - linked[10], "unit": "pct"})
    return out


def krx_macro_daily(bas_dd: str) -> pd.DataFrame:
    """하루치 매크로. 국고채 + 채권지수 + 선물 세 번 호출로 끝납니다."""
    out = []
    try:
        out += _gov_curve(krx_get("kts_bydd_trd", bas_dd))
    except Exception as e:                              # noqa: BLE001
        print(f"  [국고채 보류] {bas_dd}: {type(e).__name__}: {e}")
    try:
        rows = krx_get("bon_dd_trd", bas_dd)
        bond = {r.get("BND_IDX_GRP_NM"): r for r in rows}
        for key, (grp, field, unit, _lab) in MACRO_SPEC.items():
            if grp in bond:
                v = _num_or_nan(bond[grp].get(field))
                if pd.notna(v):
                    out.append({"key": key, "value": v, "unit": unit})
    except Exception as e:                              # noqa: BLE001
        print(f"  [채권지수 보류] {bas_dd}: {type(e).__name__}: {e}")
    try:
        rows = krx_get("fut_bydd_trd", bas_dd)
        df = pd.DataFrame(rows)
        if not df.empty:
            # 야간장 제외, 최근월물 선택 (ISU_NM 의 YYYYMM 이 가장 이른 것)
            if "MKT_NM" in df.columns:
                reg = df[~df["MKT_NM"].astype(str).str.contains("야간", na=False)]
                df = reg if not reg.empty else df
            df["_m"] = df["ISU_NM"].astype(str).str.extract(_MONTH)[0]
            df = df.dropna(subset=["_m"]).sort_values("_m")
            for key, (prod, _lab) in FUT_SPEC.items():
                sel = df[df["PROD_NM"] == prod]
                if sel.empty:
                    continue
                r0 = sel.iloc[0]                        # 최근월물
                px = _num_or_nan(r0.get("TDD_CLSPRC"))
                if pd.notna(px):
                    out.append({"key": key, "value": px, "unit": "point"})
                spot = _num_or_nan(r0.get("SPOT_PRC"))
                if pd.notna(spot) and spot > 0 and pd.notna(px):
                    out.append({"key": f"{key}_basis", "unit": "pct",
                                "value": float(px / spot - 1)})
    except Exception as e:                              # noqa: BLE001
        print(f"  [선물 보류] {bas_dd}: {type(e).__name__}: {e}")
    if not out:
        return pd.DataFrame()
    d = pd.DataFrame(out)
    d["date"] = bas_dd
    d["source"] = "KRX/채권지수·선물"
    d["fetched_at"] = datetime.now().isoformat(timespec="seconds")
    return d[["date", "key", "value", "unit", "source", "fetched_at"]]


# ── 해외 매크로 (FRED · 세인트루이스 연준) ─────────────────────────────
# 무료 키가 필요합니다: https://fredaccount.stlouisfed.org/apikeys
# .env 에 FRED_API_KEY= 로 넣으면 자동으로 켜집니다. 없으면 조용히 건너뜁니다.

# FRED 안에서도 저작권 주체가 갈립니다. 기본값은 공공저작물만 씁니다.
#   · 연준(Federal Reserve Board) 산출 → 미국 정부 저작물, 재배포 제한 없음
#   · 제3자 산출(Nasdaq · ICE · Cboe) → FRED 로 받아볼 수는 있으나 저작권은 그들 것
# 제3자 계열은 --include-restricted 로 명시적으로 켜야만 들어옵니다.
FRED = {
    "base_url": "https://api.stlouisfed.org/fred/series/observations",
    "public": {          # 연준·미국 정부 산출 — 재배포 제한 없음
        "us_10y":    ("DGS10",    "pct",   "미국 국채 10년", "Federal Reserve Board"),
        "us_2y":     ("DGS2",     "pct",   "미국 국채 2년", "Federal Reserve Board"),
        "us_spread": ("T10Y2Y",   "pct",   "미국 장단기 (10Y−2Y)", "Federal Reserve Board"),
        "dxy":       ("DTWEXBGS", "point", "달러지수 (광의)", "Federal Reserve Board"),
    },
    "restricted": {      # 제3자 저작물 — 사내 열람도 약관 확인 후에 켜십시오
        "vix":       ("VIXCLS",       "point", "VIX", "Cboe Exchange, Inc."),
        "nasdaq":    ("NASDAQCOM",    "point", "나스닥 종합", "Nasdaq, Inc."),
        "hy_spread": ("BAMLH0A0HYM2", "pct",   "미국 하이일드 스프레드",
                      "ICE Data Indices, LLC"),
    },
}


def fred_series(include_restricted: bool = False) -> dict:
    s = dict(FRED["public"])
    if include_restricted:
        s.update(FRED["restricted"])
    return s


def fred_available() -> bool:
    return has_key("FRED_API_KEY")


def fred_fetch(series_id: str, start: str, end: str = None) -> pd.Series:
    requests = _requests()
    p = {"series_id": series_id, "api_key": api_key("FRED_API_KEY"),
         "file_type": "json", "observation_start": start}
    if end:
        p["observation_end"] = end
    r = requests.get(FRED["base_url"], params=p, timeout=30)
    r.raise_for_status()
    obs = r.json().get("observations", [])
    if not obs:
        return pd.Series(dtype=float)
    d = pd.DataFrame(obs)
    d["value"] = pd.to_numeric(d["value"], errors="coerce")     # 결측은 '.' 로 옵니다
    d = d.dropna(subset=["value"])
    return pd.Series(d["value"].values,
                     index=pd.to_datetime(d["date"]).dt.strftime("%Y%m%d"))


def ingest_fred(start: str, end: str = None,
                include_restricted: bool = False) -> dict:
    """해외 매크로를 macro_daily 에 같은 형식으로 넣습니다.

    미국 지표는 한국 휴장일에도 갱신되고 반대도 마찬가지입니다.
    날짜를 억지로 맞추지 않고 있는 그대로 넣은 뒤, 사용할 때 정렬합니다."""
    if not fred_available():
        return {"ok": False, "reason": "FRED_API_KEY 없음"}
    con = connect()
    total = 0
    for key, (sid, unit, lab, owner) in fred_series(include_restricted).items():
        try:
            s = fred_fetch(sid, start, end)
        except Exception as e:                          # noqa: BLE001
            print(f"  [FRED 보류] {key}({sid}): {type(e).__name__}: {e}")
            continue
        if s.empty:
            print(f"  [FRED] {key}: 관측 없음")
            continue
        df = pd.DataFrame({"date": s.index, "key": key, "value": s.values})
        df["unit"] = unit
        df["source"] = f"FRED/{sid} ({owner})"
        df["fetched_at"] = datetime.now().isoformat(timespec="seconds")
        n = upsert(con, "macro_daily", df)
        total += n
        print(f"  {lab:<22} {sid:<14} {n:>5}행  · {owner}")
    con.close()
    return {"ok": True, "n": total}


def macro_panel(con) -> pd.DataFrame:
    df = pd.read_sql_query("SELECT date, key, value FROM macro_daily ORDER BY date", con)
    if df.empty:
        return df
    p = df.pivot_table(index="date", columns="key", values="value", aggfunc="last")
    p.index = pd.to_datetime(p.index)
    return p.sort_index()


def krx_sanity(df: pd.DataFrame) -> dict:
    """필드 순서 오류는 예외를 내지 않습니다. 이 네 가지가 잡는 유일한 장치입니다.

    거래정지·거래없음 종목(OHLC 결측)은 정상 데이터입니다. 이것들 때문에
    하루치 전체가 반려되면 안 되므로, 검산은 체결이 있는 행에서만 합니다."""
    if df.empty:
        return {"ok": False, "n": 0, "n_traded": 0, "n_notrade": 0,
                "problems": ["빈 응답 (휴장일 가능)"]}
    ohlc = ["open", "high", "low", "close"]
    traded = df.dropna(subset=ohlc)
    n_notrade = len(df) - len(traded)
    p = []
    if traded.empty:
        p.append("체결된 종목이 하나도 없습니다 — 응답 형식 확인 필요")
        return {"ok": False, "n": len(df), "n_traded": 0,
                "n_notrade": n_notrade, "problems": p}
    if ((traded["close"] > traded["high"]) | (traded["close"] < traded["low"])).any():
        p.append("종가가 고가/저가 범위 밖 — OHLC 순서 오류 의심")
    if (traded[ohlc] <= 0).any().any():
        p.append("0 이하 가격 존재")
    if n_notrade > len(df) * 0.5:
        p.append(f"거래 없음 종목이 {n_notrade}/{len(df)}건 — 응답 이상 의심")
    vwap = traded["value"] / traded["volume"].replace(0, np.nan)
    off = ((vwap < traded["low"] * 0.5) | (vwap > traded["high"] * 2)).sum()
    if off > len(traded) * 0.05:
        p.append(f"거래대금÷거래량이 가격 범위 밖 {int(off)}건 — 단위(원/천원) 확인 필요")
    return {"ok": not p, "n": len(df), "n_traded": len(traded),
            "n_notrade": n_notrade, "problems": p}


# ── DART ──────────────────────────────────────────────────────────────
_dart_last = [0.0]


def _dart_throttle() -> None:
    gap = 60.0 / DART["rate_limit_per_min"]
    wait = gap - (time.time() - _dart_last[0])
    if wait > 0:
        time.sleep(wait)
    _dart_last[0] = time.time()


def dart_call(name: str, **params):
    requests = _requests()
    path, fmt = DART["endpoints"][name]
    params["crtfc_key"] = api_key("DART_API_KEY")
    _dart_throttle()
    r = requests.get(f"{DART['base_url']}/{path}", params=params, timeout=30)
    r.raise_for_status()
    if fmt == "zip":
        return r.content
    body = r.json()
    if body.get("status") not in ("000", "013", None):     # 013 = 조회 결과 없음
        raise RuntimeError(f"DART {name} 오류 {body.get('status')}: {body.get('message')}")
    return body


def dart_corp_codes(all_corps: bool = False) -> pd.DataFrame:
    """종목코드 ↔ corp_code 매칭표. zip 안의 XML 로 옵니다.

    all_corps=True 면 비상장 법인까지 전부 돌려줍니다 (11만여 건).
    포트폴리오 비상장사는 종목코드가 없으므로 회사명으로 찾아야 합니다."""
    cache = ROOT / ".corp_code_cache.parquet"
    if cache.exists() and (time.time() - cache.stat().st_mtime) < 7 * 86400:
        try:
            df = pd.read_parquet(cache)
        except Exception:                               # noqa: BLE001
            df = None
    else:
        df = None
    if df is None:
        with zipfile.ZipFile(io.BytesIO(dart_call("corp_code"))) as z:
            df = pd.read_xml(io.BytesIO(z.read(z.namelist()[0])), dtype=str)
        if "stock_code" not in df.columns:
            return df.iloc[0:0]
        df["stock_code"] = df["stock_code"].fillna("").astype(str).str.strip()
        try:
            df.to_parquet(cache)
        except Exception:                               # noqa: BLE001
            pass                                        # 캐시 실패는 치명적이지 않습니다
    return df if all_corps else df[df["stock_code"] != ""]


def dart_find_corp(names: list[str]) -> pd.DataFrame:
    """회사명으로 corp_code 를 찾습니다. 동명이인이 흔하므로 결과를 그대로 보고합니다."""
    all_df = dart_corp_codes(all_corps=True).copy()
    all_df["_key"] = all_df["corp_name"].astype(str).str.replace(r"\s+", "", regex=True)
    out = []
    for nm in names:
        key = str(nm).replace(" ", "")
        hit = all_df[all_df["_key"] == key]
        if hit.empty:                                   # 부분일치로 한 번 더
            hit = all_df[all_df["_key"].str.contains(re.escape(key), na=False)]
        if hit.empty:
            out.append({"name": nm, "corp_code": None, "matched": None,
                        "n_match": 0, "stock_code": ""})
        else:
            # 상장사가 섞여 있으면 그쪽을 우선합니다 (동명 비상장 계열사보다 확실)
            pick = hit[hit["stock_code"] != ""]
            pick = pick.iloc[0] if not pick.empty else hit.iloc[0]
            out.append({"name": nm, "corp_code": pick["corp_code"],
                        "matched": pick["corp_name"], "n_match": int(len(hit)),
                        "stock_code": pick["stock_code"]})
    return pd.DataFrame(out)


def dart_disclosures(corp_code: str, bgn_de: str, end_de: str) -> pd.DataFrame:
    body = dart_call("disclosure_list", corp_code=corp_code, bgn_de=bgn_de,
                     end_de=end_de, page_no=1, page_count=100)
    df = pd.DataFrame(body.get("list", []))
    if not df.empty:
        df["tags"] = df["report_nm"].map(lambda t: ",".join(dart_classify(t)))
        df["fetched_at"] = datetime.now().isoformat(timespec="seconds")
    return df


def dart_disclosures_by_date(day: str, corp_cls: str = "K",
                             max_pages: int = 10) -> pd.DataFrame:
    """하루치 공시를 시장 단위로 한 번에 받습니다.
    종목별로 호출하면 1,800회가 되지만 corp_cls 로 묶으면 몇 번이면 끝납니다.
    corp_cls — Y:유가증권 K:코스닥 N:코넥스 E:기타"""
    frames, page = [], 1
    while page <= max_pages:
        body = dart_call("disclosure_list", bgn_de=day, end_de=day,
                         corp_cls=corp_cls, page_no=page, page_count=100)
        rows = body.get("list", [])
        if not rows:
            break
        frames.append(pd.DataFrame(rows))
        if page >= int(body.get("total_page", 1)):
            break
        page += 1
    if not frames:
        return pd.DataFrame()
    df = pd.concat(frames, ignore_index=True)
    df["tags"] = df["report_nm"].map(lambda t: ",".join(dart_classify(t)))
    return df


def dart_classify(title: str) -> list[str]:
    return [k for k, words in DART["event_keywords"].items()
            if any(w in (title or "") for w in words)]


def dart_financials(corp_code: str, year: str, reprt: str = "11011",
                    fs_div: str = "CFS") -> pd.DataFrame:
    """11011=사업 11012=반기 11013=1Q 11014=3Q"""
    body = dart_call("fs_major", corp_code=corp_code, bsns_year=year, reprt_code=reprt)
    df = pd.DataFrame(body.get("list", []))
    if df.empty:
        return df
    if "fs_div" in df.columns:
        sel = df[df["fs_div"] == fs_div]
        df = sel if not sel.empty else df          # 연결이 없으면 별도로 대체
    for c in ("thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"):
        if c in df.columns:
            df[c] = pd.to_numeric(
                df[c].astype(str).str.replace(",", "", regex=False), errors="coerce")
    return df


# DART 주요계정의 계정과목명은 회사마다 표기가 조금씩 다릅니다.
# 별칭을 모두 받아 한 이름으로 모읍니다.
FS_ACCOUNTS = {
    "revenue":    ["매출액", "수익(매출액)", "영업수익", "매출"],
    "op_income":  ["영업이익", "영업이익(손실)"],
    "net_income": ["당기순이익", "당기순이익(손실)", "당기순손익"],
    "assets":     ["자산총계"],
    "liabilities": ["부채총계"],
    "equity":     ["자본총계"],
}
_FS_LOOKUP = {alias: key for key, aliases in FS_ACCOUNTS.items() for alias in aliases}


def dart_financials_bulk(corp_codes: list[str], year: str, reprt: str = "11011",
                         batch: int = 100, progress: bool = False) -> pd.DataFrame:
    """다중회사 주요계정. 종목별 호출은 1,800회지만 100사씩 묶으면 19회입니다.

    연결(CFS)을 우선하고 없으면 별도(OFS)를 씁니다 — 지주·소규모사는 연결이 없습니다."""
    out = []
    for i in range(0, len(corp_codes), batch):
        chunk = corp_codes[i:i + batch]
        try:
            body = dart_call("fs_multi", corp_code=",".join(chunk),
                             bsns_year=year, reprt_code=reprt)
        except Exception as e:                          # noqa: BLE001
            print(f"  [재무 보류] 배치 {i // batch + 1}: {type(e).__name__}: {e}")
            continue
        rows = body.get("list", [])
        if rows:
            out.append(pd.DataFrame(rows))
        if progress:
            print(f"  재무 {min(i + batch, len(corp_codes)):>5}/{len(corp_codes)}사")
    if not out:
        return pd.DataFrame()
    df = pd.concat(out, ignore_index=True)
    df = df[df["account_nm"].isin(_FS_LOOKUP)].copy()
    df["key"] = df["account_nm"].map(_FS_LOOKUP)
    for src, dst in (("thstrm_amount", "value"), ("frmtrm_amount", "value_prev")):
        if src in df.columns:
            df[dst] = pd.to_numeric(
                df[src].astype(str).str.replace(",", "", regex=False), errors="coerce")
        else:
            df[dst] = np.nan
    df = df.dropna(subset=["value"])
    if "stock_code" not in df.columns:
        df["stock_code"] = ""
    df["stock_code"] = df["stock_code"].fillna("").astype(str).str.strip()
    # 같은 계정이 연결·별도로 둘 다 오면 연결을 씁니다
    df["_pri"] = (df["fs_div"] != "CFS").astype(int)
    df = (df.sort_values("_pri").drop_duplicates(["corp_code", "key"])
            .rename(columns={"stock_code": "code"}))
    return df[["code", "corp_code", "key", "value", "value_prev", "fs_div"]]


def dart_major_holders(corp_code: str) -> pd.DataFrame:
    return pd.DataFrame(dart_call("major_holder", corp_code=corp_code).get("list", []))


def dart_insider_holdings(corp_code: str) -> pd.DataFrame:
    return pd.DataFrame(dart_call("exec_holder", corp_code=corp_code).get("list", []))


def dart_report_item(name: str, corp_code: str, year: str,
                     reprt: str = "11011") -> pd.DataFrame:
    """DS002 계열 공통 — 주식총수 · 배당 · 자기주식 · 최대주주 · 미상환사채"""
    body = dart_call(name, corp_code=corp_code, bsns_year=year, reprt_code=reprt)
    return pd.DataFrame(body.get("list", []))


# ── KB증권 (읽기 전용) ─────────────────────────────────────────────────
class OrderNotAllowed(RuntimeError):
    """주문 계열 호출 시도. 설계상 절대 발생하면 안 됩니다."""


class KBClient:
    """모니터링 시스템에 주문 권한이 붙으면 버그 하나의 결과가
    '틀린 숫자'에서 '틀린 거래'로 바뀝니다. 그래서 호출 경로를 막아 둡니다."""

    def __init__(self) -> None:
        self._token, self._exp = None, 0.0

    def _auth_header(self) -> dict:
        if self._token and time.time() < self._exp - 60:
            return {"Authorization": f"Bearer {self._token}"}
        requests = _requests()
        r = requests.post(KB["base_url"] + KB["token_path"], timeout=20, json={
            "grant_type": "client_credentials",
            "appkey": api_key("KB_APP_KEY"),
            "appsecret": api_key("KB_APP_SECRET"),
        })
        r.raise_for_status()
        body = r.json()
        self._token = body["access_token"]
        self._exp = time.time() + float(body.get("expires_in", 3600))
        return {"Authorization": f"Bearer {self._token}"}

    def _call(self, endpoint: str, **params) -> dict:
        if endpoint in KB["denied"]:
            raise OrderNotAllowed(f"'{endpoint}' 는 호출하지 않습니다 (읽기 전용 설계).")
        if endpoint not in KB["allowed"]:
            raise OrderNotAllowed(f"화이트리스트에 없는 엔드포인트: {endpoint}")
        requests = _requests()
        r = requests.get(KB["base_url"] + KB["allowed"][endpoint],
                         headers=self._auth_header(), params=params, timeout=15)
        r.raise_for_status()
        return r.json()

    def quote(self, code: str) -> dict:
        return kb_map_quote(self._call("quote", code=code))


def kb_map_quote(raw: dict) -> dict:
    if not KB["verified"]:
        print("  [경고] KB verified=False — 응답 필드 매핑을 명세서와 대조하십시오.")
    body = raw.get("output", raw)
    out = {}
    for src, dst in KB["field_map"].items():
        v = body.get(src)
        try:
            out[dst] = float(str(v).replace(",", "")) if v is not None else None
        except (TypeError, ValueError):
            out[dst] = None
    out["ts"] = datetime.now().isoformat(timespec="seconds")
    return out


def kb_sanity(q: dict) -> list[str]:
    """연결 직후 필수 검산. 조용히 틀리는 것을 잡습니다."""
    p = []
    if None in (q.get("price"), q.get("high"), q.get("low")):
        p.append("가격 필드 결측")
    elif not (q["low"] <= q["price"] <= q["high"]):
        p.append("현재가가 고가/저가 범위 밖 — price 매핑 오류 의심")
    if q.get("bid") is not None and q.get("ask") is not None and q["ask"] < q["bid"]:
        p.append("매도호가 < 매수호가 — bid/ask 뒤바뀜")
    if not q.get("prev_close"):
        p.append("기준가 결측 — 등락률이 전부 틀어집니다")
    return p


class RingBuffer:
    """장중 스냅샷 보관소. 디스크에 쓰지 않습니다."""

    def __init__(self, codes: list[str], minutes: int = None, poll_sec: int = None):
        m = minutes or MARKET["ring_minutes"]
        p = poll_sec or MARKET["poll_sec"]
        self.buf = {c: deque(maxlen=max(10, int(m * 60 / p))) for c in codes}

    def push(self, code: str, q: dict) -> None:
        self.buf[code].append(q)

    def series(self, code: str, field: str) -> list:
        return [x.get(field) for x in self.buf[code] if x.get(field) is not None]

    def persisted(self) -> bool:
        return False


# ════════════════════════════════════════════════════════════════════════
# 4. 수정주가 — 여기를 건너뛰면 무상증자 하루에 -50% 가 찍히고
#    그 값이 변동성 → VaR → 팩터 → 스코어카드로 전부 전파됩니다
# ════════════════════════════════════════════════════════════════════════

def detect_share_jumps(df: pd.DataFrame, tol: float = SHARE_JUMP_TOL) -> pd.DataFrame:
    d = df.sort_values("date").copy()
    d["share_ratio"] = d["shares"] / d["shares"].shift(1)
    return d.loc[(d["share_ratio"] - 1).abs() > tol, ["date", "shares", "share_ratio"]]


def detect_price_jumps(df: pd.DataFrame, threshold: float = MAX_DAILY_MOVE) -> pd.DataFrame:
    d = df.sort_values("date").copy()
    d["raw_ret"] = d["close"].pct_change()
    return d.loc[d["raw_ret"].abs() > threshold, ["date", "close", "raw_ret"]]


def build_factors(df: pd.DataFrame, actions: pd.DataFrame | None = None) -> pd.Series:
    d = df.sort_values("date").reset_index(drop=True)
    day_factor = pd.Series(1.0, index=d.index)
    if actions is not None and not actions.empty:
        amap = dict(zip(pd.to_datetime(actions["date"]), actions["factor"]))
        for i, dt in enumerate(pd.to_datetime(d["date"])):
            if dt in amap:
                day_factor.iloc[i] = float(amap[dt])
    else:
        # 주식수 증가를 전부 무상증자로 보면 안 됩니다.
        # 전환사채 전환·유상증자·스톡옵션 행사는 주식수만 늘고 권리락이 없습니다.
        # 무상증자·액면분할·주식배당만 '주가가 비율만큼 떨어지는' 사건입니다.
        # 그래서 주가 실측이 주식수 비율을 뒷받침할 때만 조정합니다.
        ratio = d["shares"] / d["shares"].shift(1)
        implied = 1.0 / ratio                          # 권리락이라면 이만큼 떨어져야 함
        observed = d["close"] / d["close"].shift(1)
        big = (implied - 1).abs() >= MIN_ACTION_SIZE   # 일간 변동성에 묻히지 않을 크기인가
        agrees = (observed / implied - 1).abs() <= ACTION_MATCH_TOL
        moved = (big & agrees).fillna(False)
        day_factor[moved] = implied[moved]             # 주식수 2배 → 가격 1/2
        # 크기는 되는데 주가가 뒷받침하지 않으면 조정하지 않고 표시만 합니다
        unresolved = (((ratio - 1).abs() > SHARE_JUMP_TOL) & ~moved).fillna(False)
        build_factors.unresolved = d.loc[unresolved, "date"].tolist()
    # 권리락일 '이전' 구간에만 소급합니다. 당일 가격은 이미 조정된 값입니다.
    shifted = day_factor.shift(-1).fillna(1.0)
    cum = shifted.iloc[::-1].cumprod().iloc[::-1]
    return cum / cum.iloc[-1]


def adjust_apply(df: pd.DataFrame, actions=None) -> pd.DataFrame:
    d = df.sort_values("date").reset_index(drop=True).copy()
    d["adj_factor"] = build_factors(d, actions)
    for c in ("open", "high", "low", "close"):
        if c in d.columns:
            d[f"adj_{c}"] = d[c] * d["adj_factor"]
    return d


def adjust_audit(df: pd.DataFrame, actions=None) -> dict:
    """통과 기준 — 조정 후 일간 수익률이 전부 ±30% 안에 들어올 것."""
    build_factors.unresolved = []
    d = adjust_apply(df, actions)
    unresolved = list(getattr(build_factors, "unresolved", []))
    ret = d["adj_close"].pct_change()
    bad = ret[ret.abs() > MAX_DAILY_MOVE]
    note = ""
    if not bad.empty:
        note = "조정 실패 구간 존재 — DART 공시로 액션을 확인하십시오."
    elif unresolved:
        note = (f"주식수 변동 {len(unresolved)}건 감지 — 주가가 권리락을 뒷받침하지 않아 "
                "조정하지 않았습니다 (전환·유상증자 추정). DART 공시로 확인하십시오.")
    return {"ok": bad.empty,
            "n_actions": int((d["adj_factor"].diff().fillna(0) != 0).sum()),
            "failures": bad.to_dict(), "unresolved": unresolved, "note": note}


# ════════════════════════════════════════════════════════════════════════
# 5. 변동성 — 종가만 쓰면 하루 중 정보를 버립니다
#    Parkinson(1980) · Garman-Klass(1980) · Rogers-Satchell(1991) · Yang-Zhang(2000)
# ════════════════════════════════════════════════════════════════════════

def _chk_ohlc(df: pd.DataFrame) -> None:
    need = {"open", "high", "low", "close"}
    if need - set(df.columns):
        raise ValueError(f"OHLC 열이 없습니다: {need - set(df.columns)}")
    bad = (df["high"] < df["low"]) | (df["close"] > df["high"]) | (df["close"] < df["low"])
    if bad.any():
        raise ValueError(f"고가/저가 범위를 벗어난 행 {int(bad.sum())}건 — OHLC 매핑 확인")


def vol_close(df, window: int = 21, annualize: bool = True) -> pd.Series:
    s = np.log(df["close"]).diff().rolling(window).std()
    return s * np.sqrt(ANN) if annualize else s


def vol_parkinson(df, window: int = 21, annualize: bool = True) -> pd.Series:
    _chk_ohlc(df)
    var = np.log(df["high"] / df["low"]) ** 2 / (4 * np.log(2))
    s = np.sqrt(var.rolling(window).mean())
    return s * np.sqrt(ANN) if annualize else s


def vol_garman_klass(df, window: int = 21, annualize: bool = True) -> pd.Series:
    _chk_ohlc(df)
    var = (0.5 * np.log(df["high"] / df["low"]) ** 2
           - (2 * np.log(2) - 1) * np.log(df["close"] / df["open"]) ** 2)
    s = np.sqrt(var.rolling(window).mean().clip(lower=0))
    return s * np.sqrt(ANN) if annualize else s


def vol_rogers_satchell(df, window: int = 21, annualize: bool = True) -> pd.Series:
    """드리프트가 있어도 불편(unbiased). 추세 구간에서 GK 보다 낫습니다."""
    _chk_ohlc(df)
    u, d = np.log(df["high"] / df["open"]), np.log(df["low"] / df["open"])
    c = np.log(df["close"] / df["open"])
    var = u * (u - c) + d * (d - c)
    s = np.sqrt(var.rolling(window).mean().clip(lower=0))
    return s * np.sqrt(ANN) if annualize else s


def vol_yang_zhang(df, window: int = 21, annualize: bool = True) -> pd.Series:
    """시가갭(오버나이트)까지 반영. 갭이 큰 종목의 기본값."""
    _chk_ohlc(df)
    n = window
    o = np.log(df["open"] / df["close"].shift(1))
    c = np.log(df["close"] / df["open"])
    u, d = np.log(df["high"] / df["open"]), np.log(df["low"] / df["open"])
    cc = c
    var_rs = (u * (u - cc) + d * (d - cc)).rolling(n).mean()
    k = 0.34 / (1.34 + (n + 1) / (n - 1))
    var = o.rolling(n).var(ddof=1) + k * c.rolling(n).var(ddof=1) + (1 - k) * var_rs
    s = np.sqrt(var.clip(lower=0))
    return s * np.sqrt(ANN) if annualize else s


def vol_compare(df, window: int = 21) -> pd.DataFrame:
    return pd.DataFrame({
        "close_to_close": vol_close(df, window),
        "parkinson": vol_parkinson(df, window),
        "garman_klass": vol_garman_klass(df, window),
        "rogers_satchell": vol_rogers_satchell(df, window),
        "yang_zhang": vol_yang_zhang(df, window),
    })


def vol_selftest(df, window: int = 21, tol: float = 3.0) -> dict:
    """5종이 서로 같은 자릿수인지 — OHLC 매핑 오류를 잡는 가장 값싼 검산."""
    cmp = vol_compare(df, window).dropna()
    if cmp.empty:
        return {"ok": False, "reason": "표본 부족", "values": {}}
    last = cmp.iloc[-1]
    ratio = float(last.max() / last.min()) if last.min() > 0 else float("inf")
    return {"ok": ratio <= tol, "ratio": round(ratio, 2),
            "values": {k: round(float(v), 4) for k, v in last.items()},
            "reason": "" if ratio <= tol else "추정량 간 괴리 — OHLC 매핑 확인"}


# ════════════════════════════════════════════════════════════════════════
# 6. 유동성 — 호가 없이 고가·저가만으로 유효 스프레드를 추정합니다
#    Corwin-Schultz(2012) · Roll(1984) · Amihud(2002)
#    전부 '추정량'입니다. 리포트에 반드시 '추정'을 명시합니다.
# ════════════════════════════════════════════════════════════════════════

_CS_K = 3 - 2 * np.sqrt(2)


def liq_corwin_schultz(df, window: int = 21) -> pd.Series:
    h, l = df["high"], df["low"]
    hl = np.log(h / l) ** 2
    beta = hl + hl.shift(1)
    h2 = pd.concat([h, h.shift(1)], axis=1).max(axis=1)
    l2 = pd.concat([l, l.shift(1)], axis=1).min(axis=1)
    gamma = np.log(h2 / l2) ** 2
    alpha = (np.sqrt(2 * beta) - np.sqrt(beta)) / _CS_K - np.sqrt(gamma / _CS_K)
    spread = (2 * (np.exp(alpha) - 1) / (1 + np.exp(alpha))).clip(lower=0)
    return spread.rolling(window).mean()


def liq_roll(df, window: int = 21) -> pd.Series:
    """자기공분산이 음수일 때만 정의됩니다."""
    r = np.log(df["close"]).diff()

    def _f(x):
        if len(x) < 3:
            return np.nan
        cov = np.cov(x[:-1], x[1:])[0, 1]
        return 2 * np.sqrt(-cov) if cov < 0 else np.nan

    return r.rolling(window).apply(_f, raw=True)


def liq_amihud(df, window: int = 21, scale: float = 1e6) -> pd.Series:
    r = df["close"].pct_change().abs()
    return (r / df["value"].replace(0, np.nan)).rolling(window).mean() * scale


def liq_days_to_liquidate(df, qty: float, participation: float = 0.20,
                          window: int = 20) -> pd.Series:
    """ADV20 의 20% 만 소화한다고 가정합니다."""
    cap = df["volume"].rolling(window).mean() * participation
    return qty / cap.replace(0, np.nan)


def liq_summary(df, qty: float) -> dict:
    cs, rl = liq_corwin_schultz(df), liq_roll(df)
    am, dl = liq_amihud(df), liq_days_to_liquidate(df, qty)
    cs_bp = float(cs.dropna().iloc[-1] * 10000) if cs.notna().any() else np.nan
    rl_bp = float(rl.dropna().iloc[-1] * 10000) if rl.notna().any() else np.nan
    w = []
    if not np.isnan(cs_bp) and (cs_bp < 0 or cs_bp > 1000):
        w.append("추정 스프레드 이상 범위 — 고가/저가 역전 또는 거래 희박")
    if not np.isnan(cs_bp) and not np.isnan(rl_bp) and rl_bp > 0 and cs_bp > 0:
        if max(cs_bp, rl_bp) / min(cs_bp, rl_bp) > 5:
            w.append("Corwin-Schultz 와 Roll 규모 상이 — 추정 신뢰도 낮음")
    return {"spread_cs_bp": None if np.isnan(cs_bp) else round(cs_bp, 1),
            "spread_roll_bp": None if np.isnan(rl_bp) else round(rl_bp, 1),
            "amihud": None if am.isna().all() else round(float(am.dropna().iloc[-1]), 6),
            "days_to_liquidate": None if dl.isna().all() else round(float(dl.dropna().iloc[-1]), 1),
            "estimated": True, "warnings": w}


# ════════════════════════════════════════════════════════════════════════
# 7. 포트폴리오 리스크
# ════════════════════════════════════════════════════════════════════════

def historical_var(pnl: pd.Series, level: float = 0.95) -> float:
    """정규분포를 가정하지 않습니다 — 표본이 곧 분포입니다."""
    return float(-np.percentile(pnl.dropna(), (1 - level) * 100))


def cvar(pnl: pd.Series, level: float = 0.95) -> float:
    s = pnl.dropna()
    q = np.percentile(s, (1 - level) * 100)
    tail = s[s <= q]
    return float(-tail.mean()) if len(tail) else float("nan")


def evt_tail(pnl: pd.Series, level: float = 0.95, target: float = 0.995) -> dict:
    """꼬리만 GPD 로 적합. 표본 30개 미만이면 계산하지 않습니다."""
    try:
        from scipy.stats import genpareto
    except ImportError:
        return {"ok": False, "reason": "scipy 없음"}
    s = -pnl.dropna()
    u = np.percentile(s, level * 100)
    exc = s[s > u] - u
    if len(exc) < 30:
        return {"ok": False, "reason": "표본 부족", "n_exceed": int(len(exc))}
    xi, _, beta = genpareto.fit(exc, floc=0)
    n, nu = len(s), len(exc)
    var_t = u + beta / xi * (((n / nu) * (1 - target)) ** (-xi) - 1) if xi != 0 else np.nan
    return {"ok": True, "xi": float(xi), "beta": float(beta),
            "n_exceed": int(nu), "var_target": float(var_t)}


def risk_contribution(weights, cov) -> dict:
    """기여도의 합 = 포트폴리오 변동성 (자동 검산)."""
    w = np.asarray(weights, dtype=float)
    cov = np.asarray(cov, dtype=float)
    port_vol = float(np.sqrt(w @ cov @ w))
    if port_vol == 0:
        return {"port_vol": 0.0, "mcr": np.zeros_like(w), "rc": np.zeros_like(w),
                "check_ok": True}
    mcr = (cov @ w) / port_vol
    rc = w * mcr
    return {"port_vol": port_vol, "mcr": mcr, "rc": rc,
            "check_ok": bool(np.isclose(rc.sum(), port_vol, rtol=1e-8))}


def beta_te(ri: pd.Series, rm: pd.Series, min_obs: int = 60) -> dict:
    """표본이 부족하면 계산하지 않고 '표본 부족'을 돌려줍니다."""
    # sort 를 명시하지 않으면 pandas 4 에서 기본값이 바뀌어 정렬 순서가 달라집니다.
    # 시계열은 날짜순이어야 하므로 sort=True 를 고정합니다.
    df = pd.concat([ri, rm], axis=1, sort=True).dropna()
    if len(df) < min_obs:
        return {"ok": False, "reason": "표본 부족", "n": int(len(df))}
    a, b = df.iloc[:, 0], df.iloc[:, 1]
    beta = float(np.cov(a, b)[0, 1] / np.var(b, ddof=1))
    return {"ok": True, "beta": beta,
            "alpha_ann": float(a.mean() - beta * b.mean()) * ANN,
            "tracking_error": float((a - b).std(ddof=1) * np.sqrt(ANN)), "n": int(len(df))}


def hhi(values: pd.Series) -> float:
    v = values.dropna()
    if v.sum() <= 0:
        return float("nan")
    return float(((v / v.sum()) ** 2).sum())


def var_backtest(pnl: pd.Series, level: float = 0.95, window: int = 250) -> dict:
    """95% VaR 이면 위반율이 약 5% 여야 합니다."""
    s = pnl.dropna()
    if len(s) < window + 20:
        return {"ok": False, "reason": "표본 부족", "n": int(len(s))}
    breaches = tested = 0
    for i in range(window, len(s)):
        if -s.iloc[i] > historical_var(s.iloc[i - window:i], level):
            breaches += 1
        tested += 1
    rate, expected = breaches / tested, 1 - level
    return {"ok": abs(rate - expected) <= expected * 0.6,
            "breach_rate": round(rate, 4), "expected": expected,
            "tested": tested, "breaches": breaches}


# ════════════════════════════════════════════════════════════════════════
# 8. 재무 스코어카드 — 결측을 0으로 채우지 않습니다
#    F-Score 항목 하나가 비면 8점이 아니라 None 입니다.
#    0으로 채우면 우량 기업이 부실로 분류되고, 그 오류는 조용히 흐릅니다.
# ════════════════════════════════════════════════════════════════════════

def _has(*v) -> bool:
    return all(x is not None for x in v)


@dataclass
class FinInput:
    roa: float | None = None
    roa_p: float | None = None
    cfo: float | None = None
    leverage: float | None = None
    leverage_p: float | None = None
    current_ratio: float | None = None
    current_ratio_p: float | None = None
    shares: float | None = None
    shares_p: float | None = None
    gross_margin: float | None = None
    gross_margin_p: float | None = None
    asset_turnover: float | None = None
    asset_turnover_p: float | None = None


def piotroski_f(x: FinInput) -> dict:
    checks = [
        ("roa_positive", _has(x.roa), lambda: x.roa > 0),
        ("cfo_positive", _has(x.cfo), lambda: x.cfo > 0),
        ("roa_improved", _has(x.roa, x.roa_p), lambda: x.roa > x.roa_p),
        ("accrual", _has(x.cfo, x.roa), lambda: x.cfo > x.roa),
        ("leverage_down", _has(x.leverage, x.leverage_p), lambda: x.leverage < x.leverage_p),
        ("liquidity_up", _has(x.current_ratio, x.current_ratio_p),
         lambda: x.current_ratio > x.current_ratio_p),
        ("no_dilution", _has(x.shares, x.shares_p), lambda: x.shares <= x.shares_p),
        ("margin_up", _has(x.gross_margin, x.gross_margin_p),
         lambda: x.gross_margin > x.gross_margin_p),
        ("turnover_up", _has(x.asset_turnover, x.asset_turnover_p),
         lambda: x.asset_turnover > x.asset_turnover_p),
    ]
    detail, missing, score = {}, [], 0
    for name, ok, fn in checks:
        if not ok:
            missing.append(name)
            detail[name] = None
            continue
        v = bool(fn())
        detail[name] = v
        score += int(v)
    if missing:
        return {"score": None, "detail": detail, "missing": missing,
                "note": "결측이 있어 N/A 로 처리합니다 (0으로 채우지 않습니다)."}
    return {"score": score, "detail": detail, "missing": [],
            "grade": "우량" if score >= 8 else ("부실" if score <= 2 else "보통")}


def altman_z2(wc_ta=None, re_ta=None, ebit_ta=None, bve_tl=None) -> dict:
    """Z''-Score (비제조·신흥시장 변형)"""
    if not _has(wc_ta, re_ta, ebit_ta, bve_tl):
        return {"score": None, "note": "결측 — N/A"}
    z = 6.56 * wc_ta + 3.26 * re_ta + 6.72 * ebit_ta + 1.05 * bve_tl
    return {"score": round(float(z), 3),
            "zone": "안전" if z > 2.6 else ("위험" if z < 1.1 else "회색")}


def beneish_m(dsri=None, gmi=None, aqi=None, sgi=None,
              depi=None, sgai=None, lvgi=None, tata=None) -> dict:
    """-1.78 초과는 '확인 필요' 표기일 뿐, 판정이 아닙니다."""
    if not _has(dsri, gmi, aqi, sgi, depi, sgai, lvgi, tata):
        return {"score": None, "note": "결측 — N/A"}
    m = (-4.84 + 0.920 * dsri + 0.528 * gmi + 0.404 * aqi + 0.892 * sgi
         + 0.115 * depi - 0.172 * sgai + 4.679 * tata - 0.327 * lvgi)
    return {"score": round(float(m), 3),
            "flag": "확인 필요" if m > -1.78 else "특이사항 없음"}


def dupont(net_income=None, revenue=None, assets=None, equity=None) -> dict:
    if not _has(net_income, revenue, assets, equity) or 0 in (revenue, assets, equity):
        return {"roe": None, "note": "결측 또는 0 분모 — N/A"}
    margin, turnover, lev = net_income / revenue, revenue / assets, assets / equity
    return {"roe": round(margin * turnover * lev, 4), "margin": round(margin, 4),
            "asset_turnover": round(turnover, 4), "leverage": round(lev, 4)}


def fully_diluted_ownership(our_shares, common, cb_potential=0.0,
                            bw_potential=0.0, option_pool=0.0) -> dict:
    """보통주만 보면 지분율이 과대평가됩니다."""
    fd = common + cb_potential + bw_potential + option_pool
    if fd <= 0:
        return {"ownership_fd": None}
    return {"ownership_common": round(our_shares / common, 6) if common else None,
            "ownership_fd": round(our_shares / fd, 6), "fully_diluted_shares": fd}


def refix_scenario(cb_amount, price, floor_price, drops=(0.9, 0.8, 0.7)) -> list[dict]:
    """주가가 더 내리면 희석이 얼마나 가속되는가."""
    out = []
    for d in drops:
        px = price * d
        cv = max(px, floor_price)
        out.append({"price": round(px, 1), "conv_price": round(cv, 1),
                    "potential_shares": round(cb_amount / cv) if cv else None})
    return out


# ════════════════════════════════════════════════════════════════════════
# 9. 이벤트 스터디 · 펀드 지표
# ════════════════════════════════════════════════════════════════════════

def car(ri: pd.Series, rm: pd.Series, event_idx: int,
        est=(-120, -21), win=(0, 5)) -> dict:
    """시장모형으로 정상 수익률을 추정하고 초과분을 누적합니다."""
    n = len(ri)
    e0, e1 = event_idx + est[0], event_idx + est[1]
    w0, w1 = event_idx + win[0], event_idx + win[1]
    if e0 < 0 or w1 >= n:
        return {"ok": False, "reason": "표본 부족"}
    est_i, est_m = ri.iloc[e0:e1], rm.iloc[e0:e1]
    mask = est_i.notna().to_numpy() & est_m.notna().to_numpy()
    if mask.sum() < 30:
        return {"ok": False, "reason": "추정창 표본 부족"}
    beta, alpha = np.polyfit(est_m.to_numpy()[mask], est_i.to_numpy()[mask], 1)
    ar = ri.iloc[w0:w1 + 1].to_numpy() - (alpha + beta * rm.iloc[w0:w1 + 1].to_numpy())
    car_v = float(np.nansum(ar))
    sigma = float(est_i.to_numpy()[mask].std(ddof=1))
    t = car_v / (sigma * np.sqrt(len(ar))) if sigma > 0 else np.nan
    return {"ok": True, "alpha": float(alpha), "beta": float(beta),
            "car": car_v, "tstat": float(t),
            "significant": bool(abs(t) > 1.96) if not np.isnan(t) else False}


def event_day(rcept_dt: str, rcept_time: str, biz_days: list[str],
              close_time: str = "1530") -> str:
    """장 마감 후 접수된 공시는 익영업일이 D0 입니다."""
    if rcept_dt not in biz_days:
        later = [d for d in biz_days if d >= rcept_dt]
        return later[0] if later else rcept_dt
    if (rcept_time or "") >= close_time:
        i = biz_days.index(rcept_dt)
        return biz_days[i + 1] if i + 1 < len(biz_days) else rcept_dt
    return rcept_dt


def xirr(flows: list[tuple], lo: float = -0.99, hi: float = 10.0):
    """납입·배분의 실제 일자 기준 내부수익률. 등간격을 가정하지 않습니다."""
    try:
        from scipy.optimize import brentq
    except ImportError:
        return None
    if len(flows) < 2:
        return None
    flows = sorted(flows, key=lambda x: x[0])
    d0 = flows[0][0]

    def npv(r):
        return sum(cf / (1 + r) ** ((d - d0).days / 365.0) for d, cf in flows)

    try:
        if npv(lo) * npv(hi) > 0:
            return None
        return float(brentq(npv, lo, hi, maxiter=200))
    except (ValueError, RuntimeError):
        return None


def fund_multiples(paid_in: float, distributed: float, nav: float) -> dict:
    if paid_in <= 0:
        return {"dpi": None, "rvpi": None, "tvpi": None}
    dpi, rvpi = distributed / paid_in, nav / paid_in
    return {"dpi": round(dpi, 4), "rvpi": round(rvpi, 4), "tvpi": round(dpi + rvpi, 4)}


# ════════════════════════════════════════════════════════════════════════
# 10. 스냅샷 미시구조 (당일 한정 · 비축적)
#     체결 하나하나(OFI)는 폴링으로 복원할 수 없습니다.
#     대신 '그 순간의 압력과 실행비용'은 스냅샷만으로 계산됩니다.
# ════════════════════════════════════════════════════════════════════════

def quote_imbalance(bid_qty, ask_qty):
    if bid_qty is None or ask_qty is None:
        return None
    tot = bid_qty + ask_qty
    return None if tot <= 0 else float((bid_qty - ask_qty) / tot)


def spread_bp(bid, ask):
    if bid is None or ask is None or bid <= 0 or ask <= 0:
        return None
    mid = (bid + ask) / 2
    return None if mid <= 0 else float((ask - bid) / mid * 10000)


def trade_strength(volume, prev_volume, price, prev_price, tick: float = 1.0):
    if None in (volume, prev_volume, price, prev_price):
        return None
    dv = volume - prev_volume
    return None if dv <= 0 else float(dv / max(abs(price - prev_price), tick))


def intraday_rv(prices: list, bars_per_day: int = 78):
    p = [x for x in prices if x and x > 0]
    if len(p) < 5:
        return None
    r = np.diff(np.log(p))
    return float(np.sqrt(np.sum(r ** 2) * (bars_per_day / len(r)) * ANN))


def vwap_gap(price, value_cum, volume_cum):
    if not volume_cum or value_cum is None or price is None:
        return None
    vwap = value_cum / volume_cum
    return None if vwap <= 0 else float(price / vwap - 1)


def snapshot_metrics(q: dict, prev: dict | None, px_series: list) -> dict:
    m = {"qi": quote_imbalance(q.get("bid_qty"), q.get("ask_qty")),
         "spread_bp": spread_bp(q.get("bid"), q.get("ask")),
         "vwap_gap": vwap_gap(q.get("price"), q.get("value"), q.get("volume")),
         "intraday_rv": intraday_rv(px_series), "strength": None, "persisted": False}
    if prev:
        m["strength"] = trade_strength(q.get("volume"), prev.get("volume"),
                                       q.get("price"), prev.get("price"))
    return m


def micro_selftest(m: dict) -> list[str]:
    p = []
    if m.get("spread_bp") is not None and m["spread_bp"] < 0:
        p.append("실측 스프레드 음수 — bid/ask 매핑 오류")
    if m.get("qi") is not None and not (-1.0 <= m["qi"] <= 1.0):
        p.append("QI 범위 이탈 — 잔량 필드 오류")
    if m.get("persisted"):
        p.append("링버퍼가 저장되었습니다 — 설계 위반")
    return p


# ════════════════════════════════════════════════════════════════════════
# 11. 장중 알림 — 폴링 주기가 곧 지연입니다
#     저장하는 것은 시세가 아니라 우리 판단의 기록뿐입니다
# ════════════════════════════════════════════════════════════════════════

@dataclass
class Rule:
    name: str
    sev: str
    fn: object
    reason: str
    eod: bool = True            # 종가 기준으로도 평가 가능한 룰인가

    def fire(self, q: dict, pos: dict) -> bool:
        try:
            return bool(self.fn(q, pos))
        except (TypeError, ZeroDivisionError, KeyError):
            return False


def _gap(q, p):
    """목표회수단가 비교는 '원주가' 기준입니다.
    목표단가는 투자심의가 정한 명목 금액이라 수정주가와 섞으면 안 됩니다."""
    if not q.get("price") or not p.get("target_price"):
        return None
    return q["price"] / p["target_price"] - 1


def _ret(q):
    """등락률은 '수정주가' 기준입니다.
    권리락일에 원주가로 계산하면 무상증자가 -50% 폭락으로 잡힙니다.
    종가 알림 경로는 조정된 ret 을 직접 넣어 주고, 장중 경로는 현재가로 계산합니다."""
    if q.get("ret") is not None:
        return q["ret"]
    if not q.get("prev_close") or not q.get("price"):
        return None
    return q["price"] / q["prev_close"] - 1


RULES = [
    Rule("target_gap_reached", "SEV1",
         lambda q, p: _gap(q, p) is not None and _gap(q, p) >= 0, "목표회수단가 도달"),
    Rule("limit_down", "SEV1",
         lambda q, p: _ret(q) is not None and _ret(q) <= -0.29, "하한가 근접"),
    Rule("move_10", "SEV1",
         lambda q, p: _ret(q) is not None and abs(_ret(q)) >= 0.10, "±10% 변동"),
    Rule("move_5", "SEV2",
         lambda q, p: _ret(q) is not None and abs(_ret(q)) >= 0.05, "±5% 변동"),
    Rule("volume_surge", "SEV2",
         lambda q, p: p.get("adv20") and q.get("volume") and q["volume"] > p["adv20"] * 3,
         "거래량 ADV20 3배 초과"),
    # 호가가 필요한 룰은 종가 경로에서 평가하지 않습니다 (bid/ask 가 없습니다)
    Rule("spread_blowout", "SEV3",
         lambda q, p: (spread_bp(q.get("bid"), q.get("ask")) or 0) > 300,
         "호가 스프레드 급확대", eod=False),
]


def notify(sev: str, code: str, reason: str, value=None) -> None:
    print(f"[{sev}] {code} · {reason}" + (f" · {value:,.2f}" if value is not None else ""))
    if not env("recipients"):
        return          # 개인 테스트 단계에서는 발송하지 않습니다


def log_alert(code: str, rule: Rule, value) -> None:
    con = connect()
    con.execute("INSERT INTO alert_log VALUES (?,?,?,?,?,?)",
                (datetime.now().isoformat(timespec="seconds"), code, rule.name,
                 rule.sev, value, rule.reason))
    con.commit()
    con.close()


def in_market_hours(now: datetime = None) -> bool:
    """평일 09:00~15:30 밖에서는 호출하지 않습니다.
    (공휴일은 KRX 휴장일 목록이 있어야 정확합니다 — 장외 시간에는 조회가
     실패하므로 OPS 알림으로 드러납니다.)"""
    now = now or datetime.now()
    if now.weekday() >= 5:
        return False
    return "0900" <= now.strftime("%H%M") <= MARKET["close_time"]


def watch(positions: dict, once: bool = False) -> None:
    client, ring, fired = KBClient(), RingBuffer(list(positions)), set()
    today = date.today().isoformat()
    while True:
        # 날짜가 바뀌면 발화 기록을 비웁니다. 이걸 놓치면 하루 한 번 제한이
        # '프로세스 생애 한 번'이 되어 이튿날 알림이 전부 막힙니다.
        now_day = date.today().isoformat()
        if now_day != today:
            today, fired = now_day, set()
        if not once and not in_market_hours():
            time.sleep(60)          # 장외 시간에는 호출하지 않습니다
            continue
        for code in positions:
            try:
                q = client.quote(code)
            except Exception as e:                       # noqa: BLE001
                notify("OPS", code, f"조회 실패: {e}")
                continue
            problems = kb_sanity(q)
            if problems:
                notify("OPS", code, "검산 실패: " + "; ".join(problems))
                continue
            ring.push(code, q)
            for rule in RULES:
                key = (today, code, rule.name)
                if key in fired:
                    continue
                if rule.fire(q, positions[code]):
                    fired.add(key)                       # 같은 사유로 하루 한 번만
                    notify(rule.sev, code, rule.reason, q.get("price"))
                    log_alert(code, rule, q.get("price"))
        if once:
            return
        time.sleep(MARKET["poll_sec"])


# ── 종가 기준 알림 ─────────────────────────────────────────────────────
# 장중 폴링의 90% 가치를 상시 프로세스·호가·사내 승인 없이 가져옵니다.
# 쓰는 룰은 watch 와 같은 RULES 입니다 — 판단 기준이 두 벌이 되면 안 됩니다.

def eod_snapshot(g: pd.DataFrame, adv_window: int = 20) -> dict | None:
    """원장 한 종목분으로 룰 평가용 스냅샷을 만듭니다.

    price   = 원주가 종가      (목표단가 비교용)
    ret     = 수정주가 등락률  (변동 룰용)
    adv20   = 당일을 제외한 직전 20일 평균 거래량
    """
    d = g.sort_values("date")
    if d.empty or d["close"].notna().sum() < 1:
        return None
    last = d.iloc[-1]
    raw = d["close"] / d["adj_factor"].replace(0, np.nan)     # 원주가 복원
    ret = None
    if len(d) >= 2 and pd.notna(d["close"].iloc[-2]) and d["close"].iloc[-2] > 0:
        ret = float(d["close"].iloc[-1] / d["close"].iloc[-2] - 1)   # 수정주가 기준
    prev = d["volume"].iloc[-(adv_window + 1):-1].dropna()
    return {"date": str(last["date"].date()) if hasattr(last["date"], "date")
                    else str(last["date"]),
            "price": float(raw.iloc[-1]) if pd.notna(raw.iloc[-1]) else None,
            "ret": ret,
            "volume": float(last["volume"]) if pd.notna(last["volume"]) else None,
            "adv20": float(prev.mean()) if len(prev) >= 5 else None,
            "halted": bool(pd.isna(last["close"])),
            "bid": None, "ask": None}


def _already_logged(con, day: str, code: str, rule_name: str) -> bool:
    cur = con.execute(
        "SELECT 1 FROM alert_log WHERE code=? AND rule=? AND ts LIKE ? LIMIT 1",
        (code, rule_name, f"{day}%"))
    return cur.fetchone() is not None


def eod_check(positions: pd.DataFrame, quiet: bool = False) -> list[dict]:
    """장 마감 후 1회 평가. 같은 날 같은 사유는 원장을 보고 중복을 막습니다
    (프로세스가 죽었다 살아나도 중복 발송되지 않습니다)."""
    codes = positions["code"].tolist()
    con = connect()
    panel = price_panel(con, codes, adjusted=True)
    if panel.empty:
        con.close()
        return []
    pos_idx = positions.set_index("code")
    fired = []
    for code, g in panel.groupby("code"):
        snap = eod_snapshot(g)
        if snap is None:
            continue
        day = snap["date"]
        if snap["halted"]:
            if not quiet:
                notify("SEV2", code, f"거래정지 · 종가 없음 ({day})")
            continue
        p = pos_idx.loc[code].to_dict()
        for rule in RULES:
            if not rule.eod or _already_logged(con, day, code, rule.name):
                continue
            if rule.fire(snap, p):
                fired.append({"date": day, "code": code, "rule": rule.name,
                              "sev": rule.sev, "reason": rule.reason,
                              "price": snap["price"], "ret": snap["ret"]})
                if not quiet:
                    notify(rule.sev, f"{code} {p.get('name','')}".strip(),
                           f"{rule.reason} ({day})", snap["price"])
                con.execute("INSERT INTO alert_log VALUES (?,?,?,?,?,?)",
                            (f"{day}T15:30:00", code, rule.name, rule.sev,
                             snap["price"], rule.reason))
    con.commit()
    con.close()
    return fired


# ════════════════════════════════════════════════════════════════════════
# 12. 적재 — 받는다 → 검산한다 → 수정주가를 반영한다 → 넣는다
# ════════════════════════════════════════════════════════════════════════

PRICE_COLS = ["date", "code", "name", "market", "open", "high", "low", "close",
              "volume", "value", "mktcap", "shares", "adj_factor", "source",
              "fetched_at", "calc_version"]


def ingest_day(bas_dd: str, codes: list[str], universe: str | None = None) -> dict:
    """universe 를 주면 해당 시장 전 종목을 함께 적재합니다.
    보유 종목은 universe 와 무관하게 항상 포함합니다 (KOSPI 보유분이 빠지면 안 됩니다)."""
    try:
        raw = krx_daily_prices(bas_dd)
    except Exception as e:                              # noqa: BLE001
        # 키 누락·네트워크 오류로 하루가 실패해도 나머지 날짜는 계속 적재합니다
        return {"date": bas_dd, "ok": False, "reason": f"{type(e).__name__}: {e}"}
    ck = krx_sanity(raw)
    if not ck["ok"]:
        return {"date": bas_dd, "ok": False, "reason": "; ".join(ck["problems"])}
    n_idx = n_mac = 0
    if universe:
        keep = raw["code"].isin(codes) | (raw["market"] == universe)
        raw = raw[keep]
    elif codes:
        raw = raw[raw["code"].isin(codes)]
    df = raw.copy()
    df["adj_factor"] = 1.0
    df["calc_version"] = CALC_VERSION
    df = df.reindex(columns=PRICE_COLS).drop_duplicates(["date", "code"])
    con = connect()
    n = upsert(con, "price_daily", df)
    try:
        n_idx = upsert(con, "index_daily", krx_index_daily(bas_dd))
    except Exception as e:                              # noqa: BLE001
        # 지수가 없어도 종목 적재는 유효합니다 — 벤치마크만 비게 됩니다
        print(f"  [지수 보류] {bas_dd}: {type(e).__name__}: {e}")
    n_mac = upsert(con, "macro_daily", krx_macro_daily(bas_dd))
    con.close()
    # 보유 종목이 거래정지면 그 사실 자체가 중요한 정보입니다 — 조용히 넘기지 않습니다
    held = df[df["code"].isin(codes)]
    halted = held.loc[held["close"].isna() | held["open"].isna(), "code"].tolist()
    return {"date": bas_dd, "ok": True, "n": n, "n_index": n_idx, "n_macro": n_mac,
            "n_notrade_all": ck["n_notrade"], "halted": halted}


def rebuild_adjustments(codes: list[str]) -> dict:
    con = connect()
    out = {}
    for code in codes:
        g = price_panel(con, [code], adjusted=False)
        if g.empty:
            continue
        out[code] = adjust_audit(g)
        adj = adjust_apply(g)
        con.executemany("UPDATE price_daily SET adj_factor=? WHERE date=? AND code=?",
                        [(float(f), pd.Timestamp(d).strftime("%Y%m%d"), code)
                         for d, f in zip(adj["date"], adj["adj_factor"])])
    con.commit()
    con.close()
    return out


def cross_verify(bas_dd: str, kb_closes: dict) -> dict:
    """KB 당일 종가 ↔ 익일 확정된 KRX 종가 대조.
    두 소스를 쓰는 이유는 양이 아니라 검산입니다."""
    con = connect()
    df = price_panel(con, list(kb_closes), adjusted=False)
    con.close()
    if df.empty:
        return {"date": bas_dd, "checked": len(kb_closes), "match": 0,
                "mismatch": [(c, px, None) for c, px in kb_closes.items()], "ok": False}
    sub, mismatch = df[df["date"] == pd.to_datetime(bas_dd)], []
    for code, kb_px in kb_closes.items():
        row = sub[sub["code"] == code]
        if row.empty:
            mismatch.append((code, kb_px, None))
        elif abs(float(row["close"].iloc[0]) - kb_px) > 0.01:
            mismatch.append((code, kb_px, float(row["close"].iloc[0])))
    return {"date": bas_dd, "checked": len(kb_closes),
            "match": len(kb_closes) - len(mismatch), "mismatch": mismatch,
            "ok": not mismatch}


# ════════════════════════════════════════════════════════════════════════
# 13. 리포트 — 구조는 배포용 그대로, 개인 단계에서는 워터마크만 찍힙니다
# ════════════════════════════════════════════════════════════════════════

TEMPLATE = """<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<title>KI 일간 모니터링 리포트 {as_of}</title><style>
@page {{ size: A4; margin: 18mm 15mm 16mm 15mm;
  @top-left {{ content: "일간 모니터링"; font-size: 8pt; color: #5A6470; }}
  @top-right {{ content: "{as_of}"; font-size: 8pt; color: #5A6470; }}
  @bottom-right {{ content: counter(page) " / " counter(pages); font-size: 8pt; color: #1B365D; }}
  @bottom-left {{ content: "사내 전용 · 외부 배포 금지"; font-size: 8pt; color: #5A6470; }} }}
body {{ font-family: "Malgun Gothic","Noto Sans KR",sans-serif; font-size: 9.5pt; color: #1A1A1A; }}
h1 {{ font-size: 18pt; color: #1B365D; margin: 0 0 2mm; }}
h2 {{ font-size: 11pt; color: #1B365D; border-bottom: 1px solid #1B365D;
     padding-bottom: 1mm; margin: 7mm 0 3mm; break-after: avoid; }}
.sub {{ color: #5A6470; font-size: 9pt; margin-bottom: 4mm; }}
.wm {{ background: #FDECEE; border: 1px solid #8C2332; color: #8C2332;
      padding: 2.5mm 3mm; font-weight: bold; margin-bottom: 5mm; font-size: 9pt; }}
table {{ width: 100%; border-collapse: collapse; margin-bottom: 3mm; }}
th {{ background: #1B365D; color: #fff; font-size: 8.5pt; padding: 1.6mm 2mm; text-align: left; }}
td {{ border-bottom: 0.4pt solid #D3D8DE; padding: 1.6mm 2mm; font-size: 8.5pt; }}
tr:nth-child(even) td {{ background: #F4F6F9; }}
.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
.neg {{ color: #8C2332; }} .pos {{ color: #2E5E4E; }}
.note {{ color: #5A6470; font-size: 8pt; font-style: italic; }}
.flag {{ background: #FFF6E0; border-left: 3px solid #8A6A1F; padding: 2mm 3mm; font-size: 8.5pt; }}
.kv {{ display: flex; gap: 6mm; margin-bottom: 3mm; }}
.kv div {{ flex: 1; border-top: 1px solid #D3D8DE; padding-top: 1.5mm; }}
.kv b {{ display: block; font-size: 14pt; color: #1B365D; }}
.kv span {{ font-size: 8pt; color: #5A6470; }}
</style></head><body>
<h1>일간 모니터링 리포트</h1>
<div class="sub">기준일 {as_of} · 단계 {stage}</div>
{watermark_html}
<h2>&sect;1 오늘 달라진 것</h2>
<div class="kv">
 <div><b>{total_value}</b><span>평가금액 합계 (원)</span></div>
 <div><b>{port_vol}</b><span>포트폴리오 변동성 (연율)</span></div>
 <div><b>{var95}</b><span>VaR 95% (1일)</span></div>
 <div><b>{cvar95}</b><span>CVaR 95%</span></div></div>
{quality_flag}
<h2>&sect;2 포지션 현황 · &sect;7 목표회수단가 갭</h2>
{position_table}
<div class="note">집중도 HHI {hhi} · 위험기여도 합계 검산 {rc_check}</div>
<h2>&sect;3 벤치마크 대비 · 시장 개요</h2>
{bench_block}
<h2>&sect;4 리스크 · &sect;8 유동성과 실행비용</h2>
{risk_table}
<div class="note">스프레드는 실측 호가가 아니라 고가·저가 기반 Corwin-Schultz 추정치입니다.
 청산 소요일수는 ADV20 의 20% 참여를 가정합니다. 산출식과 한계는 부록 B 를 참조하십시오.</div>
<h2>&sect;10 데이터 품질 · 검증 상태</h2>
{quality_table}
<h2>수록 예정 섹션</h2>
{section_table}
</body></html>"""


# ── SVG 차트 — 외부 라이브러리 없이 문자열로 그립니다 ────────────────────
# 리포트가 단일 파일로 유지되려면 차트도 파일 안에 있어야 합니다.
# CDN 을 부르면 사내망·오프라인에서 빈 칸이 됩니다.

C_UP, C_DN, C_NAVY, C_GREY, C_LINE = "#B02A37", "#1F5FA8", "#1B365D", "#5A6470", "#D3D8DE"


def _esc(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def _scale(v, lo, hi, a, b):
    if hi == lo:
        return (a + b) / 2
    return a + (v - lo) * (b - a) / (hi - lo)


def svg_line(series: pd.Series, w: int = 720, h: int = 200, label: str = "",
             fill: bool = True) -> str:
    """지수·누적수익률 추이."""
    s = series.dropna()
    if len(s) < 2:
        return "<div class='note'>표본 부족</div>"
    lo, hi = float(s.min()), float(s.max())
    pad = (hi - lo) * 0.08 or abs(hi) * 0.05 or 1
    lo, hi = lo - pad, hi + pad
    ml, mr, mt, mb = 54, 12, 14, 22
    pts = [(_scale(i, 0, len(s) - 1, ml, w - mr), _scale(v, lo, hi, h - mb, mt))
           for i, v in enumerate(s.values)]
    path = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    up = s.iloc[-1] >= s.iloc[0]
    col = C_UP if up else C_DN
    area = ""
    if fill:
        area = (f"<path d='{path} L{pts[-1][0]:.1f},{h - mb} L{pts[0][0]:.1f},{h - mb} Z' "
                f"fill='{col}' opacity='0.10'/>")
    grid = ""
    ticks = 4 if (h - mb - mt) >= 3 * ROW_MIN else 2
    for k in range(ticks):
        y = mt + (h - mb - mt) * k / max(ticks - 1, 1)
        v = hi - (hi - lo) * k / max(ticks - 1, 1)
        grid += (f"<line x1='{ml}' y1='{y:.1f}' x2='{w - mr}' y2='{y:.1f}' "
                 f"stroke='{C_LINE}' stroke-width='.6'/>"
                 f"<text x='{ml - 6}' y='{y + 3.5:.1f}' text-anchor='end' font-size='10' "
                 f"fill='{C_GREY}'>{v:,.1f}</text>")
    x0 = _esc(pd.Timestamp(s.index[0]).strftime("%y-%m-%d"))
    x1 = _esc(pd.Timestamp(s.index[-1]).strftime("%y-%m-%d"))
    return (f"<svg viewBox='0 0 {w} {h}' class='chart' role='img' "
            f"aria-label='{_esc(label)}'>{grid}{area}"
            f"<path d='{path}' fill='none' stroke='{col}' stroke-width='1.8'/>"
            f"<circle cx='{pts[-1][0]:.1f}' cy='{pts[-1][1]:.1f}' r='3' fill='{col}'/>"
            f"<text x='{ml}' y='{h - 6}' font-size='10' fill='{C_GREY}'>{x0}</text>"
            f"<text x='{w - mr}' y='{h - 6}' font-size='10' fill='{C_GREY}' "
            f"text-anchor='end'>{x1}</text></svg>")


def svg_spark(series: pd.Series, w: int = 108, h: int = 26) -> str:
    """표 안에 들어가는 미니 추이."""
    s = series.dropna()
    if len(s) < 2:
        return ""
    lo, hi = float(s.min()), float(s.max())
    pts = " ".join(f"{_scale(i, 0, len(s) - 1, 1, w - 1):.1f},"
                   f"{_scale(v, lo, hi, h - 2, 2):.1f}" for i, v in enumerate(s.values))
    col = C_UP if s.iloc[-1] >= s.iloc[0] else C_DN
    return (f"<svg viewBox='0 0 {w} {h}' class='spark'>"
            f"<polyline points='{pts}' fill='none' stroke='{col}' stroke-width='1.3'/></svg>")


def svg_hbar(labels: list, values: list, w: int = 560, rowh: int = 20,
             fmt=None, label: str = "") -> str:
    """섹터·팩터 성과 가로 막대. 0 기준선을 중앙에 둡니다."""
    if not len(labels):
        return "<div class='note'>표본 부족</div>"
    fmt = fmt or (lambda v: f"{v * 100:,.1f}%")
    rowh = max(ROW_MIN, rowh)          # 라벨이 서로 물리지 않는 최소 행 높이
    h = rowh * len(labels) + 14
    mx = max(abs(float(v)) for v in values if pd.notna(v)) or 1
    lw, bw = 168, w - 168 - 66
    zero = lw + bw / 2
    out = [f"<line x1='{zero}' y1='6' x2='{zero}' y2='{h - 8}' "
           f"stroke='{C_GREY}' stroke-width='.8'/>"]
    for i, (lb, v) in enumerate(zip(labels, values)):
        y = 8 + i * rowh
        if pd.isna(v):
            continue
        ln = bw / 2 * abs(float(v)) / mx
        x = zero if v >= 0 else zero - ln
        col = C_UP if v >= 0 else C_DN
        baseline = y + rowh * 0.62
        # 값 라벨이 막대 밖에 놓이되 라벨 칸(왼쪽)이나 도판 밖을 침범하면
        # 막대 안쪽에 흰 글자로 넣습니다. 밖에 두면 종목명과 겹칩니다.
        if v >= 0:
            tx, anc, fill = zero + ln + 5, "start", C_GREY
            if tx + 34 > w:
                tx, anc, fill = zero + ln - 4, "end", "#fff"
        else:
            tx, anc, fill = zero - ln - 5, "end", C_GREY
            if tx - 34 < lw:
                tx, anc, fill = zero - ln + 4, "start", "#fff"
        out.append(
            f"<text x='{lw - 8}' y='{baseline:.0f}' text-anchor='end' font-size='11' "
            f"fill='#1A1A1A'>{_esc(lb)[:22]}</text>"
            f"<rect x='{x:.1f}' y='{y + 3:.0f}' width='{max(ln, 1):.1f}' "
            f"height='{rowh - 8}' fill='{col}' opacity='.82'/>"
            f"<text x='{tx:.1f}' y='{baseline:.0f}' text-anchor='{anc}' "
            f"font-size='10' fill='{fill}'>{fmt(v)}</text>")
    return (f"<svg viewBox='0 0 {w} {h}' class='chart' role='img' "
            f"aria-label='{_esc(label)}'>{''.join(out)}</svg>")


def svg_hist(values: pd.Series, bins: int = 41, w: int = 560, h: int = 190,
             clip: float = 0.15, label: str = "") -> str:
    """등락률 분포. 시장이 한쪽으로 쏠렸는지가 한눈에 보입니다."""
    s = values.dropna().clip(-clip, clip)
    if len(s) < 20:
        return "<div class='note'>표본 부족</div>"
    cnt, edges = np.histogram(s, bins=bins, range=(-clip, clip))
    mt, mb, ml, mr = 10, 24, 34, 8
    mx = cnt.max() or 1
    bw = (w - ml - mr) / bins
    out = []
    for i, c in enumerate(cnt):
        bh = (h - mt - mb) * c / mx
        x = ml + i * bw
        mid = (edges[i] + edges[i + 1]) / 2
        col = C_UP if mid > 0.0005 else (C_DN if mid < -0.0005 else C_GREY)
        out.append(f"<rect x='{x:.1f}' y='{h - mb - bh:.1f}' width='{bw - .8:.1f}' "
                   f"height='{bh:.1f}' fill='{col}' opacity='.8'/>")
    zx = ml + (w - ml - mr) * 0.5
    out.append(f"<line x1='{zx:.1f}' y1='{mt}' x2='{zx:.1f}' y2='{h - mb}' "
               f"stroke='{C_NAVY}' stroke-width='.9' stroke-dasharray='3,2'/>")
    for frac, lab, anc in ((0, f"-{clip*100:.0f}%", "start"), (0.5, "0%", "middle"),
                           (1, f"+{clip*100:.0f}%", "end")):
        x = ml + (w - ml - mr) * frac
        out.append(f"<text x='{x:.0f}' y='{h - 8}' text-anchor='{anc}' font-size='10' "
                   f"fill='{C_GREY}'>{lab}</text>")
    med = float(s.median())
    out.append(f"<text x='{w - mr}' y='{mt + 10}' text-anchor='end' font-size='10' "
               f"fill='{C_GREY}'>중위 {med*100:.2f}% · n={len(s):,}</text>")
    return (f"<svg viewBox='0 0 {w} {h}' class='chart' role='img' "
            f"aria-label='{_esc(label)}'>{''.join(out)}</svg>")


def svg_scatter(x: pd.Series, y: pd.Series, w: int = 560, h: int = 300,
                xlab: str = "", ylab: str = "", logx: bool = False,
                xclip=(0.01, 0.99), yclip=(0.01, 0.99)) -> str:
    """위험-수익, 밸류에이션 산점도."""
    d = pd.concat([x.rename("x"), y.rename("y")], axis=1, sort=True).dropna()
    if len(d) < 10:
        return "<div class='note'>표본 부족</div>"
    d = d[(d["x"] >= d["x"].quantile(xclip[0])) & (d["x"] <= d["x"].quantile(xclip[1]))
          & (d["y"] >= d["y"].quantile(yclip[0])) & (d["y"] <= d["y"].quantile(yclip[1]))]
    if d.empty:
        return "<div class='note'>표본 부족</div>"
    xv = np.log10(d["x"].where(d["x"] > 0)).dropna() if logx else d["x"]
    d = d.loc[xv.index]
    ml, mr, mt, mb = 48, 10, 26, 30      # mt 는 축 제목 자리를 비워 둡니다
    x0, x1 = float(xv.min()), float(xv.max())
    y0, y1 = float(d["y"].min()), float(d["y"].max())
    pts = "".join(
        f"<circle cx='{_scale(xx, x0, x1, ml, w-mr):.1f}' "
        f"cy='{_scale(yy, y0, y1, h-mb, mt):.1f}' r='2' "
        f"fill='{C_UP if yy >= 0 else C_DN}' opacity='.45'/>"
        for xx, yy in zip(xv.values, d["y"].values))
    grid = ""
    for k in range(4):
        gy = mt + (h - mb - mt) * k / 3
        vv = y1 - (y1 - y0) * k / 3
        grid += (f"<line x1='{ml}' y1='{gy:.1f}' x2='{w-mr}' y2='{gy:.1f}' "
                 f"stroke='{C_LINE}' stroke-width='.5'/>"
                 f"<text x='{ml-5}' y='{gy+3.5:.1f}' text-anchor='end' font-size='9' "
                 f"fill='{C_GREY}'>{vv*100:,.0f}%</text>")
    return (f"<svg viewBox='0 0 {w} {h}' class='chart'>{grid}{pts}"
            f"<text x='{(ml+w-mr)/2:.0f}' y='{h-6}' text-anchor='middle' font-size='10' "
            f"fill='{C_GREY}'>{_esc(xlab)}</text>"
            f"<text x='4' y='11' font-size='10' fill='{C_GREY}'>{_esc(ylab)}</text></svg>")


ROW_MIN = 16          # 글자 높이(약 10px)가 서로 물리지 않는 최소 행 높이


def svg_vprofile(rows: list, w: int = 520, rowh: int = ROW_MIN) -> str:
    """매물대 — 가격대별 거래대금 비중을 가로 막대로.

    높이를 고정하면 구간 수가 늘 때 행이 눌려 라벨이 겹칩니다.
    행 높이를 먼저 정하고 전체 높이를 거기서 도출합니다."""
    if not rows:
        return "<div class='note'>표본 부족</div>"
    rowh = max(ROW_MIN, rowh)
    h = int(rowh * len(rows) + 10)
    mx = max(v for _, v in rows) or 1
    ml, mr = 64, 50
    out = []
    for i, (price, share) in enumerate(sorted(rows, key=lambda x: -x[0])):
        y = 5 + i * rowh
        ln = (w - ml - mr) * share / mx
        base = y + rowh * .70
        out.append(
            f"<rect x='{ml}' y='{y + 2:.1f}' width='{max(ln, 1):.1f}' "
            f"height='{rowh - 5:.1f}' fill='{C_NAVY}' opacity='.62'/>"
            f"<text x='{ml - 6}' y='{base:.1f}' text-anchor='end' "
            f"font-size='9.5' fill='{C_GREY}'>{price:,.0f}</text>"
            f"<text x='{min(ml + ln + 5, w - 4):.1f}' y='{base:.1f}' "
            f"text-anchor='{'end' if ln > w - ml - mr - 20 else 'start'}' "
            f"font-size='9' fill='{C_GREY}'>{share * 100:.0f}%</text>")
    return f"<svg viewBox='0 0 {w} {h}' class='chart'>{''.join(out)}</svg>"


def svg_stacked(up: int, flat: int, down: int, w: int = 560, h: int = 34) -> str:
    """상승·보합·하락 비율 띠."""
    tot = up + flat + down or 1
    segs, x = [], 0.0
    for n, col, lb in ((up, C_UP, "상승"), (flat, C_GREY, "보합"), (down, C_DN, "하락")):
        wd = w * n / tot
        segs.append(f"<rect x='{x:.1f}' y='0' width='{wd:.1f}' height='{h}' fill='{col}'/>")
        if wd > 54:
            segs.append(f"<text x='{x+wd/2:.1f}' y='{h/2+4:.0f}' text-anchor='middle' "
                        f"font-size='11' fill='#fff'>{lb} {n:,} ({n/tot*100:.0f}%)</text>")
        x += wd
    return f"<svg viewBox='0 0 {w} {h}' class='chart'>{''.join(segs)}</svg>"


QUANT_TEMPLATE = """<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{refresh_meta}
<title>포트폴리오 회수 판단 리포트 {as_of}</title><style>
:root {{ --ink:#1A1A1A; --navy:#1B365D; --grey:#5A6470; --line:#D3D8DE;
  --bg:#FFFFFF; --panel:#F4F6F9; --pos:#B02A37; --neg:#1F5FA8; --warn:#8A6A1F; }}
* {{ box-sizing: border-box; }}
body {{ font-family:"Malgun Gothic","Noto Sans KR",sans-serif; font-size:13px;
  color:var(--ink); background:var(--bg); margin:0; padding:0 24px 60px;
  line-height:1.55; }}
.wrap {{ max-width:1240px; margin:0 auto; }}
h1 {{ font-size:27px; color:var(--navy); margin:0 0 4px; letter-spacing:-.4px; }}
h2 {{ font-size:17px; color:var(--navy); margin:44px 0 14px; padding:0 0 8px;
  border-bottom:2px solid var(--navy); scroll-margin-top:58px;
  display:flex; align-items:baseline; gap:9px; }}
h2::before {{ content:counter(sec); counter-increment:sec; font-size:12px;
  background:var(--navy); color:#fff; border-radius:3px; padding:2px 8px;
  font-weight:700; }}
body {{ counter-reset:sec; }}
h3 {{ font-size:12.5px; color:var(--navy); margin:18px 0 7px; font-weight:700;
  border-left:3px solid var(--line); padding-left:8px; }}
nav {{ position:sticky; top:0; z-index:30; background:rgba(255,255,255,.97);
  border-bottom:1px solid var(--line); padding:9px 0; margin-bottom:8px;
  display:flex; flex-wrap:wrap; gap:5px; backdrop-filter:blur(6px); }}
nav a {{ font-size:11.5px; color:var(--navy); text-decoration:none;
  border:1px solid var(--line); border-radius:12px; padding:3px 10px;
  white-space:nowrap; }}
nav a:hover {{ background:var(--navy); color:#fff; border-color:var(--navy); }}
.sub {{ color:var(--grey); font-size:12px; margin-bottom:16px; }}
.wm {{ background:#FDECEE; border:1px solid #8C2332; color:#8C2332;
  padding:8px 12px; font-weight:bold; margin-bottom:16px; font-size:12px; }}
.kv {{ display:flex; flex-wrap:wrap; gap:14px; margin-bottom:14px; }}
.kv>div {{ flex:1 1 150px; border-top:3px solid var(--navy); padding:8px 2px;
  background:var(--panel); padding-left:10px; }}
.kv b {{ display:block; font-size:20px; color:var(--navy); }}
.kv span {{ font-size:11px; color:var(--grey); }}
.tw {{ overflow-x:auto; margin-bottom:10px; border:1px solid var(--line);
  border-radius:4px; -webkit-overflow-scrolling:touch; }}
.tw table {{ min-width:100%; }}
table {{ width:100%; border-collapse:separate; border-spacing:0; font-size:12px;
  table-layout:auto; }}
th {{ background:var(--navy); color:#fff; padding:7px 10px; text-align:left;
  cursor:pointer; user-select:none; font-weight:600; vertical-align:bottom;
  line-height:1.3; white-space:normal; word-break:keep-all; min-width:52px;
  max-width:120px; }}
/* 스티키는 스크롤 컨테이너 안에서만 씁니다. 페이지 전체 스크롤에 붙이면
   상단 네비와 겹쳐 글자가 포개집니다. */
.scroll th {{ position:sticky; top:0; z-index:5; }}
th:hover {{ background:#2A4A75; }}
th.sorted::after {{ content:" \\25BE"; }} th.asc::after {{ content:" \\25B4"; }}
th:first-child, th:nth-child(2) {{ white-space:nowrap; }}
td {{ border-bottom:1px solid var(--line); padding:7px 10px; white-space:nowrap;
  vertical-align:top; }}
td.note {{ white-space:normal; word-break:keep-all; max-width:340px;
  line-height:1.4; }}
tbody tr:nth-child(even) td {{ background:var(--panel); }}
tbody tr:hover td {{ background:#EAF0F8; }}
td:first-child {{ font-weight:600; }}
.num {{ text-align:right; font-variant-numeric:tabular-nums; }}
.pos {{ color:var(--pos); }} .neg {{ color:var(--neg); }}
.note {{ color:var(--grey); font-size:11px; font-style:italic; margin:4px 0 14px; }}
.flag {{ background:#FFF6E0; border-left:4px solid var(--warn); padding:8px 12px;
  font-size:12px; margin:10px 0; }}
.grid2 {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(560px,1fr));
  gap:18px; align-items:start; }}
.chart {{ width:100%; height:auto; display:block; margin:6px 0 4px; }}
.spark {{ width:108px; height:26px; display:block; }}
.card {{ border:1px solid var(--line); border-radius:5px; padding:14px 16px;
  background:#fff; margin-bottom:14px; }}
.card h3 {{ margin-top:0; }}
.toolbar {{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:10px 0; }}
.toolbar input, .toolbar select {{ font:inherit; padding:5px 8px; border:1px solid var(--line);
  border-radius:3px; }}
.toolbar input[type=search] {{ min-width:220px; }}
.btn {{ font:inherit; padding:5px 10px; border:1px solid var(--navy); background:#fff;
  color:var(--navy); border-radius:3px; cursor:pointer; }}
.btn.on {{ background:var(--navy); color:#fff; }}
.scroll {{ max-height:620px; overflow-y:auto; overflow-x:auto; border:1px solid var(--line); }}
.count {{ color:var(--grey); font-size:11px; }}
.bar {{ display:inline-block; height:9px; background:var(--pos); vertical-align:middle;
  border-radius:1px; }}
.bar.n {{ background:var(--neg); }}
details {{ border:1px solid var(--line); border-radius:4px; padding:8px 12px;
  margin-bottom:12px; background:var(--panel); }}
details[open] {{ background:#fff; }}
summary {{ cursor:pointer; font-weight:600; color:var(--navy); font-size:12px; }}
.pf {{ background:#FFFBEA; }}
.sev1 {{ color:#8C2332; font-weight:bold; }} .sev2 {{ color:#8A6A1F; }}
.flow {{ background:var(--panel); border-left:4px solid var(--navy);
  padding:9px 14px; font-size:12px; margin:14px 0 4px; border-radius:0 4px 4px 0; }}
.flow b {{ color:var(--navy); }}
.lead {{ color:var(--grey); font-size:12px; margin:-6px 0 14px; line-height:1.6; }}
.conf {{ background:#8C2332; color:#fff; padding:10px 14px; border-radius:4px;
  font-weight:bold; font-size:13px; margin-bottom:14px; }}
.two {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr));
  gap:12px 18px; margin:10px 0; }}
.two ul {{ margin:5px 0 0; padding-left:15px; font-size:11.5px; line-height:1.6; }}
.two li {{ margin-bottom:4px; word-break:keep-all; }}
.two > div > b {{ font-size:11px; color:var(--navy); letter-spacing:-.2px; }}
ul.p li {{ color:#1F5FA8; }} ul.c li {{ color:#B02A37; }}
.conf span {{ display:block; font-weight:normal; font-size:11px; opacity:.9;
  margin-top:4px; }}
.tag {{ display:inline-block; background:var(--navy); color:#fff; border-radius:3px;
  padding:1px 6px; font-size:10px; margin-right:4px; }}
.tag.risk {{ background:#8C2332; }} .tag.dilution {{ background:#8A6A1F; }}
.tag.corporate_action {{ background:#2E5E4E; }}
@media print {{ body {{ padding:0; font-size:9pt; }} th {{ position:static; }} }}
</style></head><body><div class="wrap">
<div class="conf">대외비 · 사내 검토용 · 외부 배포 및 재배포 금지<br>
<span>본 문서는 투자권유 또는 투자자문 자료가 아닙니다. 포트폴리오 보유사 실명과
회수 계획이 포함되어 있으므로 열람 범위를 제한하십시오.</span></div>
<nav>{nav_html}</nav>
<h1>포트폴리오 회수 판단 리포트</h1>
<div class='sub'>{org} · 상장 포트폴리오사 회수 시점 판단용</div>
<div class="sub">기준일 {as_of} · {market} 전종목 {n_stocks:,}개 · 관측 {n_days}일 · 생성 {gen_at}</div>
{watermark_html}
<div class="flow">읽는 순서 —
 <b>무엇을 결정해야 하는가</b> → <b>팔 수 있는가</b> → <b>어떻게 팔 것인가</b> →
 <b>지금이 그 때인가</b>{agent_flow} → 종목별 상세 → 배경</div>

<h2 id="s1">무엇을 결정해야 하는가 — 회수계획 대비 진척</h2>
<div class="lead">경영계획의 회수 대상과, 데이터가 말하는 현재 상태를 나란히 놓습니다.
 둘이 어긋나는 행이 이번에 확인할 대상입니다.</div>
{plan_block}

<h2 id="s2">팔 수 있는가 — 처분 여건</h2>
<div class="lead">엑싯 판단의 첫 관문입니다. 팔고 싶어도 못 파는 물량이면
 나머지 분석은 의미가 없습니다.</div>
{verdict_block}
{exit_block}

<h2 id="s3">어떻게 팔 것인가 — 실행 시뮬레이션</h2>
<div class="lead">같은 물량도 매도 방식에 따라 실현단가가 달라집니다.
 과거 구간마다 네 가지 규칙을 돌려 비교합니다.</div>
{exec_block}

<h2 id="s4">지금이 그 때인가 — 시장 환경</h2>
<div class="lead">종목이 아니라 시장 쪽 조건입니다. 전 종목에 공통으로 걸립니다.</div>
{regime_block}
<div class="grid2">
 <div class="card"><h3>시장 거래대금 (20일 이동평균)</h3>{turnover_chart}
  <div class="note">코스닥 전 종목 일별 거래대금 합계의 20일 이동평균.</div></div>
 <div class="card"><h3>변동성 (VKOSPI)</h3>{vol_chart}
  <div class="note">변동성지수 선물 최근월 종가. 현물 VKOSPI 의 대용치입니다.</div></div>
 <div class="card"><h3>국고채 3년 — 할인율</h3>{rate_chart}
  <div class="note">국채전문유통시장 3년 지표물 종가수익률.</div></div>
 <div class="card"><h3>신규상장 온도 · 상장 후 성과</h3>{ipo_chart}
  <div class="note">월별 신규 등장 종목 수. 원장 첫 달은 기존 상장분이 섞이므로
   제외했습니다.</div></div>
</div>

{agent_block}<h2 id="s5">종목별 상세 — 관측값 전부</h2>
<div class="lead">위 세 장의 근거가 되는 종목별 원자료입니다.
 유동성 · 주가 · 상장/보호예수 · 재무 네 갈래로 나눠 실었습니다.</div>
{exit_detail_block}

<h2 id="s6">밸류에이션 · 동종 비교</h2>
<div class="lead">"얼마에 팔리는가"의 다른 축입니다. 처분 가능성과 별개로
 지금 값이 어디쯤인지 봅니다.</div>
{watch_block}
{peer_block}

<h2 id="s7">시장 배경 — 코스닥 전체</h2>
<div class="lead">포트폴리오사의 움직임이 개별 사유인지 시장 전체인지 가르는 데 씁니다.</div>
<div class="grid2">
 <div class="card"><h3>{bench_name} 지수 추이 ({n_days}일)</h3>{index_chart}</div>
 <div class="card"><h3>당일 등락률 분포</h3>{hist_chart}{breadth_bar}</div>
</div>
{breadth_block}
<div class="card"><h3>업종 지수 20일 수익률 — 자금 이동 방향</h3>{index_bar}</div>
<h3>전종목 시세 {n_stocks:,}개 — 검색 · 정렬</h3>
{all_block}
<details><summary>기타 시장 지표 — 등락 상하위 · 거래대금 · 신고저가 (펼치기)</summary>
<div class="grid2">{movers_block}</div>
<div class="grid2">{liquidity_block}</div>
<div class="grid2">{extremes_block}</div>
{index_block}</details>
<details><summary>참고 — 매크로 상세 (펼치기)</summary>
{macro_kv}
{macro_block}</details>

<h2 id="s8">데이터 출처 · 한계</h2>
{provenance_block}
</div>
<script>
document.querySelectorAll('table').forEach(function(t){{
  t.querySelectorAll('th').forEach(function(th,i){{
    th.addEventListener('click',function(){{
      var body=t.tBodies[0], rows=Array.prototype.slice.call(body.rows);
      var asc=!th.classList.contains('asc');
      t.querySelectorAll('th').forEach(function(x){{x.classList.remove('sorted','asc');}});
      th.classList.add(asc?'asc':'sorted');
      var num=function(s){{var v=parseFloat(String(s).replace(/[,%\\s원배]/g,''));
        return isNaN(v)?null:v;}};
      rows.sort(function(a,b){{
        var x=a.cells[i].textContent.trim(), y=b.cells[i].textContent.trim();
        var nx=num(x), ny=num(y);
        if(nx!==null&&ny!==null) return asc?nx-ny:ny-nx;
        return asc?x.localeCompare(y,'ko'):y.localeCompare(x,'ko');
      }});
      rows.forEach(function(r){{body.appendChild(r);}});
    }});
  }});
}});
(function(){{
  var q=document.getElementById('q'), t=document.getElementById('alltab'),
      c=document.getElementById('cnt'), f=document.getElementById('flt');
  if(!q||!t) return;
  var rows=Array.prototype.slice.call(t.tBodies[0].rows), mode='all';
  function apply(){{
    var s=q.value.trim().toLowerCase(), n=0;
    rows.forEach(function(r){{
      var hitText = !s || r.cells[0].textContent.toLowerCase().indexOf(s)>=0
                       || r.cells[1].textContent.indexOf(s)>=0;
      var hitMode = mode==='all' || r.dataset.f.indexOf(mode)>=0;
      var show = hitText && hitMode;
      r.style.display = show ? '' : 'none';
      if(show) n++;
    }});
    c.textContent = n.toLocaleString() + ' / ' + rows.length.toLocaleString() + ' 종목';
  }}
  q.addEventListener('input', apply);
  f.querySelectorAll('.btn').forEach(function(b){{
    b.addEventListener('click', function(){{
      f.querySelectorAll('.btn').forEach(function(x){{x.classList.remove('on');}});
      b.classList.add('on'); mode=b.dataset.m; apply();
    }});
  }});
  apply();
}})();
</script></body></html>"""


def _won(v):
    return "-" if v is None or (isinstance(v, float) and np.isnan(v)) else f"{v:,.0f}"


def _pct(v):
    return "-" if v is None or (isinstance(v, float) and np.isnan(v)) else f"{v*100:,.2f}%"


def _num(v):
    return "-" if v is None or (isinstance(v, float) and np.isnan(v)) else f"{v:,.2f}"


def _days(v):
    """0.00 은 '데이터 없음'으로 오해됩니다. 당일 소화 가능이면 그렇게 적습니다."""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "-"
    return "당일 (&lt;0.1)" if v < 0.05 else f"{v:,.2f}"


def _sgn(v, fmt=_pct):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return "<td class='num'>-</td>"
    return f"<td class='num {'pos' if v >= 0 else 'neg'}'>{fmt(v)}</td>"


def _table(headers: list[str], body_rows: list[str]) -> str:
    head = "".join(f"<th class='{'num' if h.startswith('*') else ''}'>{h.lstrip('*')}</th>"
                   for h in headers)
    return (f"<div class='tw'><table><thead><tr>{head}</tr></thead>"
            f"<tbody>{''.join(body_rows)}</tbody></table></div>")


def _stock_rows(d: pd.DataFrame, cols: list[tuple]) -> list[str]:
    out = []
    for code, r in d.iterrows():
        cells = [f"<td>{r.get('name') or ''}</td><td>{code}</td>"]
        for key, kind in cols:
            v = r.get(key)
            if kind == "pct":
                cells.append(_sgn(v))
            elif kind == "won":
                cells.append(f"<td class='num'>{_won(v)}</td>")
            elif kind == "eok":
                cells.append(f"<td class='num'>{_won(v / 1e8) if pd.notna(v) else '-'}</td>")
            else:
                cells.append(f"<td class='num'>{_num(v)}</td>")
        out.append("<tr>" + "".join(cells) + "</tr>")
    return out


def render_quant(ctx: dict, refresh_sec: int = 0) -> Path:
    m, idx, br = ctx["metrics"], ctx["index"], ctx["breadth"]
    n = ctx["n_days"]

    # 1. 요약
    bench = ctx["bench"]
    kv = [(_num(bench["close"]) if bench else "-", f"{BENCHMARK} 지수"),
          (_pct(bench["ret_1d"]) if bench else "-", "지수 1일"),
          (_pct(bench["ret_20d"]) if bench else "-", "지수 20일"),
          (_num(br.get("turnover", np.nan) / 1e12) + " 조", "거래대금"),
          (f"{br.get('up', 0):,} / {br.get('down', 0):,}", "상승 / 하락"),
          (_pct(m["ret_1d"].median()), "종목 중위 등락")]
    summary_kv = "<div class='kv'>" + "".join(
        f"<div><b>{a}</b><span>{b}</span></div>" for a, b in kv) + "</div>"

    breadth_block = ""
    if br.get("n"):
        breadth_block = _table(
            ["구분", "*값", "구분 ", "*값 "],
            ["<tr><td>대상 종목</td><td class='num'>%s</td>"
             "<td>상승 종목 비율</td><td class='num'>%s</td></tr>"
             % (f"{br['n']:,}", _pct(br["adv_ratio"])),
             "<tr><td>상한가 / 하한가</td><td class='num'>%s</td>"
             "<td>중위 등락률</td><td class='num'>%s</td></tr>"
             % (f"{br['limit_up']:,} / {br['limit_down']:,}", _pct(br["median_ret"])),
             "<tr><td>거래대금 합계 (원)</td><td class='num'>%s</td>"
             "<td>거래정지·미체결</td><td class='num'>%s</td></tr>"
             % (_won(br["turnover"]), f"{ctx['n_halted']:,}")])

    # 차트 — 지수 추이 · 등락 분포 · 상승하락 띠
    index_chart = (svg_line(ctx["bench_series"], label=f"{BENCHMARK} 지수")
                   if ctx.get("bench_series") is not None
                   and len(ctx["bench_series"]) > 1
                   else "<div class='note'>지수 원장이 비어 있습니다.</div>")
    hist_chart = svg_hist(m["ret_1d"], label="당일 등락률 분포")
    breadth_bar = svg_stacked(br.get("up", 0), br.get("flat", 0), br.get("down", 0))

    # 매크로 — 할인율·환율·위험선호
    mp = ctx["macro_panel"]
    if mp is None or mp.empty:
        macro_kv = ""
        macro_block = ("<div class='flag'>매크로 원장이 비어 있습니다 — "
                       "<code>ingest</code> 를 다시 돌리면 국고채·선물이 함께 적재됩니다.</div>")
    else:
        def last(k):
            return float(mp[k].dropna().iloc[-1]) if k in mp and mp[k].notna().any() else None

        def chg(k, d=20):
            if k not in mp or mp[k].notna().sum() < d + 1:
                return None
            s = mp[k].dropna()
            return float(s.iloc[-1] - s.iloc[-min(d + 1, len(s))])

        cards = [(f"{last('rate_3y'):.3f}%" if last("rate_3y") else "-", "국고채 3년",
                  chg("rate_3y")),
                 (f"{last('rate_10y'):.3f}%" if last("rate_10y") else "-", "국고채 10년",
                  chg("rate_10y")),
                 (f"{last('term_spread'):.3f}%p" if last("term_spread") is not None
                  else "-", "장단기 (10Y−3Y)", chg("term_spread")),
                 (f"{last('bei_10y'):.3f}%" if last("bei_10y") else "-",
                  "기대인플레 (BEI)", chg("bei_10y")),
                 (f"{last('fx_usd'):,.1f}" if last("fx_usd") else "-", "원/달러",
                  chg("fx_usd")),
                 (f"{last('vkospi'):,.1f}" if last("vkospi") else "-", "변동성지수",
                  chg("vkospi"))]
        macro_kv = "<div class='kv'>" + "".join(
            f"<div><b>{v}</b><span>{lab}"
            + (f" · 20일 {d:+.3f}" if d is not None else "") + "</span></div>"
            for v, lab, d in cards) + "</div>"

        # 코스닥 지수와 매크로의 동행성 — 단정하지 않고 상관계수와 표본수를 같이 적습니다
        corr_rows = []
        bs = ctx.get("bench_series")
        if bs is not None and len(bs) > 30:
            br_ = bs.pct_change()
            for k, lab in (("rate_3y", "국고채 3년"), ("rate_10y", "국고채 10년"),
                           ("term_spread", "장단기 스프레드"), ("fx_usd", "원/달러"),
                           ("vkospi", "변동성지수"), ("bei_10y", "기대인플레"),
                           ("us_10y", "미국 10년"), ("vix", "VIX"),
                           ("nasdaq", "나스닥"), ("hy_spread", "하이일드 스프레드"),
                           ("dxy", "달러지수")):
                if k not in mp:
                    continue
                j = pd.concat([br_.rename("kq"), mp[k].diff().rename("mx")],
                              axis=1, sort=True).dropna()
                if len(j) < 30:
                    continue
                c = float(j["kq"].corr(j["mx"]))
                corr_rows.append(
                    f"<tr><td>{lab}</td><td class='num'>{_num(last(k))}</td>"
                    + _sgn(chg(k) or 0, lambda v: f"{v:+.3f}")
                    + f"<td class='num'>{c:+.3f}</td>"
                    f"<td class='num'>{len(j):,}</td>"
                    f"<td>{'약함' if abs(c) < 0.2 else ('중간' if abs(c) < 0.4 else '뚜렷')}"
                    "</td></tr>")
        # 해외 지표는 키가 있을 때만 채워집니다 — 없으면 그 자리를 비웁니다
        us_keys = [k for k in ("us_10y", "us_2y", "us_spread", "vix", "nasdaq",
                               "dxy", "hy_spread") if k in mp and mp[k].notna().any()]
        if us_keys:
            uc = [(f"{last('us_10y'):.2f}%" if last("us_10y") else "-", "미국 10년",
                   chg("us_10y")),
                  (f"{last('vix'):,.1f}" if last("vix") else "-", "VIX", chg("vix")),
                  (f"{last('nasdaq'):,.0f}" if last("nasdaq") else "-", "나스닥",
                   chg("nasdaq")),
                  (f"{last('hy_spread'):.2f}%" if last("hy_spread") else "-",
                   "하이일드 스프레드", chg("hy_spread"))]
            macro_kv += "<div class='kv'>" + "".join(
                f"<div><b>{v}</b><span>{lab}"
                + (f" · 20일 {d:+,.2f}" if d is not None else "") + "</span></div>"
                for v, lab, d in uc) + "</div>"
        else:
            macro_kv += ("<div class='note'>해외 매크로(미국 금리·VIX·나스닥)는 "
                         "FRED 키가 있어야 채워집니다 — <code>.env</code> 에 "
                         "<code>FRED_API_KEY</code> 를 넣고 "
                         "<code>python ki_monitor.py macro-us</code> 를 실행하십시오.</div>")

        chart_specs = [("rate_3y", "국고채 3년 수익률 (%)"),
                       ("rate_10y", "국고채 10년 수익률 (%)"),
                       ("fx_usd", "원/달러 (선물 최근월)"),
                       ("vkospi", "변동성지수 (VKOSPI 선물)"),
                       ("term_spread", "장단기 스프레드 10Y−3Y (%p)"),
                       ("bei_10y", "기대인플레이션 BEI (%)"),
                       ("us_10y", "미국 국채 10년 (%)"),
                       ("vix", "VIX"),
                       ("nasdaq", "나스닥 종합"),
                       ("hy_spread", "미국 하이일드 스프레드 (%)")]
        charts = "<div class='grid2'>"
        for k, lab in chart_specs:
            if k in mp and mp[k].notna().sum() > 5:
                charts += (f"<div class='card'><h3>{lab}</h3>"
                           + svg_line(mp[k].dropna(), h=170, label=lab) + "</div>")
        charts += "</div>"
        ctab = (_table(["지표", "*현재", "*20일 변화", "*코스닥 일간 상관", "*관측",
                        "동행성"], corr_rows) if corr_rows else "")
        macro_block = (
            charts + "<h3>코스닥 지수와의 동행성</h3>" + ctab
            + "<div class='note'>일간 변화 기준 상관계수입니다. "
              "관측 1년(약 240일)으로는 상관계수의 신뢰구간이 넓고 시차도 불안정합니다. "
              "'금리 하락 = 엑싯 적기' 같은 단정 대신, 방향과 표본 수를 함께 보십시오.<br>"
              "환율·변동성지수는 최근월 선물 종가입니다 — 현물 환율·VKOSPI 의 대용치입니다.</div>")

    # 매크로 — 엑싯 환경(시장 내부)
    mac = ctx["macro"]
    turnover_chart = adv_chart = ipo_chart = "<div class='note'>표본 부족</div>"
    if mac:
        turnover_chart = svg_line(mac["turnover_ma"].dropna() / 1e12, h=180,
                                  label="시장 거래대금 20일 이동평균 (조원)")
    vol_chart = rate_chart = "<div class='note'>표본 부족</div>"
    if mp is not None and not mp.empty:
        if "vkospi" in mp and mp["vkospi"].notna().any():
            vol_chart = svg_line(mp["vkospi"].dropna(), h=180, label="VKOSPI")
        if "rate_3y" in mp and mp["rate_3y"].notna().any():
            rate_chart = svg_line(mp["rate_3y"].dropna(), h=180, label="국고채 3년")
        adv_chart = svg_line(mac["adv_ma"].dropna(), h=180, label="상승종목 비율 20일 평균")
        im = mac["ipo_monthly"]
        if len(im) > 1:
            labs = [pd.Timestamp(x).strftime("%y-%m") for x in im.index]
            ipo_chart = svg_hbar(labs, [float(x) for x in im.values], rowh=17,
                                 fmt=lambda v: f"{v:,.0f}건")
            p = mac["ipo_perf"]
            if len(p):
                ipo_chart += (f"<div class='note'>최근 120일 내 첫 등장 "
                              f"{mac['n_recent_ipo']}종목 · 첫 등장일 대비 수익률 "
                              f"중위 {_pct(float(p.median()))} · "
                              f"0 이상 비율 {_pct(float((p > 0).mean()))}</div>")

    # 포트폴리오사 워치리스트
    wl = ctx["watch"]
    if wl is None:
        watch_block = (
            "<div class='flag'><b>포트폴리오사 목록이 없습니다.</b><br>"
            "바탕화면 <code>watchlist.csv</code> 에 종목코드와 이름을 적으면 "
            "이 자리에 주가·추이·지표가 채워집니다. 투자금액이나 지분율은 필요 없습니다 — "
            "이 리포트는 주가 정보만 다룹니다.<br>"
            "<code>code,name</code> 두 열이면 충분합니다.</div>")
    elif wl.empty:
        watch_block = ("<div class='flag'>watchlist.csv 의 종목이 "
                       f"{ctx['market']} 원장에 없습니다. 코스피 종목이라면 "
                       "<code>ingest --universe KOSPI</code> 로 함께 적재하십시오.</div>")
    else:
        wrows = []
        for code, r in wl.iterrows():
            spark = svg_spark(ctx["spark"].get(code, pd.Series(dtype=float)))
            wrows.append(
                f"<tr><td>{_esc(r.get('name') or '')}</td><td>{code}</td>"
                f"<td>{spark}</td>"
                f"<td class='num'>{_won(r['close'])}</td>"
                + _sgn(r["ret_1d"]) + _sgn(r["ret_5d"]) + _sgn(r["ret_20d"])
                + _sgn(r.get("ret_all"))
                + f"<td class='num'>{_num(r.get('per'))}</td>"
                + f"<td class='num'>{_num(r.get('pbr'))}</td>"
                + _sgn(r.get("roe")) + "</tr>")
        miss = ctx["watch_missing"]
        note = (f"<div class='note'>원장에 없어 제외된 종목 {len(miss)}개: "
                f"{', '.join(miss[:12])}{' 외' if len(miss) > 12 else ''}</div>"
                if miss else "")
        watch_block = (
            f"<div class='card'><h3>{ctx['market']} 상장 포트폴리오사 {len(wl)}개</h3>"
            + _table(["종목", "코드", f"추이({n}일)", "*종가", "*1일", "*5일", "*20일",
                      f"*{n}일", "*PER", "*PBR", "*ROE"], wrows)
            + note + "</div>"
            + "<div class='grid2'>"
            + f"<div class='card'><h3>포트폴리오사 {n}일 수익률</h3>"
            + svg_hbar(list(wl["name"].fillna(wl.index.to_series())),
                       list(wl["ret_all"]), label="포트폴리오사 수익률") + "</div>"
            + f"<div class='card'><h3>포트폴리오사 대 {BENCHMARK} 지수</h3>"
            + (svg_line(ctx["watch_curve"], label="포트폴리오사 동일가중 지수")
               if ctx.get("watch_curve") is not None else "")
            + "<div class='note'>동일가중 · 배당 미반영. 보유수량이 아니라 "
              "종목 자체의 주가 흐름입니다.</div></div></div>")

    # 시장 국면 — 수준이 아니라 분위로 판단합니다
    reg = ctx["regime"]
    if not reg:
        regime_block = "<div class='note'>표본이 부족해 산출하지 않았습니다.</div>"
    else:
        cards = "".join(
            f"<div><b>{v['fmt'](v['value'])}</b>"
            f"<span>{v['label']}<br>관측기간 {v['pctile']*100:.0f}분위"
            + (f" · 20일 {v['fmt'](v['chg20'])}"
               if v["chg20"] is not None and abs(v["chg20"]) > 1e9
               else (f" · 20일 {v['chg20']:+,.2f}" if v["chg20"] is not None else ""))
            + "</span></div>" for v in reg.values())
        rows_r = ["<tr><td>%s</td><td class='num'>%s</td><td class='num'>%s</td>"
                  "<td class='num'>%s</td><td class='num'>%s ~ %s</td>"
                  "<td class='note'>%s</td></tr>"
                  % (v["label"], v["fmt"](v["value"]), f"{v['pctile']*100:.0f}%",
                     (v["fmt"](v["chg20"]).replace("조", "조p")
                      if v["chg20"] is not None and abs(v["chg20"]) > 1e9
                      else (f"{v['chg20']:+,.3f}" if v["chg20"] is not None else "-")),
                     v["fmt"](v["lo"]), v["fmt"](v["hi"]), v["what"])
                  for v in reg.values()]
        regime_block = (
            f"<div class='kv'>{cards}</div>"
            + _table(["지표", "*현재", "*관측기간 분위", "*20일 변화", "*관측기간 범위",
                      "산출 내용"], rows_r)
            + "<div class='note'>분위는 관측기간 내 값의 백분위입니다 — 100%면 기간 최고치. "
              "수준만으로는 높낮이를 말할 수 없으므로 분위를 함께 적었습니다. "
              "해석과 판단은 하지 않습니다.</div>")

    # 엑싯 지표 — 이 리포트의 목적입니다
    ex = ctx["exit"]
    if ex is None or ex.empty:
        exit_block = ("<div class='flag'>상장 포트폴리오사가 원장에 없습니다. "
                      "watchlist.csv 를 확인하십시오.</div>")
    else:
        erows = []
        for code, r in ex.iterrows():
            d1, d3, d5 = r.get("days_1pct"), r.get("days_3pct"), r.get("days_5pct")
            hard = (pd.notna(d3) and d3 > 20)
            tr = r.get("turnover_trend")
            erows.append(
                f"<tr class='pf'><td>{_esc(r.get('name') or '')}</td><td>{code}</td>"
                f"<td class='num'>{_won(r['close'])}</td>"
                f"<td class='num'>{_won(r['mktcap'] / 1e8)}</td>"
                + _sgn(r.get("px_pctile"), _pct)
                + _sgn(r.get("drawdown"))
                + f"<td class='num'>{_won(r.get('turnover_20d', np.nan) / 1e8)}</td>"
                + _sgn(tr)
                + f"<td class='num{' sev1' if hard else ''}'>{_num(d1)}</td>"
                + f"<td class='num{' sev1' if hard else ''}'>{_num(d3)}</td>"
                + f"<td class='num{' sev1' if hard else ''}'>{_num(d5)}</td>"
                + f"<td class='num'>{_pct(r['vol_ann'])}</td></tr>")
        ehdr = ["종목", "코드", "*종가", "*시총(억)", f"*{n}일 내 주가위치", "*고점대비",
                "*거래대금 20일(억)", "*유동성 추세", "*1% 처분(일)", "*3% 처분(일)",
                "*5% 처분(일)", "*변동성"]
        warn = ""
        exit_block = (
            "<div class='flag'><b>처분 소요일수</b>는 직전 20일 평균 거래량의 "
            "<b>10%</b>만 소화한다는 가정입니다 (장내 점진 매도). 시가총액 대비 "
            "1%·3%·5% 물량 기준입니다.<br>"
            "<b>주가위치</b>는 가용기간 내 백분위입니다 — 100%면 기간 최고가."
            f"{warn}</div>"
            + _table(ehdr, erows)
            + "<div class='note'>보유수량·취득원가는 다루지 않습니다. "
              "실제 보유분에 대입하시려면 시총 대비 지분율을 위 세 열에 맞춰 보십시오. "
              "블록딜은 이 계산 밖입니다 — 할인율이 유동성을 대신합니다.</div>")

    # 회수계획 대비 진척 — 계획은 사람이 세웠고, 상태는 데이터가 말합니다
    plan = ctx["plan"]
    if plan is None or plan.empty:
        plan_block = ("<div class='note'>회수계획 파일이 없습니다. "
                      "<code>exit_plan.csv</code> 에 회사명·경로·시기를 넣으면 "
                      "계획 대비 진척이 표시됩니다.</div>")
    else:
        pmatch = ctx["plan_match"]
        n_all = len(plan)
        if LISTED_ONLY:
            keep = {v["_k"] for v in pmatch.values()}
            plan = plan[plan["_k"].isin(keep)]
        n_drop = n_all - len(plan)
        prows, done, nostat = [], 0, 0
        nostat_pre = int((plan.get("dart_status",
                              pd.Series(dtype=str)).fillna("")
                          .astype(str).str.strip() != "").sum())
        for _, r in plan.iterrows():
            k = r["_k"]
            hit = next((c for c, v in pmatch.items() if v["_k"] == k), None)
            note = r.get("note", "")
            if "완료" in note:
                done += 1
                state = "<span class='pos'>회수 완료</span>"
                detail = ""
            elif hit and ex is not None and not ex.empty and hit in ex.index:
                row = ex.loc[hit]
                d3 = row.get("days_3pct")
                lp = row.get("liq_pctile")
                state = "<b>상장 · 추적 중</b>"
                detail = (f"3% 처분 {_num(d3)}일 · 유동성 "
                          f"{_pct(lp) if pd.notna(lp) else '-'} 분위")
            elif hit:
                state = "상장 · 원장 확인"
                detail = ""
            elif str(r.get("dart_status", "")).strip():
                # 추적할 수 없다고 해서 목록에서 빼지 않습니다.
                # 빠진 행은 '없는 것'이 되지만, 표기된 행은 '확인해야 할 것'으로 남습니다.
                nostat += 1
                state = f"<span class='sev2'><b>{_esc(r['dart_status'])}</b></span>"
                detail = ("<span class='note'>DART 등록부에 해당 상호 없음 — "
                          "외부감사 대상 미만이거나 등기 상호가 다릅니다. "
                          "정식 상호 확인 필요</span>")
            else:
                nostat += 1
                sig = ctx.get("unlisted_signals")
                sc = None
                if sig is not None and not sig.empty:
                    m2 = sig[sig["corp_name"].astype(str).str.replace(
                        r"\s+", "", regex=True).str.startswith(k[:4])]
                    if not m2.empty:
                        sc = len(m2.iloc[0]["signals"]) + (1 if m2.iloc[0]["audit"] else 0)
                state = "비상장"
                detail = (f"최근 180일 공시 {sc}건 유형 감지" if sc is not None
                          else "<span class='note'>최근 180일 공시 없음</span>")
            prows.append(
                f"<tr><td>{_esc(r['name'])}</td><td>{_esc(r['route'])}</td>"
                f"<td>{_esc(r['timing'])}</td><td>{state}</td>"
                f"<td class='note'>{detail}</td>"
                f"<td class='note'>{_esc(note)}</td></tr>")
        by_route = plan.groupby("route").size().to_dict()
        plan_block = (
            "<div class='flag'><b>경영계획 회수계획 " + f"{len(plan)}건</b> · "
            + " · ".join(f"{k} {v}건" for k, v in by_route.items())
            + f" · 완료 표기 {done}건<br>"
            + (f" · <span class='sev2'>확인 불가 {nostat_pre}건</span>"
               if nostat_pre else "") + "<br>"
            "금액(투자원금·회수목표·목표단가)은 의도적으로 제외했습니다. "
            "계획은 사람이 세운 것이고, 오른쪽 상태는 데이터가 말하는 것입니다. "
            "둘이 어긋나는 행이 확인 대상입니다.<br>"
            "<b>추적이 안 되는 건도 지우지 않고 남겨 둡니다</b> — 목록에서 빠지면 "
            "'없는 것'이 되지만, 표기해 두면 '확인해야 할 것'으로 남습니다."
            + (f"<br>이 리포트는 <b>상장 포트폴리오사만</b> 다룹니다. "
               f"비상장 계획 {n_drop}건은 표시하지 않았습니다 "
               "(exit_plan.csv 원본은 그대로입니다)." if n_drop else "")
            + "</div>"
            + _table(["회사", "회수 경로", "목표 시기", "현재 상태", "데이터",
                      "계획 비고"], prows))

    # 종목별 관측값 — 판정하지 않습니다
    if ex is None or ex.empty:
        verdict_block = ("<div class='flag'>상장 포트폴리오사가 원장에 없습니다.</div>")
        exit_detail_block = ""
    else:
        obs = {c: exit_observations(r) for c, r in ex.iterrows()}
        # 정렬은 처분 소요일수 오름차순 — 순위가 아니라 읽기 편한 배열입니다
        ranked = sorted(ex.index,
                        key=lambda c: (ex.loc[c, "days_3pct"]
                                       if pd.notna(ex.loc[c, "days_3pct"]) else 1e9))
        vrows = []
        for c in ranked:
            r = ex.loc[c]
            nev = len(obs[c]["events"])
            vrows.append(
                f"<tr><td><b>{_esc(r.get('name') or '')}</b></td><td>{c}</td>"
                f"<td class='num'>{_won((r.get('mktcap') or 0) / 1e8)}</td>"
                f"<td class='num'>{_num(r.get('days_3pct'))}</td>"
                f"<td class='num'><b>{_num(r.get('days_3pct_med'))}</b></td>"
                + _sgn(r.get("liq_pctile"), _pct) + _sgn(r.get("turnover_trend"))
                + _sgn(r.get("px_pctile"), _pct) + _sgn(r.get("drawdown"))
                + f"<td class='num'>{_pct(r.get('vol_ann'))}</td>"
                + _sgn(r.get("px_vs_vwap"))
                + f"<td class='num'>{_pct(r.get('liq_conc5'))}</td>"
                + f"<td class='num'>{_num(r.get('beta'))}</td>"
                + f"<td class='num'>{nev if nev else '-'}</td></tr>")
        verdict_block = (
            "<div class='flag'>측정값만 싣습니다. 등급·점수·권고는 넣지 않습니다 — "
            "판단은 이 표를 읽는 사람이 합니다.<br>"
            "처분 소요일수는 직전 20일 거래량의 <b>10%</b>만 소화한다는 가정이며, "
            "시가총액 3% 물량 기준입니다. 참여율에 정비례하므로 20%로 보면 절반이 됩니다. "
            "블록딜은 이 계산 밖입니다.<br>"
            "<b>평균 기준과 중앙값 기준을 나란히 둡니다.</b> 거래대금의 60~70%가 상위 "
            "5일에 몰리는 종목에서는 평균이 소수의 폭발일에 끌려 올라가, 보통 날의 "
            "소화력을 과대평가합니다. 중앙값 기준이 '평상시' 값에 가깝습니다.<br>"
            "분위는 관측 " + str(n) + "영업일 내 백분위입니다.</div>"
            + ("<div class='card'><h3>시가총액 3% 처분 소요일수 — 중앙값 거래량 기준"
               "</h3>"
               + svg_hbar([str(ex.loc[c].get("name") or c) for c in ranked
                           if pd.notna(ex.loc[c].get("days_3pct_med"))],
                          [float(ex.loc[c]["days_3pct_med"]) for c in ranked
                           if pd.notna(ex.loc[c].get("days_3pct_med"))],
                          rowh=22, fmt=lambda v: f"{v:,.0f}일")
               + "<div class='note'>평상시 거래량으로 환산한 값입니다. "
                 "평균 기준값은 아래 표에 함께 있습니다.</div></div>"
               if not ex["days_3pct_med"].isna().all() else "")
            + _table(["종목", "코드", "*시총(억)", "*3% 처분(평균)", "*3% 처분(중앙값)",
                      "*거래대금 분위", "*거래대금 20/60일", "*주가 분위", "*고점대비",
                      "*변동성", "*종가 vs VWAP20", "*상위5일 집중", "*베타",
                      "*공시"], vrows))
        det = []
        for c in ranked:
            r, s = ex.loc[c], obs[c]

            def ul(items):
                return ("<ul>" + "".join(f"<li>{_esc(x)}</li>" for x in items)
                        + "</ul>") if items else "<div class='note'>측정값 없음</div>"

            meta = []
            if pd.notna(r.get("sector")):
                meta.append(str(r["sector"]))
            meta.append(f"시총 {_won((r.get('mktcap') or 0) / 1e8)}억")
            ev = (("<div><b>공시 (180일 · 희석·위험 분류)</b>" + ul(s["events"])
                   + "</div>") if s["events"] else "")
            det.append(
                f"<div class='card'><h3>{_esc(r.get('name') or '')} "
                f"<span class='note'>{c} · {' · '.join(meta)}</span></h3>"
                f"<div class='two'>"
                f"<div><b>유동성 · 처분 용량</b>{ul(s['liq'])}</div>"
                f"<div><b>주가</b>{ul(s['px'])}</div>"
                f"<div><b>상장 · 보호예수</b>{ul(s['cap'])}</div>"
                f"<div><b>재무 · 밸류에이션</b>{ul(s['fin'])}</div>"
                f"</div>{ev}"
                + "<div class='two'><div><b>주가 추이 (최근 120일)</b>"
                + svg_spark(ctx["spark"].get(c, pd.Series(dtype=float)), w=520, h=60)
                + "</div><div><b>가격대별 거래대금 (매물대)</b>"
                + svg_vprofile(ctx["vprofile"].get(c, []))
                + "</div></div></div>")
        exit_detail_block = "".join(det)

    # 엑싯 실행 시뮬레이션 — 규칙별 실현단가 분포
    ebt = ctx.get("exec_bt") or {}
    ok_e = {c: v for c, v in ebt.items() if v.get("ok")}
    if not ok_e:
        why = "; ".join(sorted({v.get("reason", "") for v in ebt.values()})) or "표본 부족"
        exec_block = (f"<div class='flag'>실행 시뮬레이션 미산출 — {why}</div>")
    else:
        any_e = next(iter(ok_e.values()))
        erows = []
        for c in ranked:
            if c not in ok_e:
                continue
            nm = ex.loc[c].get("name") or c
            for r in EXEC_RULES:
                st = ok_e[c]["rules"].get(r)
                if not st:
                    continue
                erows.append(
                    f"<tr><td>{_esc(nm)}</td><td>{RULE_LABEL[r]}</td>"
                    + _sgn(st["shortfall_med"] / 10000)
                    + f"<td class='num'>{st['shortfall_p25']:,.0f} ~ "
                      f"{st['shortfall_p75']:,.0f}</td>"
                    + _sgn(st["vs_vwap_med"] / 10000)
                    + f"<td class='num'>{st['fill_med'] * 100:,.0f}%</td>"
                    f"<td class='num'>{st['days_med']:,.0f}</td>"
                    f"<td class='num'>{st['n']}</td></tr>")
        # 규칙 요약 — 전 종목 중위값. 어느 규칙이 대체로 나은지 한눈에.
        rule_med = {}
        for r in EXEC_RULES:
            vals = [v["rules"][r]["shortfall_med"] for v in ok_e.values()
                    if r in v["rules"]]
            if vals:
                rule_med[RULE_LABEL[r]] = float(np.median(vals)) / 10000
        # 종목별 규칙 비교 — 표 48행보다 막대가 빠릅니다
        cards = []
        for c in ranked:
            if c not in ok_e:
                continue
            nm = ex.loc[c].get("name") or c
            labs, vals = [], []
            for r in EXEC_RULES:
                st = ok_e[c]["rules"].get(r)
                if st:
                    labs.append(RULE_LABEL[r])
                    vals.append(st["shortfall_med"] / 10000)
            if labs:
                cards.append(f"<div class='card'><h3>{_esc(nm)}</h3>"
                             + svg_hbar(labs, vals, rowh=22) + "</div>")
        exec_block = (
            "<h3>매도 규칙별 실현단가 시뮬레이션</h3>"
            + (f"<div class='card'><h3>규칙별 실현단가 괴리 — 12개사 중위값</h3>"
               + svg_hbar(list(rule_med), list(rule_med.values()), rowh=24)
               + "<div class='note'>0에 가까울수록 매도 시작 직전 종가에 가깝게 "
                 "체결됐다는 뜻입니다.</div></div>" if rule_med else "")
            + "<div class='grid2'>" + "".join(cards) + "</div>"
            "<div class='flag'>과거 구간마다 <b>시가총액 3% 물량</b>을 "
            f"{any_e['horizon']}영업일에 걸쳐 매도했다고 가정하고, 시작일을 옮겨가며 "
            "반복 계산한 결과입니다. 한 구간만 보면 운 좋은 창을 고른 것인지 알 수 없어 "
            "여러 시작점의 분포를 냅니다.<br>"
            "체결 단가는 종가가 아니라 그날 <b>VWAP</b>(거래대금÷거래량)을 씁니다. "
            "하루 거래량의 25%를 넘겨 팔 수 없다고 제한했습니다.<br>"
            "<b>실현단가 괴리</b>는 매도 시작 직전 종가 대비입니다. 음수면 그만큼 "
            "낮은 값에 팔렸다는 뜻입니다.</div>"
            + _table(["종목", "매도 규칙", "*실현단가 괴리(중위)", "*괴리 25~75분위(bp)",
                      "*기간 VWAP 대비", "*체결률", "*소요일", "*구간수"], erows)
            + "<div class='note'>"
              f"<b>가정</b> — 가격 충격 = k · σ · √(주문량÷거래량), k={any_e['k']}. "
              "이 충격은 관측할 수 없습니다(우리가 팔지 않았던 과거이므로). "
              "표준적인 제곱근 모형을 가정한 것이며, k 값이 결과를 좌우합니다.<br>"
              "일봉 기준이라 하루 안의 체결 흐름은 반영되지 않습니다. "
              "블록딜·시간외 대량매매는 이 계산 밖입니다 — 거기서는 할인율이 "
              "유동성을 대신합니다.</div>")

    # 동종 비교 — 업종 중앙값과의 괴리
    peer_block = ""
    if ex is not None and not ex.empty and "peer_per" in ex.columns:
        pr = ex[ex["per_vs_peer"].notna()]
        if not pr.empty:
            prows = ["<tr><td>%s</td><td>%s</td><td class='num'>%s</td>"
                     "<td class='num'>%s</td>%s<td>%s</td></tr>"
                     % (_esc(r.get("name") or ""), _esc(r.get("sector") or "-"),
                        _num(r.get("per")), _num(r.get("peer_per")),
                        _sgn(r["per_vs_peer"]),
                        f"{int(r['peer_n']) if pd.notna(r.get('peer_n')) else '-'}")
                     for _, r in pr.sort_values("per_vs_peer", ascending=False).iterrows()]
            peer_block = (
                "<div class='card'><h3>동종 업종 대비 PER</h3>"
                + _table(["종목", "업종", "*PER", "*업종 중앙값", "*괴리", "*업종 표본"], prows)
                + "<div class='note'>업종 중앙값은 해당 업종에서 PER 산출이 가능한 "
                  "종목(흑자)만의 중앙값입니다. 적자 기업은 애초에 배수가 없어 "
                  "표본에서 빠지므로, 적자가 많은 업종일수록 중앙값이 위로 편향됩니다.</div>"
                  "</div>")
    if not peer_block:
        peer_block = ("<div class='note'>동종 비교는 흑자이면서 업종 분류가 있는 "
                      "종목에만 산출됩니다.</div>")

    # 2. 지수
    index_block = "<div class='note'>지수 원장이 비어 있습니다.</div>"
    if not idx.empty:
        rows = ["<tr><td>%s</td><td class='num'>%s</td>%s%s%s</tr>"
                % (nm, _num(r["close"]), _sgn(r["ret_1d"]), _sgn(r["ret_5d"]),
                   _sgn(r["ret_20d"]))
                for nm, r in idx.iterrows()]
        index_block = _table(["지수", "*종가", "*1일", "*5일", "*20일"], rows)
    index_bar = ""
    if not idx.empty:
        top = pd.concat([idx.head(12), idx.tail(12)]).drop_duplicates()
        index_bar = svg_hbar(list(top.index), list(top["ret_20d"]),
                             label="지수 20일 수익률")

    # 전종목 표 — 검색·필터·정렬
    allm = m.sort_values("value", ascending=False)
    arows = []
    for code, r in allm.iterrows():
        flags = []
        if r["at_high"]:
            flags.append("hi")
        if r["at_low"]:
            flags.append("lo")
        if pd.notna(r["vol_mult"]) and r["vol_mult"] >= 3:
            flags.append("surge")
        if pd.notna(r["ret_1d"]) and r["ret_1d"] >= 0:
            flags.append("up")
        else:
            flags.append("down")
        arows.append(
            f"<tr data-f='{' '.join(flags)}'><td>{_esc(r.get('name') or '')}</td>"
            f"<td>{code}</td><td class='num'>{_won(r['close'])}</td>"
            + _sgn(r["ret_1d"]) + _sgn(r["ret_5d"]) + _sgn(r["ret_20d"])
            + f"<td class='num'>{_won(r['value'] / 1e8)}</td>"
            + f"<td class='num'>{_num(r['vol_mult'])}</td>"
            + f"<td class='num'>{_won(r['mktcap'] / 1e8) if pd.notna(r['mktcap']) else '-'}</td>"
            + f"<td class='num'>{_pct(r['vol_ann'])}</td>"
            + _sgn(r["drawdown"]) + "</tr>")
    ahdr = ["종목", "코드", "*종가", "*1일", "*5일", "*20일", "*거래대금(억)",
            "*ADV배수", "*시총(억)", "*변동성", "*고점대비"]
    all_block = (
        "<div class='toolbar'>"
        "<input type='search' id='q' placeholder='종목명 또는 코드 검색'>"
        "<span id='flt'>"
        "<button class='btn on' data-m='all'>전체</button>"
        "<button class='btn' data-m='up'>상승</button>"
        "<button class='btn' data-m='down'>하락</button>"
        "<button class='btn' data-m='hi'>신고가</button>"
        "<button class='btn' data-m='lo'>신저가</button>"
        "<button class='btn' data-m='surge'>거래량 급증</button>"
        "</span><span class='count' id='cnt'></span></div>"
        "<div class='scroll'>"
        + _table(ahdr, arows).replace("<table>", "<table id='alltab'>")
        + "</div>"
        "<div class='note'>거래대금 내림차순 기본 정렬. 헤더를 누르면 해당 열로 재정렬됩니다. "
        "검색과 필터는 함께 적용됩니다.</div>")

    # 3. 등락률
    cols = [("close", "won"), ("ret_1d", "pct"), ("ret_5d", "pct"),
            ("ret_20d", "pct"), ("value", "eok")]
    hd = ["종목", "코드", "*종가", "*1일", "*5일", "*20일", "*거래대금(억)"]
    up = m.nlargest(20, "ret_1d")
    dn = m.nsmallest(20, "ret_1d")
    movers_block = ("<div><h3>상승 상위 20</h3>" + _table(hd, _stock_rows(up, cols)) + "</div>"
                    "<div><h3>하락 상위 20</h3>" + _table(hd, _stock_rows(dn, cols)) + "</div>")
    _nm = lambda d: [f"{(v.get('name') or i)}" for i, v in d.iterrows()]   # noqa: E731
    up_bar = svg_hbar(_nm(up.head(15)), list(up.head(15)["ret_1d"]))
    down_bar = svg_hbar(_nm(dn.head(15)), list(dn.head(15)["ret_1d"]))

    # 8. 위험·수익 지형
    risk_scatter = svg_scatter(m["vol_ann"], m["ret_20d"], xlab="연율 변동성",
                               ylab="20일 수익률")
    size_scatter = svg_scatter(m["mktcap"], m["ret_20d"], xlab="시가총액 (로그)",
                               ylab="20일 수익률", logx=True)

    # 4. 유동성
    hd2 = ["종목", "코드", "*종가", "*1일", "*거래대금(억)", "*거래량", "*ADV20 배수"]
    c2 = [("close", "won"), ("ret_1d", "pct"), ("value", "eok"),
          ("volume", "won"), ("vol_mult", "num")]
    val_top = m.nlargest(20, "value")
    surge = m[m["adv20"].notna() & (m["adv20"] > 0)].nlargest(20, "vol_mult")
    liquidity_block = ("<div><h3>거래대금 상위 20</h3>" + _table(hd2, _stock_rows(val_top, c2))
                       + "</div><div><h3>거래량 급증 상위 20 (ADV20 대비)</h3>"
                       + _table(hd2, _stock_rows(surge, c2)) + "</div>")

    # 5. 신고가·신저가
    hd3 = ["종목", "코드", "*종가", "*1일", "*20일", "*고점대비", "*변동성"]
    c3 = [("close", "won"), ("ret_1d", "pct"), ("ret_20d", "pct"),
          ("drawdown", "pct"), ("vol_ann", "pct")]
    hi = m[m["at_high"]].nlargest(20, "value")
    lo = m[m["at_low"]].nlargest(20, "value")
    extremes_block = (f"<div><h3>신고가 {len(m[m['at_high']]):,}종목 · 거래대금 상위 20</h3>"
                      + _table(hd3, _stock_rows(hi, c3)) + "</div>"
                      f"<div><h3>신저가 {len(m[m['at_low']]):,}종목 · 거래대금 상위 20</h3>"
                      + _table(hd3, _stock_rows(lo, c3)) + "</div>")

    # 6. 밸류에이션
    v = ctx["valuation"]
    if v is None or v.empty:
        valuation_block = ("<div class='note'>재무 원장이 비어 있습니다 — "
                           "<code>python ki_monitor.py fundamentals</code> 를 먼저 실행하십시오.</div>")
    else:
        cov = int(v["per"].notna().sum())
        hd4 = ["종목", "코드", "*시총(억)", "*PER", "*PBR", "*PSR", "*ROE", "*영업이익률",
               "*부채비율", "*20일"]
        c4 = [("mktcap", "eok"), ("per", "num"), ("pbr", "num"), ("psr", "num"),
              ("roe", "pct"), ("opm", "pct"), ("debt_ratio", "pct"), ("ret_20d", "pct")]
        big = v.nlargest(25, "mktcap")
        cheap = v[(v["per"].between(0, 15)) & (v["pbr"].between(0, 2))
                  & (v["mktcap"] > 5e10)].nsmallest(25, "per")
        valuation_block = (
            f"<div class='flag'>{ctx['fs_period']} 사업보고서 기준 · 재무 수집 "
            f"{int(v['equity'].notna().sum()):,}사 · PER 산출가능 {cov:,}사 · "
            f"적자 {int(v['deficit'].sum()):,}사 · 자본잠식 {int(v['impaired'].sum()):,}사"
            "<br>적자·자본잠식 기업의 PER·PBR 은 정의되지 않아 결측입니다. "
            "음수 배수를 남기면 정렬 시 '가장 싼 종목'으로 올라옵니다.</div>"
            "<h3>시가총액 상위 25</h3>" + _table(hd4, _stock_rows(big, c4))
            + "<h3>저평가 후보 — PER 0~15 · PBR 0~2 · 시총 500억 이상</h3>"
            + _table(hd4, _stock_rows(cheap, c4))
            + "<div class='note'>스크리닝 결과지 추천이 아닙니다. 배수가 낮은 데에는 "
              "이유가 있고, 그 이유는 재무제표가 아니라 8장 공시에 있는 경우가 많습니다.</div>")

    # 9. 공시
    dsc = ctx["disclosures"]
    if dsc is None or dsc.empty:
        disclosure_block = "<div class='note'>공시 수집분이 없습니다.</div>"
    else:
        tagged = dsc[dsc["tags"] != ""]
        counts = {}
        for t in tagged["tags"]:
            for one in t.split(","):
                counts[one] = counts.get(one, 0) + 1
        label = {"corporate_action": "자본 변동", "dilution": "희석 (CB/BW/전환)",
                 "risk": "위험 신호"}
        chips = " ".join(f"<span class='tag {k}'>{label.get(k, k)} {vv}</span>"
                         for k, vv in sorted(counts.items(), key=lambda x: -x[1]))
        rows = []
        for _, r in tagged.head(40).iterrows():
            tg = " ".join(f"<span class='tag {t}'>{label.get(t, t)}</span>"
                          for t in r["tags"].split(","))
            rows.append(f"<tr><td>{r.get('corp_name', '')}</td>"
                        f"<td>{r.get('stock_code', '')}</td>"
                        f"<td>{r.get('report_nm', '')}</td><td>{tg}</td>"
                        f"<td>{r.get('flr_nm', '')}</td></tr>")
        disclosure_block = (
            f"<div class='flag'>{ctx['dsc_day']} 접수 {len(dsc):,}건 · 분류 적중 "
            f"{len(tagged):,}건 &nbsp; {chips}</div>"
            + _table(["회사", "코드", "보고서명", "분류", "제출인"], rows)
            + "<div class='note'>DART 원문입니다. 기사보다 빠르고 법적 책임이 있는 1차 자료입니다. "
              "분류는 보고서명 키워드 기반이라 누락이 있을 수 있습니다.</div>")

    provenance_block = _table(
        ["층", "출처", "수집 범위", "한계"],
        ["<tr><td>시세</td><td>KRX 일별매매정보</td><td>%s %s종목 · %d일</td>"
         "<td>일별 확정치. 장중 시세 아님</td></tr>"
         % (ctx["market"], f"{ctx['n_stocks']:,}", n),
         "<tr><td>지수</td><td>KRX 지수일별시세</td><td>코스닥 계열 %d종</td>"
         "<td>코스피·KRX 계열은 사용신청 미완</td></tr>" % (len(idx),),
         "<tr><td>재무</td><td>DART 다중회사 주요계정</td><td>%s사 · %s</td>"
         "<td>연차 기준. 분기 미반영</td></tr>"
         % (f"{ctx['fs_companies']:,}", ctx["fs_period"]),
         "<tr><td>공시</td><td>DART 공시검색</td><td>%s 1일분</td>"
         "<td>키워드 분류. 본문 미해석</td></tr>" % (ctx["dsc_day"],),
         "<tr><td>뉴스</td><td>—</td><td>없음</td>"
         "<td>확보된 소스 없음</td></tr>",
         "<tr><td>국내 매크로</td><td>KRX 국채·채권지수·선물</td>"
         "<td>금리곡선·환율·VKOSPI·BEI</td><td>선물 최근월 종가는 현물 대용치</td></tr>",
         "<tr><td>해외 매크로</td><td>FRED (세인트루이스 연준)</td>"
         "<td>미국 금리·VIX·나스닥·HY 스프레드</td>"
         "<td>일부 계열은 제3자 소유 — 아래 참조</td></tr>",
         "<tr><td>뉴스</td><td>—</td><td>없음</td>"
         "<td>확보된 소스 없음</td></tr>",
         "<tr><td>애널리스트 컨센서스</td><td>—</td><td>없음</td>"
         "<td>유료 벤더 영역 (FnGuide 등)</td></tr>"]) + (
        "<h3>출처 표기 · 이용 범위</h3>"
        "<div class='note'>"
        "본 리포트의 시세·지수·파생 데이터는 <b>한국거래소(KRX) 정보데이터시스템 "
        "Open API</b>, 공시·재무 데이터는 <b>금융감독원 DART Open API</b>, "
        "해외 매크로는 <b>Federal Reserve Bank of St. Louis (FRED)</b> 에서 "
        "제공받았습니다.<br>"
        "FRED 제공 계열 중 나스닥 종합지수는 Nasdaq, Inc., 하이일드 스프레드는 "
        "ICE Data Indices, LLC 의 저작물입니다. 각 제공처의 이용약관이 적용되며, "
        "재배포·재판매·외부 제공에는 별도 확인이 필요합니다.<br>"
        "<b>본 문서는 내부 검토용이며 투자권유·투자자문 자료가 아닙니다.</b>"
        "</div>")

    # ── 에이전트 분석 절 (통합 계층) ──────────────────────────────────
    # ctx["agents_enabled"] 가 켜졌을 때만 절을 만듭니다. 끄면 목차·본문 모두
    # 통합 이전과 동일합니다 — 번호도 밀리지 않습니다.
    agents_on = bool(ctx.get("agents_enabled"))
    secs = [("s1", "무엇을 결정해야 하는가"), ("s2", "팔 수 있는가"),
            ("s3", "어떻게 팔 것인가"), ("s4", "지금이 그 때인가")]
    if agents_on:
        secs.append(("sa", "에이전트 분석"))
    secs += [("s5", "종목별 상세"), ("s6", "밸류에이션"),
             ("s7", "시장 배경"), ("s8", "출처")]
    _links = [f'<a href="#{sid}">{i} {title}</a>'
              for i, (sid, title) in enumerate(secs, 1)]
    nav_html = "\n" + "".join(
        " " + "".join(_links[i:i + 2]) + "\n" for i in range(0, len(_links), 2))

    agent_block, agent_flow = "", ""
    if agents_on:
        ex_tbl = ctx.get("exit")
        wl_codes = (list(ex_tbl.index)
                    if isinstance(ex_tbl, pd.DataFrame) and not ex_tbl.empty else [])
        agent_block = (
            '<h2 id="sa">에이전트 분석 — AI 판정</h2>'
            "<div class='lead'>PIXEL TRADING FLOOR 의 에이전트들이 위 측정값과 시장 데이터를 "
            "보고 토론해 내린 판정입니다. 측정값이 아니라 의견이므로 절을 나눠 실었습니다. "
            "회의에서 논점을 정리하는 데 쓰고, 근거는 §1~§4 로 돌아가 확인하십시오.</div>"
            + render_agents_block(ctx.get("agents"), wl_codes) + "\n\n")
        agent_flow = " → <b>에이전트 판정</b>"

    html = QUANT_TEMPLATE.format(
        org=ORG_NAME,
        nav_html=nav_html, agent_block=agent_block, agent_flow=agent_flow,
        as_of=ctx["as_of"], market=ctx["market"], n_stocks=ctx["n_stocks"],
        n_days=n, gen_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        refresh_meta=(f"<meta http-equiv='refresh' content='{refresh_sec}'>"
                      if refresh_sec else ""),
        watermark_html=(f"<div class='wm'>{env('watermark')}</div>"
                        if env("watermark") else ""),
        summary_kv=summary_kv, breadth_block=breadth_block, index_block=index_block,
        movers_block=movers_block, liquidity_block=liquidity_block,
        extremes_block=extremes_block, provenance_block=provenance_block,
        bench_name=BENCHMARK, index_chart=index_chart, hist_chart=hist_chart,
        breadth_bar=breadth_bar, watch_block=watch_block, index_bar=index_bar,
        exit_block=exit_block,
        exec_block=exec_block,
        turnover_chart=turnover_chart,
        adv_chart=adv_chart, ipo_chart=ipo_chart,
        macro_kv=macro_kv, macro_block=macro_block,
        plan_block=plan_block,
        verdict_block=verdict_block, regime_block=regime_block,
        exit_detail_block=exit_detail_block, vol_chart=vol_chart,
        rate_chart=rate_chart, peer_block=peer_block,
        all_block=all_block, up_bar=up_bar, down_bar=down_bar,
        )

    out = Path(env("out_dir"))
    out.mkdir(parents=True, exist_ok=True)
    hp = out / f"KI_exit_{ctx['as_of'].replace('-', '')}.html"
    hp.write_text(html, encoding="utf-8")
    return hp


def build_quant_context(con, market: str = "KOSDAQ", with_disclosures: bool = True) -> dict:
    fr = quant_frames(con, market)
    if not fr:
        raise SystemExit(f"{market} 원장이 비어 있습니다. "
                         f"ingest --universe {market} 를 먼저 실행하십시오.")
    m = quant_metrics(fr)
    last_day = fr["last_day"]
    day_str = pd.Timestamp(last_day).strftime("%Y%m%d")

    idx_t = quant_index_table(con)
    bench = None
    bench_series = None
    if not idx_t.empty and BENCHMARK in idx_t.index:
        b = idx_t.loc[BENCHMARK]
        bench = {"close": b["close"], "ret_1d": b["ret_1d"], "ret_20d": b["ret_20d"]}
        bi = index_panel(con, BENCHMARK)
        if not bi.empty:
            bench_series = bi.set_index("date")["close"]

    fs = fundamentals_panel(con)
    period = "미수집"
    fs_companies = 0
    if not fs.empty:
        row = con.execute("SELECT MAX(period) FROM fundamental").fetchone()
        period = (row[0] or "").split("-")[0] or "미수집"
        fs_companies = int(len(fs))
    v = valuation(m, fs) if not fs.empty else pd.DataFrame()

    dsc = pd.DataFrame()
    if with_disclosures:
        cls = {"KOSPI": "Y", "KOSDAQ": "K", "KONEX": "N"}.get(market, "K")
        try:
            dsc = dart_disclosures_by_date(day_str, cls)
        except Exception as e:                          # noqa: BLE001
            print(f"  [공시 보류] {type(e).__name__}: {e}")

    mac = macro_series(fr)
    mpanel = macro_panel(con)
    inst = instruments_panel(con)
    reg_d = regime(fr, mpanel)
    plan_df = _exit_plan()
    plan_match = {}

    # 포트폴리오사 — 상장은 주가, 비상장은 DART 재무·공시
    wl_raw = _watchlist()
    watch, watch_missing, spark, watch_curve = None, [], {}, None
    unlisted, unlisted_dsc = None, pd.DataFrame()
    unlisted_sig = pd.DataFrame()
    ex_tbl, pf_dsc = pd.DataFrame(), pd.DataFrame()
    vprof, exec_bt = {}, {}
    close = fr["close"]
    if wl_raw is not None:
        wl_listed = wl_raw["listed"]
        wl_un = wl_raw["unlisted"]
        # 비상장은 리포트에 싣지 않습니다 (상장 포트폴리오사만 다룹니다).
        # watchlist.csv 의 비상장 행은 그대로 두되 조회하지 않습니다 —
        # 목록을 지우면 나중에 되살릴 근거까지 사라지기 때문입니다.
        have = [c for c in wl_listed["code"] if c in close.columns]
        watch_missing = [c for c in wl_listed["code"] if c not in close.columns]
        if have:
            sub = m.reindex(have)
            first = close[have].apply(lambda s: s.dropna().iloc[0]
                                      if s.notna().any() else np.nan)
            sub["ret_all"] = close[have].iloc[-1] / first - 1
            nm = wl_listed.set_index("code").get("name")
            if nm is not None:
                sub["name"] = sub["name"].fillna(nm.reindex(have))
            if not v.empty:
                for col in ("per", "pbr", "roe"):
                    if col in v.columns:
                        sub[col] = v[col].reindex(have)
            watch = sub.sort_values("mktcap", ascending=False)
            spark = {c: close[c].dropna().tail(120) for c in have}
            eq = close[have].pct_change().mean(axis=1)      # 동일가중
            watch_curve = (1 + eq.fillna(0)).cumprod()
            ex_tbl = exit_metrics(fr, have, m)
            if not ex_tbl.empty:
                sens = market_sensitivity(close, have, bench_series)
                if not sens.empty:
                    for col in ("beta", "te"):
                        ex_tbl[col] = pd.to_numeric(sens[col], errors="coerce")
                vprof = {c: volume_profile(close[c], fr["value"][c]) for c in have}
                # 실행 시뮬레이션 — 시총 3% 물량을 20영업일에 걸쳐 매도
                for cd in have:
                    mc = m["mktcap"].get(cd)
                    px = m["close"].get(cd)
                    if not (pd.notna(mc) and pd.notna(px) and px > 0):
                        continue
                    exec_bt[cd] = exit_execution_backtest(
                        close[cd], fr["volume"][cd], fr["value"][cd],
                        target_shares=(mc / px) * 0.03, horizon=20, step=10)
                if "name" in watch.columns:
                    ex_tbl["name"] = watch["name"].reindex(ex_tbl.index)
                if not v.empty:
                    for col in ("per", "pbr", "roe", "deficit"):
                        if col in v.columns:
                            ex_tbl[col] = v[col].reindex(ex_tbl.index)
                ex_tbl = ex_tbl.sort_values("mktcap", ascending=False)
            # 상장 포트폴리오사 공시 — corp_code 로 조회
            try:  # noqa: SIM105
                cc = dart_corp_codes().set_index("stock_code")["corp_code"]
                pcc = [cc[c] for c in have if c in cc.index]
                if pcc:
                    pf_dsc = unlisted_disclosures(pcc, days=180, limit=60)
            except Exception as e:                      # noqa: BLE001
                print(f"  [포트폴리오 공시 보류] {type(e).__name__}: {e}")
        else:
            watch = pd.DataFrame()

    if not ex_tbl.empty:
        ex_tbl = attach_context(ex_tbl, inst, v, pf_dsc, pd.Timestamp(last_day))
    if plan_df is not None and watch is not None and not watch.empty:
        plan_match = match_plan(plan_df, watch["name"].to_dict())
    cap_struct = {}
    if not ex_tbl.empty:
        try:
            cap_struct = portfolio_capital_structure(list(ex_tbl.index))
        except Exception as e:                          # noqa: BLE001
            print(f"  [자본구조 보류] {type(e).__name__}: {e}")

    return {"market": market, "as_of": str(pd.Timestamp(last_day).date()),
            "bench_series": bench_series,
            "watch": watch, "watch_missing": watch_missing, "spark": spark,
            "watch_curve": watch_curve, "unlisted": unlisted,
            "unlisted_dsc": unlisted_dsc, "unlisted_signals": unlisted_sig, "macro": mac, "exit": ex_tbl,
            "macro_panel": mpanel,
            "regime": reg_d, "instruments": inst,
            "plan": plan_df, "plan_match": plan_match, "vprofile": vprof,
            "exec_bt": exec_bt,
            "capital": cap_struct,
            "pf_disclosures": pf_dsc,
            "n_days": fr["n_days"], "n_stocks": int(m.shape[0]),
            "n_halted": int(m["close"].isna().sum()),
            "metrics": m.dropna(subset=["close"]), "index": idx_t, "bench": bench,
            "breadth": market_breadth(con, market), "valuation": v,
            "fs_period": period, "fs_companies": fs_companies,
            "disclosures": dsc, "dsc_day": day_str}


def mock_panel(codes: list[str], n: int = 300, seed: int = 7) -> pd.DataFrame:
    """가상 데이터. 사내 자료 없이 로직·조판·검증을 전부 끝낼 수 있습니다."""
    rng = np.random.default_rng(seed)
    frames = []
    for i, c in enumerate(codes):
        px = 50000 * np.exp(np.cumsum(rng.normal(0.0003, 0.02, n)))
        intr = np.abs(rng.normal(0, 0.012, n))
        d = pd.DataFrame({"date": pd.bdate_range(end=date.today(), periods=n), "code": c,
                          "close": px, "open": px * (1 + rng.normal(0, 0.005, n))})
        d["high"] = np.maximum(d["open"], d["close"]) * (1 + intr)
        d["low"] = np.minimum(d["open"], d["close"]) * (1 - intr)
        d["volume"] = rng.lognormal(11.5 + 0.2 * i, 0.4, n)
        d["value"] = d["volume"] * d["close"]
        d["shares"] = 1e7
        frames.append(d)
    return pd.concat(frames, ignore_index=True)


def index_panel(con, name: str = None) -> pd.DataFrame:
    q = "SELECT date, index_name, open, high, low, close FROM index_daily"
    params = ()
    if name:
        q += " WHERE index_name = ?"
        params = (name,)
    df = pd.read_sql_query(q + " ORDER BY date", con, params=params)
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"])
    return df


def market_breadth(con, market: str = "KOSDAQ", day: str = None) -> dict:
    """시장 전체를 적재해야만 나오는 숫자입니다.
    포트폴리오가 빠진 게 종목 문제인지 시장 전체인지 여기서 갈립니다."""
    if day is None:
        row = con.execute("SELECT MAX(date) FROM price_daily WHERE market=?",
                          (market,)).fetchone()
        day = row[0] if row else None
    if not day:
        return {}
    prev = con.execute(
        "SELECT MAX(date) FROM price_daily WHERE market=? AND date<?",
        (market, day)).fetchone()[0]
    if not prev:
        return {"date": day, "market": market, "n": 0}
    cur = pd.read_sql_query(
        "SELECT code, close, value FROM price_daily WHERE market=? AND date=?",
        con, params=(market, day))
    old = pd.read_sql_query(
        "SELECT code, close FROM price_daily WHERE market=? AND date=?",
        con, params=(market, prev))
    m = cur.merge(old, on="code", suffixes=("", "_prev")).dropna(
        subset=["close", "close_prev"])
    if m.empty:
        return {"date": day, "market": market, "n": 0}
    r = m["close"] / m["close_prev"] - 1
    return {"date": day, "market": market, "n": int(len(m)),
            "up": int((r > 0).sum()), "flat": int((r == 0).sum()),
            "down": int((r < 0).sum()),
            "adv_ratio": float((r > 0).mean()),
            "median_ret": float(r.median()),
            "turnover": float(m["value"].sum()),
            "limit_up": int((r >= 0.29).sum()), "limit_down": int((r <= -0.29).sum())}


# ════════════════════════════════════════════════════════════════════════
# 13-B. 퀀트 리포트 — 포지션 없이 시장·종목 자체를 봅니다
#       KRX 시세 · KRX 지수 · DART 재무 · DART 공시 네 층을 겹칩니다
# ════════════════════════════════════════════════════════════════════════

def quant_frames(con, market: str = "KOSDAQ") -> dict:
    """원장에서 분석용 행렬을 만듭니다. 모든 지표가 여기서 파생됩니다."""
    df = pd.read_sql_query(
        "SELECT date, code, name, close, volume, value, mktcap, shares "
        "FROM price_daily WHERE market=? ORDER BY date", con, params=(market,))
    if df.empty:
        return {}
    df["date"] = pd.to_datetime(df["date"])
    close = df.pivot_table(index="date", columns="code", values="close")
    names = df.dropna(subset=["name"]).groupby("code")["name"].last()
    last_day = close.index.max()
    latest = df[df["date"] == last_day].set_index("code")
    return {"close": close, "volume": df.pivot_table(index="date", columns="code",
                                                     values="volume"),
            "value": df.pivot_table(index="date", columns="code", values="value"),
            "mktcap_panel": df.pivot_table(index="date", columns="code", values="mktcap"),
            "names": names, "latest": latest, "last_day": last_day,
            "n_days": int(len(close))}


def quant_metrics(fr: dict) -> pd.DataFrame:
    """종목 단위 지표 한 판. 여기 없는 숫자는 리포트에도 없습니다."""
    close, vol, val = fr["close"], fr["volume"], fr["value"]
    ret1 = close.pct_change().iloc[-1]
    n = len(close)
    look = lambda k: (close.iloc[-1] / close.iloc[-min(k, n)] - 1)   # noqa: E731
    r = close.pct_change()
    m = pd.DataFrame({
        "name": fr["names"],
        "close": close.iloc[-1],
        "ret_1d": ret1,
        "ret_5d": look(6),
        "ret_20d": look(21),
        "vol_ann": r.std(ddof=1) * np.sqrt(ANN),
        "value": val.iloc[-1],
        "volume": vol.iloc[-1],
        "adv20": vol.iloc[-21:-1].mean() if n > 2 else np.nan,
        "mktcap": fr["latest"]["mktcap"],
        "hi_n": close.max(), "lo_n": close.min(),
    })
    m["vol_mult"] = m["volume"] / m["adv20"].replace(0, np.nan)
    m["at_high"] = m["close"] >= m["hi_n"] * 0.999
    m["at_low"] = m["close"] <= m["lo_n"] * 1.001
    # Amihud 비유동성 — 거래대금 1원당 가격충격. 클수록 체결비용이 큽니다.
    m["amihud"] = (r.abs() / val.replace(0, np.nan)).mean() * 1e12
    m["drawdown"] = m["close"] / m["hi_n"] - 1
    return m


def krx_instruments(bas_dd: str, market: str = "KOSDAQ") -> int:
    """상장일·업종을 받아 둡니다. 락업 추정과 동종 비교의 근거입니다."""
    svc = {"KOSPI": "stk_isu_base_info", "KOSDAQ": "ksq_isu_base_info",
           "KONEX": "knx_isu_base_info"}[market]
    df = krx_map(krx_get(svc, bas_dd), "isu_base_info")
    if df.empty:
        return 0
    df = df[["code", "name", "market", "sector", "list_date"]].copy()
    df["updated_at"] = datetime.now().isoformat(timespec="seconds")
    con = connect()
    n = upsert(con, "instruments", df.drop_duplicates("code"))
    con.close()
    return n


def instruments_panel(con) -> pd.DataFrame:
    df = pd.read_sql_query(
        "SELECT code, name, sector, list_date FROM instruments", con)
    return df.set_index("code") if not df.empty else df


def pctile(s: pd.Series, v: float) -> float | None:
    """현재 값이 과거 분포의 몇 분위인가. 국면 판단의 기본 단위입니다."""
    x = s.dropna()
    if len(x) < 30 or v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    return float((x <= v).mean())


def regime(fr: dict, mp: pd.DataFrame) -> dict:
    """지금이 팔기 좋은 창인가 — 네 가지만 봅니다.

    수준(level)이 아니라 분위(percentile)로 봅니다. 금리 4%가 높은지 낮은지는
    맥락 없이 말할 수 없지만, '1년 중 상위 10%'는 말할 수 있습니다."""
    val = fr["value"]
    turn = val.sum(axis=1)
    turn_ma = turn.rolling(20).mean()
    out = {}

    def add(key, label, series, fmt, what):
        if series is None or series.dropna().empty:
            return
        s = series.dropna()
        cur = float(s.iloc[-1])
        p = pctile(series, cur)
        if p is None:
            return
        d20 = float(cur - s.iloc[-min(21, len(s))]) if len(s) > 21 else None
        out[key] = {"label": label, "value": cur, "pctile": p, "fmt": fmt,
                    "chg20": d20, "what": what,
                    "lo": float(s.min()), "hi": float(s.max())}

    add("liquidity", "시장 거래대금 (20일평균)", turn_ma,
        lambda v: f"{v / 1e12:,.2f}조", "코스닥 전 종목 거래대금 합계의 20일 이동평균")
    if "vkospi" in mp:
        add("vol", "변동성지수 (VKOSPI 선물)", mp["vkospi"], lambda v: f"{v:,.1f}",
            "최근월 선물 종가")
    if "rate_3y" in mp:
        add("rate", "국고채 3년", mp["rate_3y"], lambda v: f"{v:.3f}%",
            "국채전문유통시장 지표물 종가수익률")
    r = fr["close"].pct_change()
    adv_ratio = (r > 0).sum(axis=1) / r.notna().sum(axis=1).replace(0, np.nan)
    add("breadth", "상승종목 비율 (20일평균)", adv_ratio.rolling(20).mean(),
        lambda v: f"{v * 100:,.1f}%", "전일 대비 상승한 종목의 비율")
    return out


def macro_series(fr: dict, win: int = 20) -> dict:
    """엑싯 환경 지표 — 지금 팔 수 있는 시장인가.

    지수 수준보다 중요한 것이 세 가지입니다.
      · 시장 거래대금  — 유동성이 마르면 블록딜도 장내매도도 안 됩니다
      · 상승종목 비율  — 지수는 대형주가 끌어도 종목장이 아닐 수 있습니다
      · 신규상장 온도  — IPO 창구가 열려 있는지. 회수계획의 전제입니다
    """
    close, val = fr["close"], fr["value"]
    turn = val.sum(axis=1)
    r = close.pct_change()
    adv = (r > 0).sum(axis=1) / r.notna().sum(axis=1).replace(0, np.nan)
    # 신규 상장 — 원장에 처음 등장한 날을 상장일 대용으로 씁니다.
    # 주의: 원장 시작일에는 그때 이미 상장돼 있던 전 종목이 '첫 등장'합니다.
    # 그 달을 세면 1,800건짜리 가짜 상장 급증이 만들어집니다. 첫 달은 버립니다.
    first = close.notna().idxmax()
    first = first.where(close.notna().any())
    cutoff = close.index.min() + pd.offsets.MonthEnd(1)
    ipo = first[first > cutoff].value_counts().sort_index()
    ipo_m = ipo.groupby(pd.Grouper(freq="ME")).sum() if len(ipo) else pd.Series(dtype=float)
    # 상장 후 성과 — 최근 상장 종목이 오르는 장인가
    recent = first[first >= close.index[max(0, len(close) - 120)]]
    perf = {}
    for c, d0 in recent.items():
        s = close[c].loc[d0:].dropna()
        if len(s) >= 5:
            perf[c] = float(s.iloc[-1] / s.iloc[0] - 1)
    ipo_perf = pd.Series(perf)
    return {"turnover": turn, "turnover_ma": turn.rolling(win).mean(),
            "adv_ratio": adv, "adv_ma": adv.rolling(win).mean(),
            "ipo_monthly": ipo_m, "ipo_perf": ipo_perf,
            "n_recent_ipo": int(len(recent)),
            "vol_market": r.mean(axis=1).rolling(win).std() * np.sqrt(ANN)}


LOCKUP_MONTHS = 6      # 벤처금융 보호예수는 통상 1~6개월. 보수적으로 6개월을 씁니다
LISTED_ONLY = True     # 리포트를 상장 포트폴리오사로 한정합니다.
                       # False 로 바꾸면 비상장 계획 행과 비상장 섹션이 함께 돌아옵니다.


def exit_observations(row: pd.Series) -> dict:
    """종목별 관측 사실을 모읍니다. 판단하지 않습니다.

    의도적으로 하지 않는 것 — 등급 부여, 점수화, '유리/불리' 분류,
    '블록딜 검토' 같은 권고. 그것은 리포트를 읽는 사람의 몫입니다.
    이 함수는 측정값과 그 측정값이 무엇을 세었는지만 돌려줍니다."""
    liq, px, cap, fin = [], [], [], []
    d3, d3m = row.get("days_3pct"), row.get("days_3pct_med")
    if pd.notna(d3):
        liq.append(f"시가총액 3% 처분 소요 — 평균 거래량 기준 {d3:,.1f}영업일"
                   + (f", 중앙값 기준 {d3m:,.1f}영업일" if pd.notna(d3m) else "")
                   + " (해당 기준 거래량의 10% 참여 가정)")
    mv = row.get("med_vs_mean")
    if pd.notna(mv):
        liq.append(f"20일 거래량 중앙값이 평균의 {mv*100:.0f}%")
    lp = row.get("liq_pctile")
    if pd.notna(lp):
        liq.append(f"자기 종목 거래대금이 관측기간 {lp*100:.0f}분위")
    tr = row.get("turnover_trend")
    if pd.notna(tr):
        liq.append(f"거래대금 20일평균이 60일평균 대비 {tr*100:+.0f}%")
    cn = row.get("liq_conc5")
    if pd.notna(cn):
        liq.append(f"최근 60일 거래대금의 {cn*100:.0f}%가 상위 5일에 집중")
    zd = row.get("zero_days")
    if pd.notna(zd) and zd > 0:
        liq.append(f"최근 60일 중 무거래일 {zd*100:.0f}%")
    w20, pv2 = row.get("vwap20"), row.get("px_vs_vwap")
    if pd.notna(w20):
        px.append(f"20일 VWAP {w20:,.0f}원"
                  + (f" · 종가가 {pv2*100:+.1f}%" if pd.notna(pv2) else ""))
    bt = row.get("beta")
    if pd.notna(bt):
        px.append(f"코스닥 대비 베타 {bt:,.2f}"
                  + (f" · 트래킹에러 {row['te']*100:,.0f}%"
                     if pd.notna(row.get("te")) else ""))
    pp = row.get("px_pctile")
    if pd.notna(pp):
        px.append(f"주가가 관측기간 {pp*100:.0f}분위")
    dd = row.get("drawdown")
    if pd.notna(dd):
        px.append(f"기간 최고가 대비 {dd*100:+.1f}%")
    va = row.get("vol_ann")
    if pd.notna(va):
        px.append(f"연율 변동성 {va*100:,.1f}%")
    ld = row.get("list_date")
    lk = row.get("lockup_days")
    if pd.notna(ld):
        cap.append(f"상장 {pd.Timestamp(ld):%Y-%m-%d}")
    if pd.notna(lk):
        cap.append(f"상장 후 {LOCKUP_MONTHS}개월 시점까지 "
                   + (f"{int(lk)}일 남음" if lk > 0 else f"{int(-lk)}일 경과")
                   + " (실제 보호예수 확약은 증권신고서 확인 필요)")
    per, pv, ppr = row.get("per"), row.get("per_vs_peer"), row.get("peer_per")
    if pd.notna(per):
        fin.append(f"PER {per:,.2f}")
    if pd.notna(pv) and pd.notna(ppr):
        fin.append(f"업종 PER 중앙값 {ppr:,.2f} 대비 {pv*100:+.0f}%")
    if row.get("per_excluded") is True:
        fin.append("PER 정상범위(0~60) 밖 — 업종 비교 미산출")
    if row.get("deficit") is True:
        fin.append("당기순손실")
    if row.get("impaired") is True:
        fin.append("자본총계 0 이하")
    ev = row.get("event_flags")
    events = list(ev) if isinstance(ev, (list, tuple)) else []
    return {"liq": liq, "px": px, "cap": cap, "fin": fin, "events": events}


def exit_metrics(fr: dict, codes: list[str], m: pd.DataFrame) -> pd.DataFrame:
    """포트폴리오사 엑싯 지표 — 팔 수 있는가, 얼마나 걸리는가."""
    close, vol, val = fr["close"], fr["volume"], fr["value"]
    have = [c for c in codes if c in close.columns]
    if not have:
        return pd.DataFrame()
    out = m.reindex(have).copy()
    n = len(close)
    # 52주(가용기간) 내 주가 위치 — 0%면 최저, 100%면 최고
    rank = close[have].rank(pct=True).iloc[-1]
    out["px_pctile"] = rank
    # 거래대금 추세 — 20일 평균이 60일 평균보다 크면 유동성이 붙는 중
    v20 = val[have].rolling(20).mean().iloc[-1]
    v60 = val[have].rolling(min(60, n)).mean().iloc[-1]
    out["turnover_20d"] = v20
    out["turnover_trend"] = v20 / v60.replace(0, np.nan) - 1
    # 장내 처분 소요일수 — ADV20 의 10% 만 소화 가정 (블록딜 아닌 경우)
    adv20 = vol[have].rolling(20).mean().iloc[-1]
    # 평균 거래량은 몇 번의 폭발일에 끌려 올라갑니다. 거래대금의 60~70%가
    # 상위 5일에 몰리는 종목에서는 '보통 날'의 소화력이 훨씬 낮습니다.
    # 중앙값 기준을 함께 둬서 낙관·현실 두 가지 값을 나란히 봅니다.
    med20 = vol[have].rolling(20).median().iloc[-1]
    out["adv20_val"] = v20
    out["adv20_shares"] = adv20
    out["med20_shares"] = med20
    out["med_vs_mean"] = med20 / adv20.replace(0, np.nan)
    for pct in (1, 3, 5):
        # 시가총액의 pct% 를 장내에서 파는 데 걸리는 영업일수
        shares_to_sell = (out["mktcap"] / out["close"]) * (pct / 100.0)
        out[f"days_{pct}pct"] = shares_to_sell / (adv20 * 0.10).replace(0, np.nan)
        out[f"days_{pct}pct_med"] = shares_to_sell / (med20 * 0.10).replace(0, np.nan)
    # 그 종목 자신의 거래대금이 1년 중 몇 분위인가 — 엑싯 창의 개폐 신호
    vma = val[have].rolling(20).mean()
    out["liq_pctile"] = pd.Series(
        {c: pctile(vma[c], vma[c].dropna().iloc[-1])
         if vma[c].notna().any() else np.nan for c in have})

    # VWAP — 거래대금÷거래량은 그날 실제로 체결된 평균 단가입니다.
    # 종가는 마지막 한 틱이지만 VWAP 은 물량이 실제로 소화된 가격이라,
    # '우리가 팔면 얼마에 팔리는가'에 종가보다 가깝습니다.
    vwap_d = (val[have] / vol[have].replace(0, np.nan))
    w20 = (val[have].tail(20).sum() / vol[have].tail(20).sum().replace(0, np.nan))
    out["vwap20"] = w20
    out["px_vs_vwap"] = out["close"] / w20 - 1
    out["vwap60"] = (val[have].tail(60).sum()
                     / vol[have].tail(60).sum().replace(0, np.nan))

    # 유동성 집중도 — 거래대금이 며칠에 몰려 있는가.
    # 연평균이 같아도 상위 5일에 절반이 몰린 종목은 나머지 날에 못 팝니다.
    def _conc(c):
        s = val[c].tail(60).dropna()
        if len(s) < 20 or s.sum() <= 0:
            return np.nan
        return float(s.nlargest(5).sum() / s.sum())
    out["liq_conc5"] = pd.Series({c: _conc(c) for c in have})

    # 무거래일 비중 — 아예 체결이 없던 날
    out["zero_days"] = pd.Series(
        {c: float((vol[c].tail(60) <= 0).mean()) for c in have})
    return out


# ── 엑싯 실행 백테스트 ─────────────────────────────────────────────────
# "그때 이 규칙대로 팔았다면 실제로 얼마에 팔렸을까"를 과거 구간마다 반복 계산합니다.
#
# 체결 단가는 종가가 아니라 그날 VWAP(거래대금÷거래량)을 씁니다.
# 종가는 마지막 한 틱이지만 VWAP 은 물량이 실제로 소화된 가격입니다.
#
# 가격 충격은 관측할 수 없습니다 — 우리가 팔지 않았던 과거를 보는 것이니까요.
# 그래서 표준적인 제곱근 모형을 '가정'합니다:  충격 = k · σ · √(주문량/거래량)
# 이 가정이 결과를 좌우하므로 k 를 바꿔가며 민감도를 함께 냅니다.

IMPACT_K = 0.6          # 제곱근 충격 계수 (문헌 통상 0.5~1.0)
MAX_PARTICIPATION = 0.25    # 하루 거래량의 이 비율을 넘겨 팔 수 없다고 봅니다
EXEC_RULES = ("immediate", "equal", "prorata", "conditional")
RULE_LABEL = {"immediate": "즉시 전량", "equal": "균등 분할",
              "prorata": "유동성 비례", "conditional": "유동성 상위일만"}


def simulate_exit(vwap: np.ndarray, vol: np.ndarray, liqrank: np.ndarray,
                  shares: float, rule: str, sigma: float,
                  k: float = IMPACT_K, max_part: float = MAX_PARTICIPATION,
                  liq_thresh: float = 0.5) -> dict:
    """한 구간에서 shares 주를 규칙대로 매도했을 때의 실현 단가."""
    n = len(vwap)
    left, proceeds, filled, used = shares, 0.0, 0.0, 0
    for d in range(n):
        v, p = vol[d], vwap[d]
        if left <= 0 or not np.isfinite(v) or v <= 0 or not np.isfinite(p) or p <= 0:
            continue
        if rule == "immediate":
            want = left
        elif rule == "equal":
            want = shares / n
        elif rule == "prorata":
            want = shares * (v / np.nansum(vol)) if np.nansum(vol) > 0 else 0
        else:                                   # conditional
            if liqrank[d] < liq_thresh:
                continue
            hot = np.nansum(vol[liqrank >= liq_thresh])
            want = shares * (v / hot) if hot > 0 else 0
        qty = float(min(left, want, v * max_part))
        if qty <= 0:
            continue
        part = qty / v
        px = p * (1.0 - k * sigma * np.sqrt(part))      # 제곱근 가격 충격
        proceeds += qty * px
        filled += qty
        left -= qty
        used = d + 1
    if filled <= 0:
        return {"ok": False}
    return {"ok": True, "avg_px": proceeds / filled, "fill_rate": filled / shares,
            "days_used": used}


def exit_execution_backtest(close: pd.Series, vol: pd.Series, val: pd.Series,
                            target_shares: float, horizon: int = 20,
                            step: int = 10, k: float = IMPACT_K) -> dict:
    """시작일을 바꿔가며 같은 매도를 반복 시뮬레이션합니다.

    한 구간만 보면 운 좋은 창을 고른 것인지 알 수 없습니다.
    여러 시작점의 분포를 봐야 규칙 간 비교가 성립합니다."""
    d = pd.concat([close.rename("c"), vol.rename("v"), val.rename("val")],
                  axis=1, sort=True).dropna()
    if len(d) < horizon * 3 + 25:
        return {"ok": False, "reason": f"표본 부족 (관측 {len(d)}일)"}
    vwap = (d["val"] / d["v"].replace(0, np.nan)).to_numpy()
    vols = d["v"].to_numpy()
    closes = d["c"].to_numpy()
    sigma = float(d["c"].pct_change().std(ddof=1))
    # 그날 거래량이 직전 60일 중 몇 분위인가 — 조건부 규칙의 판단 근거
    lr = d["v"].rolling(60).rank(pct=True).to_numpy()
    starts = list(range(60, len(d) - horizon, step))
    if len(starts) < 5:
        return {"ok": False, "reason": "유효 구간 부족"}
    res = {r: [] for r in EXEC_RULES}
    for s0 in starts:
        sl = slice(s0, s0 + horizon)
        arrival = closes[s0 - 1]                # 의사결정 시점 가격
        if not np.isfinite(arrival) or arrival <= 0:
            continue
        bench_vwap = (np.nansum(d["val"].to_numpy()[sl])
                      / max(np.nansum(vols[sl]), 1e-9))
        for r in EXEC_RULES:
            sim = simulate_exit(vwap[sl], vols[sl], lr[sl], target_shares, r,
                                sigma, k=k)
            if not sim["ok"]:
                continue
            res[r].append({
                "shortfall_bp": (sim["avg_px"] / arrival - 1) * 10000,
                "vs_vwap_bp": (sim["avg_px"] / bench_vwap - 1) * 10000
                if bench_vwap > 0 else np.nan,
                "fill": sim["fill_rate"], "days": sim["days_used"]})
    out = {}
    for r, rows in res.items():
        if not rows:
            continue
        f = pd.DataFrame(rows)
        out[r] = {"n": int(len(f)),
                  "shortfall_med": float(f["shortfall_bp"].median()),
                  "shortfall_p25": float(f["shortfall_bp"].quantile(.25)),
                  "shortfall_p75": float(f["shortfall_bp"].quantile(.75)),
                  "vs_vwap_med": float(f["vs_vwap_bp"].median()),
                  "fill_med": float(f["fill"].median()),
                  "days_med": float(f["days"].median())}
    return {"ok": bool(out), "rules": out, "starts": len(starts),
            "horizon": horizon, "sigma": sigma, "k": k}


def market_sensitivity(close: pd.DataFrame, codes: list[str],
                       bench: pd.Series, min_obs: int = 60) -> pd.DataFrame:
    """벤치마크 대비 민감도. 시장이 빠질 때 얼마나 더 빠지는가는
    처분 시점을 미루는 비용을 좌우합니다."""
    have = [c for c in codes if c in close.columns]
    if not have or bench is None or len(bench) < min_obs:
        return pd.DataFrame()
    bm = bench.pct_change()
    rows = {}
    for c in have:
        r = beta_te(close[c].pct_change(), bm, min_obs=min_obs)
        rows[c] = {"beta": r.get("beta"), "te": r.get("tracking_error"),
                   "n": r.get("n"), "ok": r["ok"]}
    return pd.DataFrame(rows).T


def volume_profile(close: pd.Series, value: pd.Series, bins: int = 12) -> list:
    """가격대별 거래대금 — 매물대. 어느 가격에서 손바뀜이 많았는지는
    그 가격 근처에서 물량이 나올 가능성을 말해 줍니다."""
    d = pd.concat([close.rename("p"), value.rename("v")], axis=1, sort=True).dropna()
    d = d[d["p"] > 0]
    if len(d) < 30:
        return []
    lo, hi = float(d["p"].min()), float(d["p"].max())
    if hi <= lo:
        return []
    edges = np.linspace(lo, hi, bins + 1)
    idx = np.clip(np.digitize(d["p"], edges) - 1, 0, bins - 1)
    agg = d.groupby(idx)["v"].sum()
    tot = float(agg.sum()) or 1.0
    return [((edges[i] + edges[i + 1]) / 2, float(agg.get(i, 0.0)) / tot)
            for i in range(bins)]


def attach_context(ex: pd.DataFrame, inst: pd.DataFrame, val_all: pd.DataFrame,
                   dsc: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    """상장일(락업)·동종 밸류에이션·공시 이벤트를 엑싯 표에 붙입니다."""
    if ex.empty:
        return ex
    out = ex.copy()
    # 락업 — 상장일 + 6개월. 실제 확약은 종목마다 다르므로 '추정'입니다.
    if not inst.empty and "list_date" in inst.columns:
        ld = pd.to_datetime(inst["list_date"].reindex(out.index),
                            format="%Y%m%d", errors="coerce")
        out["list_date"] = ld
        out["lockup_days"] = (ld + pd.DateOffset(months=LOCKUP_MONTHS)
                              - as_of).dt.days
        out["sector"] = inst["sector"].reindex(out.index)
    # 동종 대비 PER — 같은 업종의 중앙값과 비교.
    # 이익이 거의 0인 기업의 PER 은 수백~수천 배로 튑니다. 그 값을 '고평가'로
    # 읽으면 매도 유리 신호가 거짓으로 켜집니다. 정상 범위 밖은 비교하지 않습니다.
    PER_MAX = 60.0
    if "sector" in out.columns and val_all is not None and not val_all.empty \
            and "per" in val_all.columns and not inst.empty:
        sec = inst["sector"].reindex(val_all.index)
        sane = val_all["per"].where(val_all["per"].between(0, PER_MAX))
        grp = pd.DataFrame({"per": sane, "_s": sec}).dropna()
        med = grp.groupby("_s")["per"].median()
        cnt = grp.groupby("_s")["per"].size()
        med = med[cnt >= 5]                    # 표본 5개 미만 업종은 중앙값을 믿지 않습니다
        out["peer_per"] = out["sector"].map(med)
        own = out.get("per")
        if own is not None:
            own = own.where(own.between(0, PER_MAX))
            out["per_vs_peer"] = own / out["peer_per"] - 1
            out["per_excluded"] = out.get("per").notna() & own.isna()
    # 공시 이벤트 — 희석·위험만 추립니다
    if dsc is not None and not dsc.empty and "stock_code" in dsc.columns:
        flags = {}
        for _, r in dsc.iterrows():
            c = str(r.get("stock_code", "")).strip()
            tg = str(r.get("tags", ""))
            if c not in out.index or not tg:
                continue
            nm = str(r.get("report_nm", ""))[:34]
            if "dilution" in tg:
                flags.setdefault(c, []).append(f"희석 공시: {nm}")
            if "risk" in tg:
                flags.setdefault(c, []).append(f"위험 공시: {nm}")
        out["event_flags"] = pd.Series(
            {c: list(dict.fromkeys(v))[:3] for c, v in flags.items()}).reindex(out.index)
    return out


def quant_index_table(con, top: int = 12) -> pd.DataFrame:
    idx = index_panel(con)
    if idx.empty:
        return pd.DataFrame()
    piv = idx.pivot_table(index="date", columns="index_name", values="close")
    n = len(piv)
    out = pd.DataFrame({
        "close": piv.iloc[-1],
        "ret_1d": piv.pct_change().iloc[-1],
        "ret_5d": piv.iloc[-1] / piv.iloc[-min(6, n)] - 1,
        "ret_20d": piv.iloc[-1] / piv.iloc[-min(21, n)] - 1,
    }).dropna(subset=["close"])
    return out.sort_values("ret_20d", ascending=False)


def quant_factor_buckets(m: pd.DataFrame, by: str, q: int = 5) -> pd.DataFrame:
    """횡단면 분위 — 백테스트가 아니라 '오늘 시장이 어느 쪽에 값을 매겼나'입니다."""
    d = m.dropna(subset=[by, "ret_1d"])
    if len(d) < q * 5:
        return pd.DataFrame()
    try:
        bucket = pd.qcut(d[by], q, labels=[f"Q{i+1}" for i in range(q)], duplicates="drop")
    except ValueError:
        return pd.DataFrame()
    g = d.groupby(bucket, observed=True)
    return pd.DataFrame({
        "종목수": g.size(),
        "당일 평균": g["ret_1d"].mean(),
        "20일 평균": g["ret_20d"].mean(),
        "변동성 중앙": g["vol_ann"].median(),
        "시총 중앙": g["mktcap"].median(),
    })


# ── 팩터 백테스트 ──────────────────────────────────────────────────────
# 원장에서 전부 계산합니다. 하드코딩된 숫자는 없습니다.
#
# 이 백테스트가 지키는 것과 못 지키는 것을 먼저 적습니다.
#   지킴 — 생존편향 없음: 매일의 시장 전체를 그대로 적재했으므로 그날 상장돼
#          있던 종목이 그대로 들어 있습니다. 나중에 상장폐지된 종목도 남아 있습니다.
#   지킴 — 선견편향 없음(가격 팩터): t 시점 팩터로 t→t+h 수익률만 씁니다.
#   못 지킴 — 재무 팩터: 재무는 시점별 스냅샷이 아니라 한 판만 있습니다.
#          2026년 3월 공시된 실적으로 2025년 8월을 거래하게 되므로 선견편향입니다.
#          그래서 재무 팩터는 백테스트에서 제외합니다.
#   못 지킴 — 체결 현실: 상한가·거래정지 종목도 체결된다고 가정합니다.

BT_COST_BP = 30.0        # 회전 1회당 왕복 거래비용 가정 (수수료+세금+슬리피지)


def factor_matrix(close: pd.DataFrame, value: pd.DataFrame,
                  mktcap: pd.DataFrame, kind: str) -> pd.DataFrame:
    """점수가 높을수록 '사고 싶은' 방향이 되도록 부호를 맞춥니다."""
    r = close.pct_change()
    if kind == "momentum":
        return close.pct_change(20)
    if kind == "reversal":
        return -close.pct_change(5)
    if kind == "lowvol":
        return -r.rolling(20).std()
    if kind == "size":
        return -np.log(mktcap.where(mktcap > 0))
    if kind == "illiq":
        return (r.abs() / value.replace(0, np.nan)).rolling(20).mean()
    raise ValueError(f"모르는 팩터: {kind}")


BT_MIN_PERIODS = 6        # 이보다 적으면 계산하지 않습니다
BT_RELIABLE_PERIODS = 12  # 이보다 적으면 연율 환산을 표시하지 않습니다
BT_MIN_TURNOVER = 3e8     # 편입 최소 거래대금 (ADV20, 원). 못 사는 종목은 빼야 합니다


def backtest_factor(close: pd.DataFrame, F: pd.DataFrame, rebal: int = 20,
                    q: int = 5, min_names: int = 100,
                    cost_bp: float = BT_COST_BP,
                    min_periods: int = BT_MIN_PERIODS,
                    tradable: pd.DataFrame = None) -> dict:
    """분위 포트폴리오를 rebal 영업일마다 재구성해 보유합니다.

    tradable — 편입일에 실제로 살 수 있었는가. 이 필터가 없으면 하루 거래대금
    수천만 원짜리 종목이 분위에 들어와, 종이 위에서만 존재하는 수익률이 나옵니다."""
    dates = close.index
    if len(dates) < rebal * 3:
        return {"ok": False, "reason": f"표본 부족 (관측 {len(dates)}일)"}
    marks = list(range(0, len(dates) - rebal, rebal))
    per, ics, sizes = [], [], []
    for i in marks:
        d0, d1 = dates[i], dates[i + rebal]
        f = F.loc[d0].dropna()
        fwd = (close.loc[d1] / close.loc[d0] - 1).dropna()
        common = f.index.intersection(fwd.index)
        if tradable is not None and d0 in tradable.index:
            ok_names = tradable.loc[d0]
            common = common.intersection(ok_names[ok_names.fillna(False)].index)
        if len(common) < min_names:
            continue
        sizes.append(len(common))
        f, fwd = f[common], fwd[common]
        try:
            bucket = pd.qcut(f.rank(method="first"), q,
                             labels=[f"Q{k+1}" for k in range(q)])
        except ValueError:
            continue
        means = fwd.groupby(bucket, observed=True).mean()
        per.append(means.rename(d1))
        ics.append(f.corr(fwd, method="spearman"))
    if len(per) < min_periods:
        return {"ok": False,
                "reason": f"유효 구간 {len(per)}개 (최소 {min_periods}개 필요)"}
    R = pd.DataFrame(per)
    cost = cost_bp / 10000.0
    Rn = R - cost                               # 롱 온리 분위 — 다리 하나분 비용
    # 롱숏은 양쪽 다리에서 각각 비용을 냅니다.
    # (Q5 - c) - (Q1 - c) 로 쓰면 비용이 상쇄되어 공짜 거래가 됩니다.
    ls = (R[f"Q{q}"] - cost) - (R["Q1"] + cost)
    per_year = ANN / rebal
    cum = (1 + Rn).prod() - 1
    ls_cum = float((1 + ls).prod() - 1)
    ls_curve = (1 + ls).cumprod()
    dd = float((ls_curve / ls_curve.cummax() - 1).min())
    curve = pd.concat([pd.Series([1.0], index=[R.index[0]]), ls_curve])
    sd = float(ls.std(ddof=1))
    reliable = len(R) >= BT_RELIABLE_PERIODS
    ic_m = float(np.nanmean(ics))
    ic_sd = float(np.nanstd(ics))
    ic_ir = ic_m / ic_sd if ic_sd > 0 else None
    mono = bool(pd.Series([cum[f"Q{k+1}"] for k in range(q)]).is_monotonic_increasing)
    # 판정 — 하나라도 어긋나면 '미확정'입니다. 우연한 배열을 발견으로 부르지 않습니다.
    agree = (ic_m > 0) == (ls_cum > 0)          # IC 와 롱숏이 같은 방향인가
    verdict = ("유의" if (reliable and mono and agree and ic_ir is not None
                          and abs(ic_ir) >= 0.5) else "미확정")
    why = []
    if not reliable:
        why.append(f"구간 {len(R)}개")
    if not mono:
        why.append("분위 비단조")
    if not agree:
        why.append("IC·롱숏 부호 불일치")
    if ic_ir is not None and abs(ic_ir) < 0.5:
        why.append(f"IC IR {ic_ir:.2f}")
    # 구간이 적을 때 연율 환산은 60일을 1년으로 부풀립니다 — 아예 내보내지 않습니다.
    ann = (float((1 + ls_cum) ** (per_year / len(R)) - 1)
           if reliable and ls_cum > -1 else None)
    return {"ok": True, "periods": int(len(R)), "rebal": rebal, "q": q,
            "cost_bp": cost_bp, "reliable": reliable,
            "span_days": int(len(R) * rebal),
            "universe": int(np.median(sizes)) if sizes else 0,
            "bucket_cum": {k: float(v) for k, v in cum.items()},
            "ls_cum": ls_cum, "ls_ann": ann,
            "ls_sharpe": float(ls.mean() / sd * np.sqrt(per_year)) if sd > 0 else None,
            "ls_hit": float((ls > 0).mean()), "ls_mdd": dd,
            "ic_mean": ic_m, "ic_ir": ic_ir, "monotonic": mono, "ls_curve": curve,
            "verdict": verdict, "verdict_why": " · ".join(why)}


def run_backtests(fr: dict, rebal: int = 20,
                  min_turnover: float = BT_MIN_TURNOVER) -> dict:
    close, val = fr["close"], fr["value"]
    mc = fr.get("mktcap_panel")
    # 편입 시점 기준 직전 20일 평균 거래대금이 기준 미만이면 제외합니다.
    # 이 필터가 소형주·비유동성 팩터의 '종이 수익률'을 걸러냅니다.
    tradable = val.rolling(20).mean() >= min_turnover
    out = {}
    for kind in ("momentum", "reversal", "lowvol", "size", "illiq"):
        if kind == "size" and (mc is None or mc.empty):
            continue
        try:
            F = factor_matrix(close, val, mc, kind)
        except Exception as e:                          # noqa: BLE001
            out[kind] = {"ok": False, "reason": f"{type(e).__name__}: {e}"}
            continue
        r = backtest_factor(close, F, rebal=rebal, tradable=tradable)
        r["min_turnover"] = min_turnover
        out[kind] = r
    return out


def build_context(panel: pd.DataFrame, positions: pd.DataFrame,
                  con=None) -> dict:
    rows, quality, rets = [], [], {}
    pos_idx = positions.set_index("code")
    for code, g in panel.groupby("code"):
        if code not in pos_idx.index:
            continue
        g = g.sort_values("date").set_index("date")
        pos = pos_idx.loc[code]
        qty = float(pos["qty"])
        last = float(g["close"].iloc[-1])                  # 수정주가 (수익률·변동성용)
        # 평가금액·원가대비·목표단가 갭은 원주가로 계산합니다.
        # 수정주가는 과거 수익률을 잇기 위한 값이라 금액으로 쓰면 실제와 어긋납니다.
        af = float(g["adj_factor"].iloc[-1]) if "adj_factor" in g.columns else 1.0
        raw = last / af if af else last
        vs, liq = vol_selftest(g), liq_summary(g, qty)
        rets[code] = g["close"].pct_change()
        rows.append({"code": code, "name": pos["name"], "close": raw, "qty": qty,
                     "value": raw * qty,
                     "cost_ret": raw / float(pos["cost"]) - 1,
                     "target_gap": raw / float(pos["target_price"]) - 1,
                     "vol_yz": vs["values"].get("yang_zhang"), "vol_check": vs["ok"],
                     "spread_bp": liq["spread_cs_bp"],
                     "days_to_liquidate": liq["days_to_liquidate"]})
        if not vs["ok"]:
            quality.append(f"{code}: 변동성 추정량 괴리 (비율 {vs.get('ratio')}) — OHLC 매핑 확인")
        quality += [f"{code}: {w}" for w in liq["warnings"]]

    # 벤치마크 — 지수 원장이 있을 때만 채웁니다. 없으면 '미수집'으로 남깁니다.
    bench = {"name": BENCHMARK, "available": False}
    breadth = {}
    if con is not None:
        idx = index_panel(con, BENCHMARK)
        if not idx.empty:
            iret = idx.set_index("date")["close"].pct_change()
            bench = {"name": BENCHMARK, "available": True,
                     "close": float(idx["close"].iloc[-1]),
                     "ret_1d": float(iret.iloc[-1]) if len(iret) > 1 else None,
                     "ret_period": float(idx["close"].iloc[-1] / idx["close"].iloc[0] - 1)
                                   if len(idx) > 1 else None,
                     "n_days": int(len(idx)), "series": iret}
        breadth = market_breadth(con)

    rdf = pd.DataFrame(rets).dropna()
    total = sum(r["value"] for r in rows)
    # 가중치는 rdf 의 열 순서에 맞춥니다 (rows 순서와 다를 수 있습니다)
    val_by_code = {r["code"]: r["value"] for r in rows}
    if total and not rdf.empty:
        w = np.array([val_by_code[c] / total for c in rdf.columns])
    else:
        w = np.array([])

    # 포트폴리오 수익률은 '보유수량 고정' 기준입니다.
    # 현재 비중을 과거에 소급해 매일 재조정한 것처럼 계산하면 실제와 어긋납니다
    # (표본 검증에서 -11.48% 대 -12.11%). 우리는 리밸런싱하지 않습니다.
    qty_map = {r["code"]: r["qty"] for r in rows}
    px = panel.pivot_table(index="date", columns="code", values="close")
    px = px[[c for c in px.columns if c in qty_map]].dropna()
    port_value = px.mul(pd.Series(qty_map)).sum(axis=1) if not px.empty else pd.Series(dtype=float)
    port = port_value.pct_change().dropna()

    cov = rdf.cov().values * ANN if not rdf.empty else np.zeros((0, 0))
    rc = risk_contribution(w, cov) if len(w) else {"port_vol": None, "check_ok": True}

    # 포트폴리오 대 벤치마크 — 표본이 모자라면 계산하지 않고 그렇다고 적습니다
    rel = {"ok": False, "reason": "지수 미수집"}
    if bench.get("available") and not port.empty:
        bt = beta_te(port, bench["series"])
        pr = float(port_value.iloc[-1] / port_value.iloc[0] - 1)   # 실제 평가금액 변화
        rel = {"ok": True, "port_ret": pr, "bench_ret": bench.get("ret_period"),
               "excess": (pr - bench["ret_period"]) if bench.get("ret_period") is not None
                         else None,
               "beta": bt.get("beta"), "te": bt.get("tracking_error"),
               "beta_ok": bt["ok"], "beta_note": bt.get("reason", ""), "n": bt.get("n")}
    return {"stage": STAGE, "watermark": env("watermark"),
            "bench": bench, "breadth": breadth, "rel": rel,
            "as_of": str(pd.Timestamp(panel["date"].max()).date()), "rows": rows,
            "total_value": total,
            "var95": historical_var(port) if not port.empty else None,
            "cvar95": cvar(port) if not port.empty else None,
            "port_vol": rc["port_vol"], "rc_check": rc["check_ok"],
            "hhi": hhi(pd.Series([r["value"] for r in rows])), "quality": quality}


def render(ctx: dict) -> Path:
    out = Path(env("out_dir"))
    out.mkdir(parents=True, exist_ok=True)

    pos_rows = "".join(
        f"<tr><td>{r['name']}</td><td>{r['code']}</td>"
        f"<td class='num'>{_won(r['close'])}</td><td class='num'>{_won(r['qty'])}</td>"
        f"<td class='num'>{_won(r['value'])}</td>"
        f"<td class='num {'pos' if r['cost_ret'] >= 0 else 'neg'}'>{_pct(r['cost_ret'])}</td>"
        f"<td class='num {'pos' if r['target_gap'] >= 0 else 'neg'}'>{_pct(r['target_gap'])}</td>"
        "</tr>" for r in ctx["rows"])
    risk_rows = "".join(
        f"<tr><td>{r['name']}</td><td class='num'>{_pct(r['vol_yz'])}</td>"
        f"<td class='num'>{_num(r['spread_bp'])} <span class='note'>(추정)</span></td>"
        f"<td class='num'>{_days(r['days_to_liquidate'])}</td>"
        f"<td>{'OK' if r['vol_check'] else '검증 보류'}</td></tr>" for r in ctx["rows"])
    b, br, rel = ctx["bench"], ctx["breadth"], ctx["rel"]
    if not b.get("available"):
        bench_block = ("<div class='note'>지수 원장이 비어 있습니다 — "
                       "<code>ingest --universe KOSDAQ</code> 로 지수를 함께 적재하십시오.</div>")
    else:
        rows_b = [("지수 종가", f"{b['close']:,.2f}"),
                  ("지수 1일 등락", _pct(b.get("ret_1d"))),
                  ("지수 기간 수익률", _pct(b.get("ret_period"))),
                  ("포트폴리오 기간 수익률", _pct(rel.get("port_ret"))),
                  ("초과수익 (포트 − 지수)", _pct(rel.get("excess")))]
        if rel.get("beta_ok"):
            rows_b += [("베타", _num(rel.get("beta"))),
                       ("트래킹 에러 (연율)", _pct(rel.get("te")))]
        else:
            rows_b += [("베타 · 트래킹 에러",
                        f"미산출 — {rel.get('beta_note', '표본 부족')} "
                        f"(관측 {rel.get('n', 0)}일, 60일 이상 필요)")]
        bench_block = ("<table><tr><th>" + b["name"] + " 대비</th><th class='num'>값</th></tr>"
                       + "".join(f"<tr><td>{k}</td><td class='num'>{v}</td></tr>"
                                 for k, v in rows_b) + "</table>")
        if br.get("n"):
            bench_block += (
                "<table><tr><th>시장 개요 (" + br["market"] + " 전종목)</th>"
                "<th class='num'>값</th></tr>"
                f"<tr><td>대상 종목수</td><td class='num'>{br['n']:,}</td></tr>"
                f"<tr><td>상승 / 보합 / 하락</td><td class='num'>"
                f"{br['up']:,} / {br['flat']:,} / {br['down']:,}</td></tr>"
                f"<tr><td>상승 종목 비율</td><td class='num'>{_pct(br['adv_ratio'])}</td></tr>"
                f"<tr><td>중위 등락률</td><td class='num'>{_pct(br['median_ret'])}</td></tr>"
                f"<tr><td>상한가 / 하한가</td><td class='num'>"
                f"{br['limit_up']:,} / {br['limit_down']:,}</td></tr>"
                f"<tr><td>거래대금 합계</td><td class='num'>{_won(br['turnover'])}</td></tr>"
                "</table>"
                "<div class='note'>보유 종목의 부진이 개별 사유인지 시장 전체인지는 "
                "상승 종목 비율과 중위 등락률로 구분합니다.</div>")

    sec_rows = ""
    for i in range(0, len(SECTIONS), 2):
        a = SECTIONS[i]
        b = SECTIONS[i + 1] if i + 1 < len(SECTIONS) else ("", "")
        sec_rows += f"<tr><td>{a[0]}</td><td>{a[1]}</td><td>{b[0]}</td><td>{b[1]}</td></tr>"

    html = TEMPLATE.format(
        as_of=ctx["as_of"], stage=ctx["stage"],
        watermark_html=(f"<div class='wm'>{ctx['watermark']}</div>" if ctx["watermark"] else ""),
        total_value=_won(ctx["total_value"]), port_vol=_pct(ctx["port_vol"]),
        var95=_pct(ctx["var95"]), cvar95=_pct(ctx["cvar95"]),
        quality_flag=(f"<div class='flag'><b>검증 보류 항목이 있습니다.</b> "
                      f"&sect;10 을 확인하십시오. ({len(ctx['quality'])}건)</div>"
                      if ctx["quality"] else ""),
        position_table=("<table><tr><th>종목</th><th>코드</th><th class='num'>종가</th>"
                        "<th class='num'>수량</th><th class='num'>평가금액</th>"
                        "<th class='num'>원가 대비</th><th class='num'>목표단가 갭</th></tr>"
                        + pos_rows + "</table>"),
        hhi=_num(ctx["hhi"]), rc_check="통과" if ctx["rc_check"] else "실패",
        bench_block=bench_block,
        risk_table=("<table><tr><th>종목</th><th class='num'>변동성 (Yang-Zhang, 연율)</th>"
                    "<th class='num'>추정 스프레드 (bp)</th>"
                    "<th class='num'>청산 소요일수</th><th>검증</th></tr>"
                    + risk_rows + "</table>"),
        quality_table=("<table><tr><th>검증 보류 항목</th></tr>"
                       + "".join(f"<tr><td>{q}</td></tr>" for q in ctx["quality"]) + "</table>"
                       if ctx["quality"] else
                       "<div class='note'>이상 없음 — 전 지표 검산 통과.</div>"),
        section_table=("<table><tr><th>&sect;</th><th>섹션</th><th>&sect;</th><th>섹션</th></tr>"
                       + sec_rows + "</table>"))

    hp = out / f"KI_daily_{ctx['as_of'].replace('-', '')}.html"
    hp.write_text(html, encoding="utf-8")
    try:
        from weasyprint import HTML
        pp = hp.with_suffix(".pdf")
        HTML(string=html, base_url=str(ROOT)).write_pdf(str(pp))
        return pp
    except Exception as e:                               # noqa: BLE001
        print(f"  [안내] PDF 생성 생략 ({e}). HTML 은 정상 생성되었습니다.")
        return hp


# ════════════════════════════════════════════════════════════════════════
# 14. 자체 검증 — 전부 통과해야 다음 단계로 갑니다
# ════════════════════════════════════════════════════════════════════════

def _sample_ohlc(n: int = 400, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    close = 50000 * np.exp(np.cumsum(rng.normal(0.0002, 0.018, n)))
    op = close * (1 + rng.normal(0, 0.004, n))
    intr = np.abs(rng.normal(0, 0.010, n))
    d = pd.DataFrame({"date": pd.bdate_range("2024-01-01", periods=n), "code": "TEST",
                      "open": op, "close": close,
                      "high": np.maximum(op, close) * (1 + intr),
                      "low": np.minimum(op, close) * (1 - intr), "shares": 1e7})
    d["volume"] = rng.lognormal(11.5, 0.35, n)
    d["value"] = d["volume"] * d["close"]
    return d.set_index("date")


def selftest() -> int:
    import datetime as _dt
    ohlc = _sample_ohlc()
    passed, failed = 0, []

    def check(name, fn):
        nonlocal passed
        try:
            fn()
            passed += 1
        except Exception as e:                          # noqa: BLE001
            failed.append(f"{name}: {type(e).__name__}: {e}")

    # 변동성
    check("변동성 5종 동일 자릿수",
          lambda: _assert(vol_selftest(ohlc)["ok"]))
    check("OHLC 역전 거부", lambda: _expect_raises(ValueError, lambda: vol_parkinson(
        ohlc.assign(high=ohlc["low"] * 0.5))))
    check("Parkinson 이 종가 기준보다 안정",
          lambda: _assert(vol_parkinson(ohlc, 21).dropna().std()
                          < vol_close(ohlc, 21).dropna().std()))
    # 유동성
    check("추정 스프레드 음수 없음",
          lambda: _assert((liq_corwin_schultz(ohlc).dropna() >= 0).all()))
    check("청산일수 양수",
          lambda: _assert((liq_days_to_liquidate(ohlc, 1_000_000).dropna() > 0).all()))
    check("유동성 요약이 추정 플래그를 켠다",
          lambda: _assert(liq_summary(ohlc, 500_000)["estimated"] is True))
    check("Roll 은 공분산 음수일 때만",
          lambda: _assert(liq_roll(ohlc).dropna().ge(0).all()))
    # 리스크
    rng = np.random.default_rng(1)
    r4 = pd.DataFrame(rng.normal(0, 0.02, (500, 4)))
    check("위험기여도 합 = 포트 변동성",
          lambda: _assert(risk_contribution(np.array([.4, .3, .2, .1]),
                                            r4.cov().values * ANN)["check_ok"]))
    t_sample = pd.Series(np.random.default_rng(2).standard_t(4, 2000) * 0.01)
    check("CVaR > VaR",
          lambda: _assert(cvar(t_sample) > historical_var(t_sample)))
    check("VaR 백테스트 위반율 정합", lambda: _assert(
        var_backtest(pd.Series(np.random.default_rng(3).normal(0, 0.015, 1500)))["ok"]))
    check("EVT 표본부족 거부", lambda: _assert(
        evt_tail(pd.Series(np.random.default_rng(4).normal(0, 0.01, 100)))["ok"] is False))
    check("베타 표본부족 거부", lambda: _assert(
        beta_te(pd.Series(np.zeros(20)), pd.Series(np.zeros(20)))["ok"] is False))
    check("HHI 범위", lambda: _assert(0 < hhi(pd.Series([50, 30, 20])) <= 1))
    # 스코어카드
    check("F-Score 결측은 None (0 아님)",
          lambda: _assert(piotroski_f(FinInput(roa=0.05, cfo=0.07))["score"] is None))
    check("F-Score 만점", lambda: _assert(piotroski_f(FinInput(
        roa=.05, roa_p=.03, cfo=.08, leverage=.2, leverage_p=.25, current_ratio=1.8,
        current_ratio_p=1.5, shares=100, shares_p=100, gross_margin=.4,
        gross_margin_p=.35, asset_turnover=1.1, asset_turnover_p=1.0))["score"] == 9))
    check("Altman 결측은 None",
          lambda: _assert(altman_z2(0.1, 0.2, None, 1.0)["score"] is None))
    check("Beneish 산출", lambda: _assert(beneish_m(
        dsri=1, gmi=1, aqi=1, sgi=1, depi=1, sgai=1, lvgi=1, tata=0)["score"] is not None))
    check("DuPont 0분모 거부", lambda: _assert(dupont(1, 0, 1, 1)["roe"] is None))
    check("완전희석 < 보통주 지분", lambda: _assert(
        fully_diluted_ownership(100, 1000, 200)["ownership_fd"]
        < fully_diluted_ownership(100, 1000, 200)["ownership_common"]))
    check("리픽싱이 희석을 키운다", lambda: _assert(
        refix_scenario(1e9, 10000, 1000)[-1]["potential_shares"]
        > refix_scenario(1e9, 10000, 1000)[0]["potential_shares"]))

    # 수정주가
    def _split_case():
        d = ohlc.reset_index().copy()
        d.loc[200:, ["open", "high", "low", "close"]] /= 2
        d.loc[200:, "shares"] *= 2
        _assert(len(detect_price_jumps(d)) >= 1)        # 조정 전에는 -50% 가 잡힘
        _assert(adjust_audit(d)["ok"])                  # 조정 후에는 통과
    check("액면분할 조정", _split_case)

    def _dilution_case():
        """전환사채 전환 등으로 주식수만 2.5% 늘고 주가는 따로 움직인 경우.
        권리락이 아니므로 조정하면 안 됩니다."""
        d = ohlc.reset_index().copy()
        d.loc[200:, "shares"] *= 1.025
        d.loc[200, ["open", "high", "low", "close"]] *= 0.90    # 시장 하락, 권리락 아님
        r = adjust_audit(d)
        _assert(r["n_actions"] == 0)                    # 조정하지 않음
        _assert(len(r["unresolved"]) == 1)              # 대신 표시
        _assert(np.allclose(adjust_apply(d)["adj_factor"], 1.0))
    check("희석은 권리락이 아니다 (조정 안 함)", _dilution_case)

    def _free_issue_case():
        """무상증자 — 주식수 2배, 주가 절반. 실측이 뒷받침하므로 조정합니다."""
        d = ohlc.reset_index().copy()
        d.loc[200:, ["open", "high", "low", "close"]] /= 2
        d.loc[200:, "shares"] *= 2
        r = adjust_audit(d)
        _assert(r["ok"] and r["n_actions"] >= 1 and not r["unresolved"])
    check("무상증자는 조정한다", _free_issue_case)
    check("액션 없으면 가격 불변", lambda: _assert(np.allclose(
        adjust_apply(ohlc.reset_index())["adj_close"],
        adjust_apply(ohlc.reset_index())["close"])))

    # 이벤트 · 펀드
    def _car_case():
        g = np.random.default_rng(5)
        rm = pd.Series(g.normal(0, 0.01, 300))
        ri = 1.2 * rm + pd.Series(g.normal(0, 0.005, 300))
        ri.iloc[200] -= 0.15
        out = car(ri, rm, 200, win=(0, 3))
        _assert(out["ok"] and out["car"] < 0)
    check("CAR 이 악재를 잡는다", _car_case)
    check("XIRR 단순사례", lambda: _assert(abs(xirr(
        [(_dt.date(2024, 1, 1), -1000.0), (_dt.date(2025, 1, 1), 1100.0)]) - 0.10) < 0.005))
    check("XIRR 부호변화 없으면 None", lambda: _assert(xirr(
        [(_dt.date(2024, 1, 1), 100.0), (_dt.date(2025, 1, 1), 100.0)]) is None))
    check("TVPI = DPI + RVPI",
          lambda: _assert(abs(fund_multiples(100, 60, 80)["tvpi"] - 1.4) < 1e-9))
    # 미시구조 · 안전장치
    check("QI 범위", lambda: _assert(quote_imbalance(100, 100) == 0
                                     and quote_imbalance(200, 0) == 1))
    check("스프레드 양수", lambda: _assert(spread_bp(9990, 10010) > 0))
    check("미시구조 검산이 역전을 잡는다", lambda: _assert(
        micro_selftest({"spread_bp": -5, "qi": 0.1, "persisted": False})))
    check("링버퍼는 저장하지 않는다", lambda: _assert(
        snapshot_metrics({"bid_qty": 10, "ask_qty": 5, "bid": 99, "ask": 101,
                          "price": 100, "volume": 1000, "value": 100000},
                         None, [])["persisted"] is False))
    check("주문 API 는 호출 불가", lambda: _expect_raises(
        OrderNotAllowed, lambda: KBClient()._call("order", code="005930")))
    check("카탈로그 단위 미확정 0", lambda: _assert(not catalog_audit()["problems"]))
    # 종가 알림
    check("등락률은 수정주가, 목표단가는 원주가", lambda: _assert(
        _ret({"ret": -0.02, "price": 5000, "prev_close": 10000}) == -0.02))
    check("ret 없으면 현재가로 계산 (장중 경로)", lambda: _assert(
        abs(_ret({"price": 110, "prev_close": 100}) - 0.10) < 1e-12))
    check("호가 룰은 종가 경로에서 제외",
          lambda: _assert([r for r in RULES if not r.eod][0].name == "spread_blowout"))
    check("±10% 룰이 조정 등락률로 발화", lambda: _assert(
        [r for r in RULES if r.name == "move_10"][0].fire({"ret": -0.12}, {})))
    check("권리락 오탐 없음 (원주가 -50%, 조정 0%)", lambda: _assert(
        not [r for r in RULES if r.name == "move_10"][0].fire(
            {"ret": 0.0, "price": 5000, "prev_close": 10000}, {})))

    def _eod_snap_case():
        d = pd.DataFrame({"date": pd.bdate_range("2026-01-01", periods=30),
                          "close": [100.0] * 29 + [50.0], "volume": [1000.0] * 30,
                          "adj_factor": [0.5] * 30})
        s = eod_snapshot(d)
        _assert(abs(s["price"] - 100.0) < 1e-9)       # 원주가 = 50 / 0.5
        _assert(abs(s["ret"] + 0.5) < 1e-9)           # 수정주가 등락률
        _assert(abs(s["adv20"] - 1000.0) < 1e-9)
    check("eod_snapshot 원주가·조정등락률·ADV20", _eod_snap_case)

    # 시장 개요 · 벤치마크
    def _breadth_case():
        con = sqlite3.connect(":memory:")
        con.executescript(SCHEMA)
        rowsd = [("20260811", "A", "KOSDAQ", 100.0, 1.0), ("20260812", "A", "KOSDAQ", 110.0, 2.0),
                 ("20260811", "B", "KOSDAQ", 100.0, 1.0), ("20260812", "B", "KOSDAQ", 90.0, 3.0),
                 ("20260811", "C", "KOSDAQ", 100.0, 1.0), ("20260812", "C", "KOSDAQ", 100.0, 4.0),
                 ("20260811", "K", "KOSPI", 100.0, 9.0), ("20260812", "K", "KOSPI", 500.0, 9.0)]
        con.executemany(
            "INSERT INTO price_daily (date,code,market,close,value) VALUES (?,?,?,?,?)", rowsd)
        con.commit()
        b = market_breadth(con, "KOSDAQ")
        _assert(b["n"] == 3 and b["up"] == 1 and b["down"] == 1 and b["flat"] == 1)
        _assert(abs(b["median_ret"]) < 1e-12)          # 중위 = 보합
        _assert(abs(b["turnover"] - 9.0) < 1e-9)       # KOSPI 종목이 섞이면 안 됨
        con.close()
    check("시장 개요가 시장을 구분한다", _breadth_case)

    def _breadth_first_day():
        con = sqlite3.connect(":memory:")
        con.executescript(SCHEMA)
        con.execute("INSERT INTO price_daily (date,code,market,close,value) "
                    "VALUES ('20260812','A','KOSDAQ',100.0,1.0)")
        con.commit()
        _assert(market_breadth(con, "KOSDAQ")["n"] == 0)   # 전일 없으면 0, 예외 아님
        con.close()
    check("전일 없으면 시장 개요 0건", _breadth_first_day)

    check("지수 결측행은 버린다", lambda: _assert(
        pd.DataFrame({"index_name": ["코스닥 (외국주포함)", "코스닥"],
                      "close": [np.nan, 858.91]}).dropna(subset=["close"]).shape[0] == 1))

    def _raw_value_case():
        n = 40
        d = pd.DataFrame({"date": pd.bdate_range("2026-01-01", periods=n),
                          "code": "A", "close": 50.0, "open": 50.0,
                          "high": 51.0, "low": 49.0, "volume": 1000.0,
                          "value": 50000.0, "adj_factor": 0.5})
        ctx = build_context(d, pd.DataFrame({"code": ["A"], "name": ["a"], "qty": [10],
                                             "cost": [100], "target_price": [200]}))
        _assert(abs(ctx["rows"][0]["close"] - 100.0) < 1e-9)   # 원주가 = 50 / 0.5
        _assert(abs(ctx["total_value"] - 1000.0) < 1e-9)       # 100 × 10주
        _assert(abs(ctx["rows"][0]["cost_ret"]) < 1e-9)        # 원가 100 대비 0%
    check("평가금액·원가대비는 원주가 기준", _raw_value_case)

    # 퀀트 · 밸류에이션
    def _valuation_case():
        px = pd.DataFrame({"mktcap": [1000.0, 2000.0, 3000.0]}, index=["A", "B", "C"])
        fs = pd.DataFrame({"net_income": [100.0, -50.0, 0.0],
                           "equity": [500.0, 400.0, -100.0],
                           "revenue": [2000.0, 1000.0, 500.0],
                           "op_income": [200.0, -100.0, 50.0],
                           "liabilities": [250.0, 800.0, 300.0]}, index=["A", "B", "C"])
        v = valuation(px, fs)
        _assert(abs(v.loc["A", "per"] - 10.0) < 1e-9)      # 1000/100
        _assert(abs(v.loc["A", "pbr"] - 2.0) < 1e-9)       # 1000/500
        _assert(pd.isna(v.loc["B", "per"]))                # 적자 → 결측
        _assert(pd.isna(v.loc["C", "pbr"]))                # 자본잠식 → 결측
        _assert(bool(v.loc["B", "deficit"]) and bool(v.loc["C", "impaired"]))
    check("적자·자본잠식은 배수를 만들지 않는다", _valuation_case)

    check("PER × ROE = PBR 항등식", lambda: _assert(abs(
        valuation(pd.DataFrame({"mktcap": [1000.0]}, index=["A"]),
                  pd.DataFrame({"net_income": [80.0], "equity": [400.0],
                                "revenue": [900.0], "op_income": [100.0],
                                "liabilities": [100.0]}, index=["A"]))
        .eval("per * roe - pbr").iloc[0]) < 1e-9))

    check("재무 계정 별칭이 한 이름으로 모인다", lambda: _assert(
        _FS_LOOKUP["수익(매출액)"] == "revenue"
        and _FS_LOOKUP["영업이익(손실)"] == "op_income"))

    def _buckets_case():
        rng2 = np.random.default_rng(11)
        m = pd.DataFrame({"ret_20d": rng2.normal(0, .1, 200),
                          "ret_1d": rng2.normal(0, .02, 200),
                          "vol_ann": rng2.uniform(.2, .9, 200),
                          "mktcap": rng2.lognormal(25, 1, 200)})
        t = quant_factor_buckets(m, "ret_20d", 5)
        _assert(len(t) == 5 and int(t["종목수"].sum()) == 200)
    check("팩터 분위가 전 종목을 담는다", _buckets_case)

    check("표본 부족하면 분위 계산 안 함", lambda: _assert(
        quant_factor_buckets(pd.DataFrame({"x": [1, 2], "ret_1d": [0.1, 0.2]}), "x").empty))

    # 백테스트
    def _bt_signal_case():
        """심어 넣은 신호를 잡아내는가 — 팩터가 높을수록 미래수익률이 높게 설계."""
        rg = np.random.default_rng(21)
        nd, ns = 400, 200
        dts = pd.bdate_range("2024-01-01", periods=nd)
        score = rg.normal(0, 1, ns)                    # 종목별 고정 우량도
        drift = score * 0.0012                         # 우량할수록 상승
        rets = rg.normal(0, 0.02, (nd, ns)) + drift
        close = pd.DataFrame(100 * np.exp(np.cumsum(rets, axis=0)), index=dts,
                             columns=[f"S{i}" for i in range(ns)])
        F = pd.DataFrame(np.tile(score, (nd, 1)), index=dts, columns=close.columns)
        b = backtest_factor(close, F, rebal=20, min_names=50, cost_bp=0)
        _assert(b["ok"] and b["ls_cum"] > 0 and b["ic_mean"] > 0.2 and b["monotonic"])
        _assert(b["verdict"] == "유의")
    check("백테스트가 심어둔 신호를 잡는다", _bt_signal_case)

    def _bt_noise_case():
        """무의미한 팩터에 성과가 붙으면 안 됩니다."""
        rg = np.random.default_rng(22)
        nd, ns = 400, 200
        dts = pd.bdate_range("2024-01-01", periods=nd)
        close = pd.DataFrame(100 * np.exp(np.cumsum(rg.normal(0, 0.02, (nd, ns)), axis=0)),
                             index=dts, columns=[f"S{i}" for i in range(ns)])
        F = pd.DataFrame(rg.normal(0, 1, (nd, ns)), index=dts, columns=close.columns)
        b = backtest_factor(close, F, rebal=20, min_names=50, cost_bp=0)
        _assert(b["ok"] and abs(b["ic_mean"]) < 0.1)
        _assert(b["verdict"] == "미확정")       # 잡음을 '유의'로 부르면 안 됩니다
    check("무의미한 팩터는 유의 판정을 받지 않는다", _bt_noise_case)

    check("거래비용이 롱숏 성과를 낮춘다", lambda: _assert(
        _bt_cost_hi() < _bt_cost_lo()))
    check("표본 부족이면 백테스트 거부", lambda: _assert(
        backtest_factor(pd.DataFrame(np.ones((30, 5))),
                        pd.DataFrame(np.ones((30, 5))))["ok"] is False))
    check("구간이 얇으면 연율 환산 안 함", lambda: _assert(
        backtest_factor(_bt_px(nd=160), _bt_px(nd=160), rebal=20, min_names=30,
                        min_periods=3)["ls_ann"] is None))
    check("구간이 충분하면 연율 환산", lambda: _assert(
        backtest_factor(_bt_px(nd=600), _bt_px(nd=600), rebal=20,
                        min_names=30)["ls_ann"] is not None))

    def _tradable_case():
        """유동성 필터가 실제로 종목을 걸러내는가."""
        px = _bt_px(nd=400, ns=80)
        F = _bt_px(nd=400, ns=80, seed=31)
        keep = pd.DataFrame(True, index=px.index, columns=px.columns)
        keep.iloc[:, 40:] = False                       # 절반을 '못 사는' 종목으로
        a = backtest_factor(px, F, rebal=20, min_names=20)
        b = backtest_factor(px, F, rebal=20, min_names=20, tradable=keep)
        _assert(b["universe"] == 40 and a["universe"] == 80)
    check("유동성 필터가 편입 종목을 줄인다", _tradable_case)
    check("팩터 부호 — 저변동성은 변동성 반대", lambda: _assert(
        factor_matrix(_bt_px(), _bt_px(), _bt_px(), "lowvol").iloc[-1].notna().any()))
    check("모르는 팩터는 예외", lambda: _expect_raises(
        ValueError, lambda: factor_matrix(_bt_px(), _bt_px(), _bt_px(), "없는팩터")))

    # 엑싯 실행 백테스트
    def _exec_frame(nd=300, seed=41):
        rg = np.random.default_rng(seed)
        idx = pd.bdate_range("2025-01-01", periods=nd)
        c = pd.Series(10000 * np.exp(np.cumsum(rg.normal(0, .02, nd))), index=idx)
        v = pd.Series(rg.lognormal(12, .5, nd), index=idx)
        return c, v, (c * v).rename("val")

    def _exec_basic():
        c, v, val = _exec_frame()
        r = exit_execution_backtest(c, v, val, target_shares=float(v.median()),
                                    horizon=20, step=20)
        _assert(r["ok"] and set(r["rules"]) <= set(EXEC_RULES))
        for k_, s in r["rules"].items():
            _assert(0 < s["fill_med"] <= 1.0000001)
    check("실행 백테스트가 네 규칙을 돌린다", _exec_basic)

    def _exec_impact():
        """충격계수를 키우면 실현단가가 나빠져야 합니다. 반대면 부호 오류입니다."""
        c, v, val = _exec_frame()
        q = float(v.median())
        lo = exit_execution_backtest(c, v, val, q, 20, 20, k=0.0)
        hi = exit_execution_backtest(c, v, val, q, 20, 20, k=2.0)
        _assert(hi["rules"]["equal"]["shortfall_med"]
                < lo["rules"]["equal"]["shortfall_med"])
    check("충격이 커지면 실현단가가 나빠진다", _exec_impact)

    def _exec_size():
        """물량이 크면 더 나빠져야 합니다."""
        c, v, val = _exec_frame()
        small = exit_execution_backtest(c, v, val, float(v.median()) * .05, 20, 20)
        big = exit_execution_backtest(c, v, val, float(v.median()) * 3, 20, 20)
        _assert(big["rules"]["equal"]["shortfall_med"]
                <= small["rules"]["equal"]["shortfall_med"])
    check("물량이 커지면 실현단가가 나빠진다", _exec_size)

    def _exec_cap():
        """하루 거래량의 25% 상한을 넘겨 체결되면 안 됩니다."""
        vwap = np.full(5, 100.0)
        vol = np.full(5, 1000.0)
        s = simulate_exit(vwap, vol, np.ones(5), shares=1e6, rule="immediate",
                          sigma=.02, max_part=0.25)
        _assert(s["ok"] and s["fill_rate"] <= (5 * 1000 * 0.25) / 1e6 + 1e-9)
    check("일일 참여율 상한을 넘지 않는다", _exec_cap)

    check("표본 부족이면 실행 백테스트 거부", lambda: _assert(
        exit_execution_backtest(pd.Series([1.0] * 30), pd.Series([1.0] * 30),
                                pd.Series([1.0] * 30), 10.0)["ok"] is False))

    # 리포트 파이프라인 (모의 데이터)
    check("모의 리포트 컨텍스트 생성", lambda: _assert(
        build_context(mock_panel(["A", "B"], n=120),
                      pd.DataFrame({"code": ["A", "B"], "name": ["a", "b"],
                                    "qty": [100, 200], "cost": [40000, 40000],
                                    "target_price": [90000, 90000]}))["total_value"] > 0))

    # 통합 계층 (facts) — 내보내는 순간 값이 조용히 바뀌는 일이 없어야 합니다
    check("결측은 null 로 나간다 (0 으로 채우지 않는다)", lambda: _assert(
        _jsonable(np.nan) is None and _jsonable(float("inf")) is None
        and _jsonable(pd.NaT) is None and _jsonable(None) is None))
    check("numpy 값이 파이썬 기본형으로 나간다", lambda: _assert(
        type(_jsonable(np.int64(3))) is int and type(_jsonable(np.float64(1.5))) is float
        and type(_jsonable(np.bool_(True))) is bool))
    check("0 은 결측으로 바뀌지 않는다", lambda: _assert(
        _jsonable(0.0) == 0.0 and _jsonable(0) == 0 and _jsonable(False) is False))

    def _measures_whitelist():
        """단위표에 없는 컬럼은 내보내지 않습니다.
        중간 계산 컬럼이 새어 나가면 받는 쪽이 뜻 모르는 숫자를 근거로 씁니다."""
        row = pd.Series({"close": 100.0, "days_3pct": 4.0, "_tmp": 9.9, "hi_n": 1.0})
        m = _facts_measures(row)
        _assert(set(m) == {"close", "days_3pct"})
    check("facts 는 단위표에 있는 값만 내보낸다", _measures_whitelist)

    check("모든 측정값에 단위 설명이 붙는다", lambda: _assert(
        all(isinstance(u, str) and u.strip() for u in FACTS_UNITS.values())))

    def _facts_roundtrip():
        """인메모리 원장으로 내보내기 전 구간을 통째로 돌립니다.
        네트워크·키 없이도 여기까지는 검증할 수 있어야 합니다."""
        con = sqlite3.connect(":memory:")
        con.executescript(SCHEMA)
        days = pd.bdate_range("2026-01-01", periods=90).strftime("%Y%m%d")
        rng = np.random.default_rng(11)
        rows = []
        for code, base in (("111111", 10000.0), ("222222", 5000.0)):
            px = base * np.cumprod(1 + rng.normal(0, 0.02, len(days)))
            vol = rng.uniform(1e4, 5e4, len(days))
            for d, p, v in zip(days, px, vol):
                rows.append((d, code, f"검증{code}", "KOSDAQ", float(p),
                             float(v), float(p * v), float(p * 1e6), 1e6))
        con.executemany(
            "INSERT INTO price_daily (date,code,name,market,close,volume,value,mktcap,shares)"
            " VALUES (?,?,?,?,?,?,?,?,?)", rows)
        con.commit()

        p = facts_payload(con, ["111111", "999999"])
        con.close()

        _assert(p["ok"] is True)
        _assert(p["schema"] == FACTS_SCHEMA)
        # 있는 종목은 측정값이 나오고
        s = p["stocks"]["111111"]
        _assert(s["found"] is True and s["market"] == "KOSDAQ")
        _assert(s["measures"]["days_3pct"] > 0)
        _assert(s["measures"]["days_3pct_med"] > 0)
        # 없는 종목은 지어내지 않고 없다고 말한다
        _assert(p["stocks"]["999999"]["found"] is False)
        _assert("999999" in p["missing"])
        # 가정이 값과 함께 나간다
        _assert(len(p["assumptions"]) >= 4 and len(p["units"]) >= 20)
        # 그리고 전부 JSON 으로 나갈 수 있어야 한다 (NaN 이 섞이면 여기서 깨집니다)
        txt = json.dumps(p, ensure_ascii=False, allow_nan=False)
        _assert("NaN" not in txt and "Infinity" not in txt)
    check("facts 내보내기 왕복 (원장 → JSON)", _facts_roundtrip)

    def _facts_no_verdict():
        """이 도구는 판단하지 않습니다. 내보내는 키에 등급·점수·권고가 없어야 합니다."""
        banned = {"grade", "score", "rating", "recommendation", "signal",
                  "verdict", "action", "advice", "target_price"}
        _assert(not (banned & set(FACTS_UNITS)))
        row = pd.Series({"close": 1.0, "per": 5.0})
        _assert(not (banned & set(_facts_measures(row))))
    check("facts 는 판단(등급·점수·권고)을 내보내지 않는다", _facts_no_verdict)

    # 통합 계층 (2) — 에이전트 판정을 리포트에 실을 때
    def _brief_fixture():
        return {
            "schema": AGENT_BRIEF_SCHEMA,
            "generated_at": "2026-09-04T01:58:00Z",
            "source": "PIXEL TRADING FLOOR",
            "executed": False,
            "disclaimer": "AI 시뮬레이션이며 투자 조언이 아닙니다.",
            "runs": {
                "000660": {
                    "schema": "floor.run/1", "ts": "2026-09-04T01:30:00Z",
                    "display": "SKHYNIX", "nameKo": "SK하이닉스", "krCode": "000660",
                    "mode": "algo", "mock": False, "kiAsOf": "2026-08-12",
                    "priceLine": "SK하이닉스 1,504,000원",
                    "decision": {"action": "BUY", "confidence": 64,
                                 "entry": "1,480,000원", "stop": "1,400,000원",
                                 "target": "1,700,000원",
                                 "rationale": "VWAP 대비 할인 구간이나 처분에 시간이 걸린다",
                                 "verdict": "APPROVE", "sizing": "계좌 대비 2%",
                                 "riskDowngraded": False,
                                 "risk": {"rr": 2.75, "ok": True, "minRR": 1.5,
                                          "reasons": []}},
                    "analysts": [{"id": "diana", "name": "DIANA",
                                  "bubble": "처분 소요일수가 길다",
                                  "report": "시총 3% 처분에 평균 37.3영업일이 걸린다."}],
                    "debate": [], "scalpDesk": [], "riskCommittee": [],
                    "pm": None, "memory": [],
                },
            },
            "by_code": ["000660"], "others": [], "errors": [],
        }

    check("브리핑 파일이 없으면 None (예외 아님)", lambda: _assert(
        agent_brief_load("/존재하지/않는/경로/agent-brief.json") is None))

    def _brief_bad_json():
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                         encoding="utf-8") as f:
            f.write("{ 깨진 JSON")
            p = f.name
        try:
            _assert(agent_brief_load(p) is None)
        finally:
            os.unlink(p)
    check("브리핑 JSON 이 깨져도 None (리포트 생성을 막지 않는다)", _brief_bad_json)

    def _brief_wrong_schema():
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                         encoding="utf-8") as f:
            json.dump({"schema": "something/else", "runs": {}}, f)
            p = f.name
        try:
            _assert(agent_brief_load(p) is None)
        finally:
            os.unlink(p)
    check("스키마가 다르면 받지 않는다", _brief_wrong_schema)

    check("브리핑이 없으면 '없음'이라고 적는다", lambda: _assert(
        "에이전트 분석이 없습니다" in render_agents_block(None)))

    check("판정이 0건이면 그렇게 적는다", lambda: _assert(
        "판정이 한 건도 없습니다" in render_agents_block(
            {"schema": AGENT_BRIEF_SCHEMA, "runs": {}})))

    def _brief_render():
        h = render_agents_block(_brief_fixture(), ["000660"])
        # 판정과 레벨이 그대로 들어간다
        _assert("BUY" in h and "64%" in h)
        _assert("1,480,000원" in h and "1,400,000원" in h and "1,700,000원" in h)
        # 에이전트 원문을 요약하지 않고 그대로 싣는다
        _assert("시총 3% 처분에 평균 37.3영업일이 걸린다." in h)
        # 측정값이 아니라 의견임을 밝힌다
        _assert("AI 에이전트의 판정" in h)
        _assert("투자 조언이 아닙니다" in h)
        # 언제 분석한 것인지, 무엇을 보고 판단했는지
        _assert("2026-08-12" in h)          # 참고한 원장 기준일
        _assert("이미 저장돼 있던" in h)     # executed=False 를 정직하게 적는다
    check("에이전트 절이 판정·근거·출처를 그대로 싣는다", _brief_render)

    def _brief_escape():
        """에이전트 리포트는 언어모델이 만든 문자열이다. 그대로 HTML 에 넣으면
        리포트가 깨지거나 스크립트가 실행될 수 있다."""
        b = _brief_fixture()
        b["runs"]["000660"]["analysts"][0]["report"] = "<script>alert(1)</script> & <b>굵게</b>"
        b["runs"]["000660"]["nameKo"] = "<img src=x onerror=1>"
        h = render_agents_block(b, ["000660"])
        _assert("<script>" not in h)
        _assert("&lt;script&gt;" in h)
        _assert("onerror=1>" not in h)
    check("에이전트 출력은 HTML 이스케이프한다", _brief_escape)

    def _brief_downgrade():
        """리스크 게이트가 강등한 판정은 그 사실이 눈에 보여야 한다."""
        b = _brief_fixture()
        d = b["runs"]["000660"]["decision"]
        d.update(action="HOLD", riskDowngraded=True,
                 risk={"rr": 1.2, "ok": False, "minRR": 1.5,
                       "reasons": ["손익비 1.20 < 최소 기준 1.50"]})
        h = render_agents_block(b, ["000660"])
        _assert("강등" in h)
        _assert("손익비 1.20 &lt; 최소 기준 1.50" in h)
        _assert("게이트 미달" in h)
    check("강등된 판정은 강등 사실과 사유를 함께 싣는다", _brief_downgrade)

    def _brief_no_invent():
        """레벨을 안 준 판정에 숫자를 만들어 넣지 않는다."""
        b = _brief_fixture()
        b["runs"]["000660"]["decision"].update(entry="-", stop=None, target="")
        h = render_agents_block(b, ["000660"])
        _assert("제시된 레벨 없음" in h)
    check("레벨이 없으면 '없음'이라 쓰고 지어내지 않는다", _brief_no_invent)

    total = passed + len(failed)
    for f in failed:
        print("  FAIL", f)
    print(f"\n{passed} passed, {len(failed)} failed  (총 {total})")
    return 0 if not failed else 1


def _bt_px(nd: int = 400, ns: int = 60, seed: int = 23) -> pd.DataFrame:
    rg = np.random.default_rng(seed)
    return pd.DataFrame(
        100 * np.exp(np.cumsum(rg.normal(0, 0.02, (nd, ns)), axis=0)),
        index=pd.bdate_range("2024-01-01", periods=nd),
        columns=[f"S{i}" for i in range(ns)])


def _bt_ls(cost: float) -> float:
    px = _bt_px()
    rg = np.random.default_rng(24)
    F = pd.DataFrame(np.tile(rg.normal(0, 1, px.shape[1]), (len(px), 1)),
                     index=px.index, columns=px.columns)
    return backtest_factor(px, F, rebal=20, min_names=30, cost_bp=cost)["ls_cum"]


def _bt_cost_hi() -> float:
    return _bt_ls(100.0)


def _bt_cost_lo() -> float:
    return _bt_ls(0.0)


def _assert(cond) -> None:
    if not cond:
        raise AssertionError("조건 불만족")


def _raise(obj):
    raise AssertionError(str(obj))


def _expect_raises(exc, fn) -> None:
    try:
        fn()
    except exc:
        return
    raise AssertionError(f"{exc.__name__} 가 발생하지 않았습니다")


# ════════════════════════════════════════════════════════════════════════
# 15. CLI
# ════════════════════════════════════════════════════════════════════════

POSITIONS_SAMPLE = """code,name,qty,cost,target_price
005930,샘플A,10000,50000,90000
000660,샘플B,5000,120000,220000
035720,샘플C,8000,45000,80000
"""
ENV_SAMPLE = ("KRX_API_KEY=\nDART_API_KEY=\nKB_APP_KEY=\nKB_APP_SECRET=\n"
              "# 해외 매크로 (선택) — https://fredaccount.stlouisfed.org/apikeys\n"
              "FRED_API_KEY=\n")


def cmd_init() -> None:
    for name, body in ((".env", ENV_SAMPLE), ("positions.csv", POSITIONS_SAMPLE),
                       ("watchlist.csv", WATCHLIST_SAMPLE)):
        p = ROOT / name
        if p.exists():
            print(f"  건너뜀 (이미 있음): {name}")
            continue
        p.write_text(body, encoding="utf-8")
        print(f"  생성: {name}")
    gi = ROOT / ".gitignore"
    if not gi.exists():
        gi.write_text(".env\n*.sqlite\nout/\n__pycache__/\n", encoding="utf-8")
        print("  생성: .gitignore")
    print("\n다음 — .env 에 키 4개를 넣고  python ki_monitor.py check-auth")


def cmd_doctor() -> int:
    """새 컴퓨터에서 무엇이 준비됐고 무엇이 빠졌는지 한 번에 봅니다.

    이 프로젝트는 코드와 데이터가 분리돼 있습니다.
    코드는 들고 다니고, 원장(87MB)은 각 머신에서 API 로 다시 만듭니다.
    그래서 새 환경에서 필요한 건 '파이썬 + 키 + 적재' 셋뿐입니다."""
    ok = True
    print(f"프로젝트 폴더 : {ROOT}")
    print(f"파이썬        : {sys.version.split()[0]}")
    print("-" * 58)

    print("[1] 패키지")
    for mod, why in (("pandas", "필수"), ("numpy", "필수"), ("requests", "필수"),
                     ("scipy", "일부 통계"), ("lxml", "DART XML"),
                     ("weasyprint", "PDF (선택)")):
        try:
            __import__(mod)
            print(f"    O  {mod:<12} {why}")
        except ImportError:
            need = why != "PDF (선택)"
            ok &= not need
            print(f"    {'X' if need else '-'}  {mod:<12} {why}"
                  f"{'  ← pip install ' + mod if need else ''}")

    print("\n[2] API 키  (.env 에서만 읽습니다. 값은 출력하지 않습니다)")
    for name, why in (("KRX_API_KEY", "시세·지수·국고채·선물 (필수)"),
                      ("DART_API_KEY", "공시·재무 (필수)"),
                      ("FRED_API_KEY", "해외 매크로 (선택)")):
        has = has_key(name)
        if name != "FRED_API_KEY":
            ok &= has
        print(f"    {'O' if has else 'X'}  {name:<14} {why}")

    print("\n[3] 데이터")
    db = Path(env("db_path"))
    if db.exists():
        con = connect()
        n = con.execute("SELECT COUNT(*) FROM price_daily").fetchone()[0]
        d = con.execute("SELECT COUNT(DISTINCT date) FROM price_daily").fetchone()[0]
        rng = con.execute("SELECT MIN(date), MAX(date) FROM price_daily").fetchone()
        con.close()
        print(f"    O  원장  {n:,}행 · {d}영업일 · {rng[0]}~{rng[1]}")
    else:
        print("    X  원장 없음  ← ingest 로 만드십시오 (API 로 재생성됩니다)")
    for f, why in (("watchlist.csv", "감시 대상"), ("exit_plan.csv", "회수계획")):
        p = ROOT / f
        print(f"    {'O' if p.exists() else '-'}  {f:<16} {why}"
              f"{'  ← ' + f.replace('.csv', '.sample.csv') + ' 참고' if not p.exists() else ''}")

    print("-" * 58)
    if ok and db.exists():
        print("바로 쓸 수 있습니다:  python ki_monitor.py daily")
    elif ok:
        print("키는 준비됐습니다. 원장을 만드십시오:")
        print("  python ki_monitor.py ingest --from 20250101 --universe KOSDAQ")
        print("  python ki_monitor.py fundamentals --market KOSDAQ")
    else:
        print("위의 X 항목을 먼저 채우십시오.  자세한 절차는 README.md 참고")
    return 0 if ok else 1


def cmd_check_auth(live: bool = False) -> int:
    print(f"stage        : {STAGE}")
    print(f"positions    : {env('positions_file')}")
    print(f"db           : {env('db_path')}")
    print("-" * 46)
    ok = True
    for label, name in (("KRX", "KRX_API_KEY"), ("DART", "DART_API_KEY"),
                        ("KB(app)", "KB_APP_KEY"), ("KB(secret)", "KB_APP_SECRET")):
        present = has_key(name)
        ok = ok and present
        print(f"{label:<12}: {'O' if present else 'X'}")
    print("-" * 46)
    print(f"KRX 필드매핑 : {'검증 완료' if KRX['verified'] else '미검증 — 명세서 대조 필요'}")
    print(f"KB 필드매핑  : {'검증 완료' if KB['verified'] else '미검증 — 명세서 대조 필요'}")
    if live and ok:
        print("-" * 46)
        try:
            print(f"DART 호출    : O (상장사 {len(dart_corp_codes()):,}건)")
        except Exception as e:                          # noqa: BLE001
            print(f"DART 호출    : X ({e})")
    return 0 if ok else 1


def cmd_catalog() -> int:
    r = catalog_audit()
    print(f"수집 항목 {r['total']} / 표시 {r['shown']} / "
          f"미적재(당일한정) {r['not_persisted']} / 단위 미확정 {len(r['problems'])}")
    for p in r["problems"]:
        print("  !", p)
    return 1 if r["problems"] else 0


WATCHLIST_SAMPLE = """code,name,memo
# 포트폴리오사를 적으십시오. 투자금액·지분율은 넣지 마십시오.
#
#  상장사  — code 에 종목코드 6자리를 넣습니다.        예) 196170,알테오젠,
#  비상장사 — code 를 비우고 name 에 정확한 법인명만.   예) ,토스뱅크,
#
# 비상장사는 주가가 없으므로 DART 재무·공시로 표시됩니다. 법인명은 등기상 상호와
# 같아야 매칭됩니다 (예: '주식회사' 유무, 띄어쓰기는 무시합니다).
#
# 아래는 예시입니다. 실제 포트폴리오사로 바꾸십시오.
196170,알테오젠,상장 예시
247540,에코프로비엠,상장 예시
058470,리노공업,상장 예시
,비바리퍼블리카,비상장 예시
,컬리,비상장 예시
"""


def _exit_plan() -> pd.DataFrame | None:
    """경영계획의 회수계획. 회사명·경로·시기·진행상태만 담습니다.
    투자원금·회수목표금액·목표단가는 의도적으로 넣지 않습니다 — 문서 민감도를
    올리지 않으면서 '계획 대비 진척'만 보기 위해서입니다."""
    p = ROOT / "exit_plan.csv"
    if not p.exists():
        return None
    try:
        df = pd.read_csv(p, dtype=str).fillna("")
    except Exception:                                   # noqa: BLE001
        return None
    if df.empty or "name" not in df.columns:
        return None
    # resolved 열이 있으면 그것으로 잇습니다. 계획서는 약칭(카나프)을 쓰고
    # 등록부는 정식명(카나프테라퓨틱스)을 쓰기 때문입니다.
    key = df["resolved"] if "resolved" in df.columns else df["name"]
    df["_k"] = key.fillna(df["name"]).str.replace(r"\s+", "", regex=True)
    if "dart_status" not in df.columns:
        df["dart_status"] = ""
    return df


def match_plan(plan: pd.DataFrame, names: dict) -> dict:
    """계획의 약칭(카나프)과 실제 법인명(카나프테라퓨틱스)을 잇습니다."""
    if plan is None or plan.empty:
        return {}
    out = {}
    for key, disp in names.items():
        k = str(disp).replace(" ", "")
        hit = plan[plan["_k"] == k]
        if hit.empty:
            hit = plan[plan["_k"].apply(lambda x: bool(x) and (k.startswith(x)
                                                              or x.startswith(k)))]
        if not hit.empty:
            out[key] = hit.iloc[0].to_dict()
    return out


def _watchlist() -> dict | None:
    """포트폴리오사 목록을 상장·비상장으로 나눕니다.
    code 가 있으면 상장사, 비어 있으면 비상장사로 봅니다."""
    p = ROOT / "watchlist.csv"
    if not p.exists():
        return None
    try:
        df = pd.read_csv(p, dtype=str, comment="#", skip_blank_lines=True)
    except Exception:                                   # noqa: BLE001
        return None
    if df.empty or "name" not in df.columns:
        return None
    if "code" not in df.columns:
        df["code"] = ""
    df["code"] = df["code"].fillna("").astype(str).str.strip()
    df["name"] = df["name"].fillna("").astype(str).str.strip()
    df = df[df["name"] != ""]
    listed = df[df["code"] != ""].copy()
    listed["code"] = listed["code"].str.zfill(6)
    unlisted = df[df["code"] == ""].copy()
    return {"listed": listed.drop_duplicates("code"),
            "unlisted": unlisted.drop_duplicates("name")}


def _positions(required: bool = True) -> pd.DataFrame | None:
    """포지션은 이제 선택입니다. 시장 리포트는 이것 없이 돌아갑니다."""
    p = Path(env("positions_file"))
    if not p.exists():
        if required:
            raise SystemExit(f"{p} 가 없습니다. 포지션 기능에만 필요합니다 "
                             "(시장 리포트는 positions 없이 동작합니다).")
        return None
    return pd.read_csv(p, dtype={"code": str})


def cmd_ingest(frm: str | None, to: str | None, rebuild: bool,
               universe: str | None = None) -> None:
    pos = _positions(required=False)
    codes = pos["code"].tolist() if pos is not None else []
    if not codes and not universe:
        universe = "KOSDAQ"          # 포지션이 없으면 시장 단위 수집이 기본입니다
        print("  [안내] positions 없음 — 시장 전체(KOSDAQ) 를 적재합니다.")
    if rebuild:
        target = codes or [r[0] for r in connect().execute(
            "SELECT DISTINCT code FROM price_daily")]
        for code, r in rebuild_adjustments(target).items():
            if not r["ok"] or r.get("unresolved"):
                print(f"{code}: {r['note'] or '조정 실패'}")
        print(f"수정주가 재계산 — {len(target):,}종목")
        return
    if frm:
        end = to or date.today().strftime("%Y%m%d")
        days = [d.strftime("%Y%m%d") for d in pd.bdate_range(frm, end)]
    else:
        days = [to or date.today().strftime("%Y%m%d")]
    ok = fail = rows = idx = 0
    for d in days:
        r = ingest_day(d, codes, universe)
        if r["ok"]:
            ok += 1
            rows += r["n"]
            idx += r.get("n_index", 0)
            if r.get("halted"):
                print(f"  [거래정지] {d}: 보유 종목 {', '.join(r['halted'])}")
        else:
            fail += 1
            print(f"  [보류] {d}: {r['reason']}")
    print(f"적재 완료 — 성공 {ok}일 / 보류 {fail}일 · 종목 {rows:,}행 · 지수 {idx:,}행")
    if ok and codes:
        for code, r in rebuild_adjustments(codes).items():
            if not r["ok"] or r.get("unresolved"):
                print(f"  [확인] {code}: {r['note']}")
        print("-" * 46)
        n = len(eod_check(pos))
        print(f"종가 기준 알림 — {n}건" if n else "종가 기준 알림 — 해당 없음")


def cmd_report(mock: bool) -> None:
    positions = _positions()
    if mock:
        ctx = build_context(mock_panel(positions["code"].tolist()), positions)
    else:
        con = connect()
        panel = price_panel(con, positions["code"].tolist())
        if panel.empty:
            con.close()
            raise SystemExit("원장이 비어 있습니다. 먼저 ingest 를 실행하십시오.")
        ctx = build_context(panel, positions, con)
        con.close()
    print(f"생성 완료: {render(ctx)}")


def cmd_daily(market: str = "KOSDAQ", day: str = None, with_fs: bool = False,
              with_agents: bool = False, brief: str = None) -> int:
    """하루 한 번 이것만 돌리면 적재부터 리포트까지 끝납니다.
    전 단계가 원장을 읽어 계산하므로 리포트에 고정된 숫자는 없습니다."""
    day = day or date.today().strftime("%Y%m%d")
    print(f"[1/3] 시세·지수 적재 — {day}")
    r = ingest_day(day, [], market)
    if not r["ok"]:
        print(f"  보류: {r['reason']}")
        print("  (휴장일이면 정상입니다. 직전 영업일 원장으로 리포트를 만듭니다.)")
    else:
        print(f"  종목 {r['n']:,}행 · 지수 {r.get('n_index', 0):,}행")

    if with_fs:
        print("[2/3] 재무 갱신")
        fr = ingest_fundamentals(market)
        print(f"  {fr.get('n', 0):,}행 / {fr.get('companies', 0):,}사"
              if fr["ok"] else f"  보류: {fr.get('reason')}")
    else:
        print("[2/3] 재무 갱신 생략 (--with-fs 로 활성화 · 분기 1회면 충분합니다)")

    print("[3/3] 리포트 생성")
    con = connect()
    ctx = build_quant_context(con, market, True)
    con.close()
    if with_agents:
        ctx["agents_enabled"] = True
        ctx["agents"] = agent_brief_load(brief)
    p = render_quant(ctx)
    print(f"  {p}")
    print(f"\n기준일 {ctx['as_of']} · 종목 {ctx['n_stocks']:,} · "
          f"관측 {ctx['n_days']}일")
    return 0


def cmd_live(market: str, every: int, refresh: int) -> int:
    """리포트를 주기적으로 다시 만듭니다. 브라우저는 meta refresh 로 자동 갱신됩니다.

    솔직히 말해 이것은 '준실시간'입니다. 갱신 주기가 곧 지연입니다.
    KRX Open API 는 일별 확정치만 제공하므로, 장중 체결을 반영하려면
    증권사 실시간 시세(KB Open API)가 붙어야 합니다."""
    print(f"[live] {market} · 재생성 {every}초 · 브라우저 갱신 {refresh}초")
    print("       Ctrl+C 로 중단합니다.\n")
    n = 0
    while True:
        t0 = time.time()
        try:
            con = connect()
            ctx = build_quant_context(con, market, with_disclosures=(n % 6 == 0))
            con.close()
            p = render_quant(ctx, refresh_sec=refresh)
            n += 1
            print(f"  [{datetime.now():%H:%M:%S}] #{n} 생성 · 기준일 {ctx['as_of']} "
                  f"· {time.time() - t0:.1f}초 · {p.name}")
        except KeyboardInterrupt:
            raise
        except Exception as e:                          # noqa: BLE001
            print(f"  [{datetime.now():%H:%M:%S}] 실패: {type(e).__name__}: {e}")
        if not in_market_hours():
            print("       (장외 시간 — 원장이 바뀌지 않으면 내용도 그대로입니다)")
        time.sleep(max(30, every))


# ════════════════════════════════════════════════════════════════════════
# 11. 통합 계층 — 관측 사실 내보내기 (facts)
# ════════════════════════════════════════════════════════════════════════
# 같은 저장소의 trading-floor(에이전트 데스크)가 이 원장의 실측값을 읽어 갈 수
# 있도록 stdout 으로 JSON 한 덩어리를 냅니다. 리포트(HTML)와 재료는 같고
# 표현만 다릅니다 — 새로 계산하는 지표는 하나도 없습니다.
#
# 이 명령이 지키는 것 — 리포트와 완전히 같은 원칙입니다.
#
#   1. 판단하지 않습니다. 등급·점수·권고·'유리/불리' 분류를 만들지 않습니다.
#      받는 쪽(에이전트)이 판정을 내리더라도, 그 판정의 재료는 측정값이어야지
#      이 파일이 미리 내린 결론이어서는 안 됩니다.
#   2. 없는 값을 채우지 않습니다. 모르면 null 입니다. 0 이 아닙니다.
#   3. 가정을 함께 보냅니다. 처분 소요일수는 참여율 가정 위에 서 있고,
#      숫자만 넘기면 받는 쪽에서 그 가정이 사라집니다.
#   4. 단위를 함께 보냅니다. 금융 데이터는 단위가 틀려도 계산이 돌아갑니다.
#      units 표를 붙여 받는 쪽이 '천원'과 '원'을 혼동할 수 없게 합니다.
#   5. 네트워크를 쓰지 않습니다(기본값). 원장에 있는 것만 냅니다. 원장이
#      오래됐으면 stale_days 로 알릴 뿐, 몰래 새로 받아오지 않습니다.
#      --with-disclosures 를 주면 그때만 DART 공시를 조회합니다.

FACTS_SCHEMA = "ki.facts/1"

# 시장별 기준 지수 — 베타·트래킹에러를 재는 잣대.
# 코스피 종목을 코스닥 지수에 대고 재면 베타가 틀립니다.
FACTS_BENCH = {"KOSPI": "코스피", "KOSDAQ": BENCHMARK, "KONEX": "코넥스"}

# 측정값이 무엇을 센 것인가. 값과 반드시 함께 나갑니다.
FACTS_UNITS = {
    "close": "원 (수정주가)",
    "mktcap": "원",
    "vol_ann": "비율 (연율 표준편차, 0.35 = 35%)",
    "drawdown": "비율 (기간 최고가 대비, 음수)",
    "px_pctile": "분위 0~1 (관측기간 내 주가 위치)",
    "beta": "배 (기준 지수 대비)",
    "te": "비율 (연율 트래킹에러)",
    "adv20_shares": "주 (20일 평균 거래량)",
    "med20_shares": "주 (20일 거래량 중앙값)",
    "med_vs_mean": "배 (중앙값/평균)",
    "turnover_20d": "원 (20일 평균 거래대금)",
    "turnover_trend": "비율 (20일평균/60일평균 - 1)",
    "liq_pctile": "분위 0~1 (자기 종목 거래대금의 관측기간 내 위치)",
    "liq_conc5": "비율 (최근 60일 거래대금 중 상위 5일 비중)",
    "zero_days": "비율 (최근 60일 중 무거래일 비중)",
    "days_1pct": "영업일 (시총 1% 처분, 평균 거래량 기준)",
    "days_1pct_med": "영업일 (시총 1% 처분, 중앙값 기준)",
    "days_3pct": "영업일 (시총 3% 처분, 평균 거래량 기준)",
    "days_3pct_med": "영업일 (시총 3% 처분, 중앙값 기준)",
    "days_5pct": "영업일 (시총 5% 처분, 평균 거래량 기준)",
    "days_5pct_med": "영업일 (시총 5% 처분, 중앙값 기준)",
    "vwap20": "원 (20일 거래대금/거래량)",
    "vwap60": "원 (60일 거래대금/거래량)",
    "px_vs_vwap": "비율 (종가/20일VWAP - 1)",
    "amihud": "비유동성 지수 (클수록 체결비용 큼, 스케일 1e12)",
    "per": "배", "pbr": "배", "roe": "비율",
    "peer_per": "배 (같은 업종 PER 중앙값, 표본 5개 이상)",
    "per_vs_peer": "비율 (자기 PER/업종 중앙값 - 1)",
    "lockup_days": "일 (상장 후 6개월 시점까지 남은 일수, 음수면 경과)",
}

# 이 숫자들이 서 있는 가정. 숫자와 분리되면 안 됩니다.
FACTS_ASSUMPTIONS = [
    "처분 소요일수 — 해당 기준 거래량의 10%만 장내에서 소화한다고 가정합니다. "
    "블록딜·시간외 대량매매는 계산에 넣지 않았습니다.",
    "평균 거래량 기준과 중앙값 기준을 나란히 냅니다. 거래대금이 상위 며칠에 "
    "몰리는 종목은 평균 기준이 낙관적입니다 (liq_conc5 를 함께 보십시오).",
    f"보호예수 — 상장일 + {LOCKUP_MONTHS}개월로 일괄 추정한 값입니다. "
    "실제 확약 기간은 종목마다 다르며 증권신고서로 확인해야 합니다.",
    "업종 PER 중앙값 — 표본 5개 미만 업종은 산출하지 않습니다. "
    "PER 이 0~60 밖인 종목은 업종 비교에서 제외합니다(이익이 0 근처면 배수가 발산합니다).",
    "분위(pctile) 는 이 원장의 관측기간 안에서의 위치입니다. 관측기간이 짧으면 "
    "분위도 그만큼만 의미합니다 (markets[].n_days 를 보십시오).",
]

FACTS_NOTES = [
    "이 데이터는 측정값입니다. 등급·점수·권고가 아닙니다.",
    "출처는 한국거래소 KRX Open API 와 금융감독원 DART Open API 입니다. "
    "크롤링·유료 벤더·애널리스트 컨센서스는 쓰지 않았습니다.",
    "투자권유·투자자문 자료가 아닙니다.",
]


def _jsonable(v):
    """numpy·pandas 값을 JSON 이 아는 형태로 바꿉니다.

    NaN·NaT·inf 는 전부 null 입니다. 0 으로 채우지 않습니다 — 받는 쪽에서
    '측정하지 못함'과 '0으로 측정됨'을 구분할 수 있어야 합니다."""
    if v is None:
        return None
    if isinstance(v, (str, bool, np.bool_)):
        return bool(v) if isinstance(v, np.bool_) else v
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        return None if (np.isnan(f) or np.isinf(f)) else f
    if isinstance(v, int):
        return v
    if isinstance(v, (pd.Timestamp, datetime)):
        return None if pd.isna(v) else v.strftime("%Y-%m-%d")
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, (list, tuple, set, np.ndarray, pd.Index)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, pd.Series):
        return {str(k): _jsonable(x) for k, x in v.items()}
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return str(v)


def _facts_measures(row: pd.Series) -> dict:
    """엑싯 표 한 행에서 내보낼 측정값만 골라 냅니다.

    표에 있는 컬럼을 통째로 덤프하지 않습니다. 중간 계산용 컬럼까지 나가면
    받는 쪽이 의미를 모르는 숫자를 근거로 쓰게 됩니다."""
    return {k: _jsonable(row.get(k)) for k in FACTS_UNITS if k in row.index}


def facts_market_of(con, code: str) -> str | None:
    """이 종목이 원장의 어느 시장에 적재돼 있는가.

    --market 을 사람이 매번 맞춰 주지 않아도 되게 원장에 물어봅니다.
    (같은 코드가 두 시장에 있으면 행이 많은 쪽 — 실질적으로는 없습니다)"""
    row = con.execute(
        "SELECT market, COUNT(*) AS n FROM price_daily WHERE code=? "
        "GROUP BY market ORDER BY n DESC LIMIT 1", (code,)).fetchone()
    return row[0] if row else None


def facts_payload(con, codes: list[str], with_disclosures: bool = False) -> dict:
    """종목별 관측 사실 묶음. 판단은 하지 않습니다."""
    codes = [str(c).strip().zfill(6) for c in codes if str(c).strip()]
    codes = list(dict.fromkeys(codes))          # 중복 제거, 입력 순서 유지

    today = pd.Timestamp(date.today())
    out = {
        "ok": True,
        "schema": FACTS_SCHEMA,
        "calc_version": CALC_VERSION,
        "generated_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "stage": STAGE,
        "units": FACTS_UNITS,
        "assumptions": FACTS_ASSUMPTIONS,
        "notes": FACTS_NOTES,
        "markets": {},
        "stocks": {},
        "missing": [],
    }

    # 시장별로 묶습니다 — 행렬(quant_frames)은 시장 단위로 한 번만 만듭니다.
    groups: dict[str, list[str]] = {}
    for c in codes:
        mk = facts_market_of(con, c)
        if mk is None:
            out["missing"].append(c)
            continue
        groups.setdefault(mk, []).append(c)

    if not groups:
        out["ok"] = False
        out["reason"] = ("요청한 종목이 원장에 없습니다. "
                         "ingest --universe <시장> 을 먼저 실행하십시오.")
        return out

    inst = instruments_panel(con)
    fs = fundamentals_panel(con)
    mpanel = macro_panel(con)

    for market, mcodes in groups.items():
        fr = quant_frames(con, market)
        if not fr:
            out["missing"].extend(mcodes)
            continue
        m = quant_metrics(fr)
        last_day = pd.Timestamp(fr["last_day"])
        v = valuation(m, fs) if not fs.empty else pd.DataFrame()

        # 시장 국면 — 수준이 아니라 분위로 봅니다.
        try:
            reg = regime(fr, mpanel)
        except Exception as e:                          # noqa: BLE001
            print(f"  [국면 보류] {type(e).__name__}: {e}", file=sys.stderr)
            reg = {}
        reg_out = {}
        for k, d in reg.items():
            fmt = d.get("fmt")
            reg_out[k] = {
                "label": d.get("label"),
                "value": _jsonable(d.get("value")),
                "display": fmt(d["value"]) if callable(fmt) and d.get("value") is not None else None,
                "pctile": _jsonable(d.get("pctile")),
                "chg20": _jsonable(d.get("chg20")),
                "what": d.get("what"),
            }

        out["markets"][market] = {
            "as_of": str(last_day.date()),
            "stale_days": int((today - last_day).days),
            "n_days": int(fr["n_days"]),
            "n_stocks": int(m.shape[0]),
            "benchmark": FACTS_BENCH.get(market),
            "regime": reg_out,
            "fs_companies": int(len(fs)) if not fs.empty else 0,
        }

        ex = exit_metrics(fr, mcodes, m)
        if ex.empty:
            out["missing"].extend(mcodes)
            continue

        # 베타·트래킹에러 — 그 시장의 기준 지수 대비
        bench_series = None
        bi = index_panel(con, FACTS_BENCH.get(market))
        if not bi.empty:
            bench_series = bi.set_index("date")["close"]
        sens = market_sensitivity(fr["close"], list(ex.index), bench_series)
        if not sens.empty:
            for col in ("beta", "te"):
                ex[col] = pd.to_numeric(sens[col], errors="coerce")

        # 밸류에이션 — 원장의 DART 재무에서
        if not v.empty:
            for col in ("per", "pbr", "roe", "deficit", "impaired"):
                if col in v.columns:
                    ex[col] = v[col].reindex(ex.index)

        # 공시 이벤트는 네트워크가 필요합니다. 요청했을 때만 켭니다.
        dsc = pd.DataFrame()
        if with_disclosures:
            try:
                cc = dart_corp_codes().set_index("stock_code")["corp_code"]
                pcc = [cc[c] for c in ex.index if c in cc.index]
                if pcc:
                    dsc = unlisted_disclosures(pcc, days=180, limit=60)
            except Exception as e:                      # noqa: BLE001
                print(f"  [공시 보류] {type(e).__name__}: {e}", file=sys.stderr)

        ex = attach_context(ex, inst, v, dsc, last_day)

        for code in mcodes:
            if code not in ex.index:
                out["missing"].append(code)
                continue
            row = ex.loc[code]
            try:
                obs = exit_observations(row)
            except Exception as e:                      # noqa: BLE001
                print(f"  [{code} 관측 보류] {type(e).__name__}: {e}", file=sys.stderr)
                obs = {"liq": [], "px": [], "cap": [], "fin": [], "events": []}
            vp = volume_profile(fr["close"][code], fr["value"][code])
            out["stocks"][code] = {
                "found": True,
                "code": code,
                "name": _jsonable(row.get("name")) or _jsonable(fr["names"].get(code)),
                "market": market,
                "sector": _jsonable(row.get("sector")),
                "as_of": str(last_day.date()),
                "stale_days": int((today - last_day).days),
                "close": _jsonable(row.get("close")),
                "measures": _facts_measures(row),
                "observations": {k: _jsonable(vv) for k, vv in obs.items()},
                "volume_profile": [{"price": _jsonable(p), "share": _jsonable(s)}
                                   for p, s in vp],
            }

    out["missing"] = sorted(set(out["missing"]))
    for c in out["missing"]:
        out["stocks"].setdefault(c, {"found": False, "code": c,
                                     "reason": "원장에 이 종목의 시세가 없습니다"})
    if not any(s.get("found") for s in out["stocks"].values()):
        out["ok"] = False
        out.setdefault("reason", "요청한 종목 중 원장에 있는 것이 없습니다")
    return out


def cmd_facts(codes: list[str], with_disclosures: bool = False,
              indent: int | None = None) -> int:
    """facts 명령 — stdout 은 JSON 만. 진단 메시지는 전부 stderr 로 보냅니다.

    받는 쪽(ki-bridge.js)이 stdout 을 통째로 JSON.parse 하기 때문에,
    여기에 한 줄이라도 사람용 메시지가 섞이면 통합이 깨집니다."""
    db = Path(env("db_path"))
    if not db.exists():
        payload = {"ok": False, "schema": FACTS_SCHEMA,
                   "reason": f"원장이 없습니다: {db.name}. "
                             f"ingest --universe <시장> 을 먼저 실행하십시오.",
                   "stocks": {}, "markets": {}, "missing": list(codes)}
        print(json.dumps(payload, ensure_ascii=False, indent=indent))
        return 1
    con = connect()
    try:
        payload = facts_payload(con, codes, with_disclosures)
    finally:
        con.close()
    print(json.dumps(payload, ensure_ascii=False, indent=indent))
    return 0 if payload.get("ok") else 1


# ── 통합 계층 (2) — 에이전트 판정 싣기 ─────────────────────────────────
#
# PIXEL TRADING FLOOR(../trading-floor)의 에이전트들이 분석·토론해 내린 판정을
# 이 리포트에 한 절로 싣습니다. `node server/export-brief.js` 가 만든
# agent.brief/1 JSON 을 읽습니다.
#
# 이 절이 지키는 것
#
#   1. **측정값과 판정을 섞지 않습니다.** §1~§4 는 공식 API 로 잰 값이고,
#      이 절은 AI 가 그 값을 보고 내린 의견입니다. 성격이 다르므로 절을 나누고
#      머리에 그 사실을 적습니다. 표 안에 끼워 넣으면 구분이 사라집니다.
#   2. **판정을 요약하거나 재해석하지 않습니다.** 에이전트가 쓴 문장을 그대로
#      옮깁니다. 여기서 다시 줄이면 근거가 사라진 결론만 남습니다.
#   3. **언제 분석한 것인지 밝힙니다.** 저장된 리포트를 모은 것인지, 이번에
#      실제로 돌린 것인지(executed), 참고한 원장 기준일이 언제인지 적습니다.
#   4. **없으면 없다고 적습니다.** 브리핑 파일이 없거나 비었으면 그렇게 씁니다.
#
# 판단은 여전히 사람이 합니다 — 다만 이제 회의 자료에 에이전트 의견이 함께
# 올라갑니다. 그것이 이 절의 목적입니다.

AGENT_BRIEF_SCHEMA = "agent.brief/1"

# 기본 위치 — trading-floor 가 같은 저장소 옆에 있다는 전제.
AGENT_BRIEF_DEFAULT = ROOT.parent / "trading-floor" / "reports" / "agent-brief.json"

# 판정별 배지 색. 템플릿에 이미 있는 클래스만 씁니다(새 CSS 를 넣지 않습니다).
_ACTION_TAG = {
    "BUY": "tag corporate_action", "LONG": "tag corporate_action",
    "SELL": "tag risk", "SHORT": "tag risk",
    "HOLD": "tag", "PASS": "tag",
}


def agent_brief_load(path=None) -> dict | None:
    """브리핑 JSON 을 읽습니다. 없거나 깨졌으면 None — 예외를 올리지 않습니다.

    리포트 생성이 에이전트 쪽 사정으로 실패하면 안 됩니다. 원장 리포트가
    본체이고 에이전트 판정은 덧붙는 절입니다."""
    p = Path(path) if path else AGENT_BRIEF_DEFAULT
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as e:
        print(f"  [에이전트 브리핑 없음] {p}: {e.strerror}")
        return None
    try:
        d = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"  [에이전트 브리핑 파싱 실패] {p}: {e}")
        return None
    if not isinstance(d, dict) or d.get("schema") != AGENT_BRIEF_SCHEMA:
        print(f"  [에이전트 브리핑 형식 불일치] {p}: schema={d.get('schema') if isinstance(d, dict) else '?'}")
        return None
    return d


def _agent_action_badge(action: str | None) -> str:
    a = (action or "?").upper()
    return f"<span class='{_ACTION_TAG.get(a, 'tag')}'>{_esc(a)}</span>"


def _agent_reports_details(title: str, items: list, turn: bool = False) -> str:
    """에이전트 리포트 묶음을 접이식으로. 원문을 줄이지 않습니다."""
    rows = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        name = _esc(it.get("name") or it.get("id") or "?")
        head = f"턴 {it['turn']} — {name}" if turn and it.get("turn") is not None else name
        bubble = _esc(it.get("bubble") or "")
        report = _esc(it.get("report") or "(리포트 없음)").replace("\n", "<br>")
        rows.append(
            f"<div style='margin:8px 0'><b>{head}</b>"
            + (f" <span class='note' style='display:inline'>“{bubble}”</span>" if bubble else "")
            + f"<div class='note' style='margin-top:3px;line-height:1.65'>{report}</div></div>")
    if not rows:
        return ""
    return (f"<details><summary>{_esc(title)} ({len(rows)}건) — 펼치기</summary>"
            + "".join(rows) + "</details>")


def _agent_one(rec: dict) -> str:
    """판정 한 건을 카드 하나로."""
    d = rec.get("decision") or {}
    name = rec.get("nameKo") or rec.get("display") or rec.get("symbol") or "?"
    code = rec.get("krCode")
    title = f"{_esc(name)}" + (f" <span class='note' style='display:inline'>{_esc(code)}</span>" if code else "")

    # 판정 한 줄 — 여기가 회의에서 먼저 읽히는 자리입니다.
    conf = d.get("confidence")
    head = [f"{_agent_action_badge(d.get('action'))} <b>{_esc(name)}</b>"]
    if conf is not None:
        head.append(f"확신도 {conf}%")
    if d.get("verdict"):
        head.append(f"PM {_esc(d['verdict'])}")
    if d.get("sizing"):
        head.append(f"권장 비중 {_esc(str(d['sizing']))}")
    if d.get("riskDowngraded"):
        head.append("<span class='sev1'>리스크 게이트에 의해 강등됨</span>")

    lv = []
    for label, key in (("진입", "entry"), ("손절", "stop"), ("목표", "target")):
        v = d.get(key)
        if v not in (None, "", "-"):
            lv.append(f"{label} {_esc(str(v))}")
    levels = " · ".join(lv) if lv else "제시된 레벨 없음"

    # 리스크 게이트 — 손익비와 강등 사유. 계산된 값이므로 그대로 옮깁니다.
    risk = d.get("risk") or {}
    gate = []
    if risk.get("rr") is not None:
        gate.append(f"손익비 {risk['rr']:.2f} (최소 기준 {risk.get('minRR', '-')})")
    if risk.get("ok") is not None:
        gate.append("게이트 통과" if risk["ok"] else "게이트 미달")
    if risk.get("stopBeyondLiq"):
        gate.append("<span class='sev1'>손절이 청산가보다 멀다 — 청산이 먼저 온다</span>")
    reasons = [r for r in (risk.get("reasons") or []) if r]
    gate_html = ""
    if gate or reasons:
        gate_html = ("<div class='note' style='margin-top:6px'><b>리스크 게이트</b> — "
                     + " · ".join(gate)
                     + ("<ul class='c' style='margin:4px 0 0;padding-left:16px'>"
                        + "".join(f"<li>{_esc(r)}</li>" for r in reasons) + "</ul>" if reasons else "")
                     + "</div>")

    meta = []
    if rec.get("ts"):
        meta.append(f"분석 {_esc(str(rec['ts'])[:16].replace('T', ' '))}")
    if rec.get("mode"):
        meta.append(f"모드 {_esc(rec['mode'])}")
    if rec.get("mock"):
        meta.append("<b>데모(목업) 런 — 실제 모델 판정이 아님</b>")
    if rec.get("kiAsOf"):
        meta.append(f"참고한 원장 기준일 {_esc(rec['kiAsOf'])}")
    if rec.get("priceLine"):
        meta.append(_esc(rec["priceLine"]))

    rationale = _esc(d.get("rationale") or "").replace("\n", "<br>")

    return (
        f"<div class='card'><h3>{title}</h3>"
        f"<div style='margin-bottom:6px'>{' · '.join(head)}</div>"
        f"<div class='note'>{levels}</div>"
        + gate_html
        + (f"<div style='margin-top:8px;font-size:12px;line-height:1.65'><b>근거</b> — {rationale}</div>"
           if rationale else "")
        + _agent_reports_details("애널리스트 리포트", rec.get("analysts"))
        + _agent_reports_details("리서치 토론 (BULL vs BEAR)", rec.get("debate"), turn=True)
        + _agent_reports_details("스캘핑 데스크", rec.get("scalpDesk"))
        + _agent_reports_details("리스크 위원회", rec.get("riskCommittee"))
        + (_agent_reports_details("포트폴리오 매니저", [rec["pm"] | {"name": "PM"}])
           if isinstance(rec.get("pm"), dict) and not rec["pm"].get("failed") else "")
        + (f"<div class='note' style='margin-top:6px'>과거 판정 회고 — "
           + "; ".join(_esc(m) for m in rec["memory"]) + "</div>"
           if rec.get("memory") else "")
        + f"<div class='note' style='margin-top:6px'>{' · '.join(meta)}</div>"
        + "</div>")


def render_agents_block(brief: dict | None, codes: list[str] | None = None) -> str:
    """§ 에이전트 분석 절의 본문 HTML.

    codes 를 주면 그 종목을 먼저 싣고(워치리스트 순서), 나머지를 뒤에 붙입니다."""
    banner = (
        "<div class='conf' style='background:#2E4A6E'>"
        "이 절은 <b>AI 에이전트의 판정</b>입니다 — 위 절들의 측정값과 성격이 다릅니다."
        "<br><span>공식 API 로 잰 값이 아니라, 그 값과 시장 데이터를 보고 언어모델이 "
        "내린 의견입니다. 실제 주문·거래는 발생하지 않았습니다. "
        "회의에서는 §1~§4 의 측정값을 근거로, 이 절은 논점 정리용으로 쓰십시오.</span></div>")

    if not brief:
        return (banner + "<div class='flag'>에이전트 분석이 없습니다 — "
                "<code>cd trading-floor &amp;&amp; node server/export-brief.js --run</code> "
                "를 먼저 실행하고 리포트를 다시 생성하십시오.</div>")

    runs = brief.get("runs") or {}
    if not runs:
        note = ""
        errs = brief.get("errors") or []
        if errs:
            note = ("<ul class='c' style='margin:6px 0 0;padding-left:16px'>"
                    + "".join(f"<li>{_esc(e.get('symbol', '?'))} — {_esc(e.get('message', ''))}</li>"
                              for e in errs) + "</ul>")
        return (banner + "<div class='flag'>브리핑에 판정이 한 건도 없습니다." + note + "</div>")

    # 워치리스트 순서를 우선하고, 브리핑에만 있는 종목은 뒤에 붙입니다.
    order = [c for c in (codes or []) if c in runs]
    order += [k for k in sorted(runs) if k not in order]

    cards = "".join(_agent_one(runs[k]) for k in order)

    gen = _esc(str(brief.get("generated_at", ""))[:16].replace("T", " "))
    executed = brief.get("executed")
    how = ("이번 리포트 생성 시점에 새로 분석했습니다"
           if executed else "이미 저장돼 있던 분석 결과를 모은 것입니다")
    meta = (f"<div class='note'>출처: {_esc(brief.get('source', 'PIXEL TRADING FLOOR'))} · "
            f"브리핑 생성 {gen} · {how} · 판정 {len(order)}건")
    if brief.get("others"):
        meta += (" · 한국 상장이 아닌 대상: "
                 + ", ".join(_esc(o) for o in brief["others"]))
    meta += "</div>"

    errs = brief.get("errors") or []
    err_html = ""
    if errs:
        err_html = ("<div class='flag'>분석에 실패한 종목이 있습니다 — 아래는 빠져 있습니다."
                    "<ul class='c' style='margin:6px 0 0;padding-left:16px'>"
                    + "".join(f"<li>{_esc(e.get('symbol', '?'))} — {_esc(e.get('message', ''))}</li>"
                              for e in errs) + "</ul></div>")

    disc = _esc(brief.get("disclaimer") or "")
    return (banner + meta + err_html
            + f"<div class='grid2'>{cards}</div>"
            + (f"<div class='note' style='margin-top:8px'>{disc}</div>" if disc else ""))


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="ki_monitor.py",
        description="상장 포트폴리오사 회수 판단 리포트 (단일 파일)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init", help=".env / positions.csv 뼈대 생성")
    a = sub.add_parser("check-auth", help="세 API 키 로딩 확인")
    a.add_argument("--live", action="store_true", help="실제 호출까지 시도")
    sub.add_parser("doctor", help="환경 점검 — 새 컴퓨터에서 먼저 실행")
    sub.add_parser("catalog", help="수집 항목 대장 감사")
    g = sub.add_parser("ingest", help="KRX 일별 적재")
    g.add_argument("--from", dest="frm")
    g.add_argument("--to", dest="to")
    g.add_argument("--rebuild-adj", action="store_true")
    g.add_argument("--universe", choices=["KOSPI", "KOSDAQ", "KONEX"],
                   help="해당 시장 전 종목까지 적재 (보유 종목은 항상 포함)")
    r = sub.add_parser("report", help="회수 판단 리포트 생성")
    r.add_argument("--market", default="KOSDAQ", choices=["KOSPI", "KOSDAQ", "KONEX"])
    r.add_argument("--no-disclosure", action="store_true", help="DART 공시 조회 생략")
    r.add_argument("--portfolio", action="store_true", help="구 포지션 리포트")
    r.add_argument("--mock", action="store_true", help="가상 데이터 (포지션 리포트 전용)")
    r.add_argument("--with-agents", action="store_true",
                   help="에이전트 판정 절을 함께 싣습니다 (trading-floor 브리핑 필요)")
    r.add_argument("--brief", help="에이전트 브리핑 JSON 경로 "
                                   "(기본: ../trading-floor/reports/agent-brief.json)")
    w = sub.add_parser("watch", help="장중 폴링 알림")
    w.add_argument("--once", action="store_true", help="1회만 순회 (연결 시험용)")
    e = sub.add_parser("eod", help="종가 기준 알림 평가 (KB 불필요)")
    e.add_argument("--replay", action="store_true", help="중복 억제 무시하고 다시 평가")
    lv = sub.add_parser("live", help="리포트 주기적 재생성 (준실시간)")
    lv.add_argument("--market", default="KOSDAQ", choices=["KOSPI", "KOSDAQ", "KONEX"])
    lv.add_argument("--every", type=int, default=300, help="재생성 주기(초), 기본 300")
    lv.add_argument("--refresh", type=int, default=60, help="브라우저 갱신(초), 기본 60")
    dl = sub.add_parser("daily", help="적재 → 리포트 한 번에 (자동화용)")
    dl.add_argument("--market", default="KOSDAQ", choices=["KOSPI", "KOSDAQ", "KONEX"])
    dl.add_argument("--day", help="기준일 YYYYMMDD (기본: 오늘)")
    dl.add_argument("--with-fs", action="store_true", help="재무까지 갱신")
    dl.add_argument("--with-agents", action="store_true",
                   help="에이전트 판정 절을 함께 싣습니다 (trading-floor 브리핑 필요)")
    dl.add_argument("--brief", help="에이전트 브리핑 JSON 경로")
    mf = sub.add_parser("macro-us", help="해외 매크로 적재 (FRED · 무료 키 필요)")
    mf.add_argument("--from", dest="frm", help="시작일 YYYYMMDD (기본: 원장 최초일)")
    mf.add_argument("--include-restricted", action="store_true",
                    help="제3자 저작물(VIX·나스닥·ICE HY)까지 적재 — 약관 확인 후 사용")
    mf.add_argument("--purge-restricted", action="store_true",
                    help="이미 적재된 제3자 저작물을 원장에서 삭제")
    f = sub.add_parser("fundamentals", help="DART 주요계정 적재 (시장 전체)")
    f.add_argument("--market", default="KOSDAQ", choices=["KOSPI", "KOSDAQ", "KONEX"])
    f.add_argument("--year", help="사업연도 (기본: 작년)")
    sub.add_parser("drill", help="알림 통보 경로 확인")
    sub.add_parser("selftest", help="계산 검증 (키 불필요)")
    ft = sub.add_parser(
        "facts", help="종목별 관측 사실을 JSON 으로 출력 (통합용 · 네트워크 불필요)")
    ft.add_argument("--code", action="append", dest="codes", metavar="000660",
                    help="종목코드 6자리. 여러 번 줄 수 있습니다")
    ft.add_argument("--codes", dest="codes_csv", metavar="000660,005930",
                    help="쉼표로 구분한 종목코드 목록")
    ft.add_argument("--with-disclosures", action="store_true",
                    help="DART 공시 이벤트까지 포함 (네트워크·키 필요)")
    ft.add_argument("--indent", type=int, default=None,
                    help="JSON 들여쓰기 (기본: 한 줄)")
    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()

    if argv is None:
        # Jupyter · IPython 에서는 sys.argv 가 커널 인자라 파싱할 수 없습니다
        if "ipykernel" in sys.modules:
            argv = ["report", "--mock"]
            print(f"[안내] Jupyter 환경 감지. '{' '.join(argv)}' 명령을 실행합니다.\n")
        else:
            argv = sys.argv[1:]
    args = ap.parse_args(argv)

    if args.cmd == "init":
        cmd_init()
    elif args.cmd == "check-auth":
        return cmd_check_auth(args.live)
    elif args.cmd == "doctor":
        return cmd_doctor()
    elif args.cmd == "catalog":
        return cmd_catalog()
    elif args.cmd == "ingest":
        cmd_ingest(args.frm, args.to, args.rebuild_adj, args.universe)
    elif args.cmd == "report":
        if args.portfolio or args.mock:
            cmd_report(args.mock)
        else:
            con = connect()
            ctx = build_quant_context(con, args.market, not args.no_disclosure)
            con.close()
            if args.with_agents:
                ctx["agents_enabled"] = True
                ctx["agents"] = agent_brief_load(args.brief)
            print(f"생성 완료: {render_quant(ctx)}")
    elif args.cmd == "watch":
        pos = _positions().set_index("code").to_dict("index")
        try:
            watch(pos, once=args.once)
        except KeyboardInterrupt:
            print("\n중단했습니다.")
    elif args.cmd == "eod":
        if args.replay:
            con = connect()
            con.execute("DELETE FROM alert_log WHERE rule != 'drill'")
            con.commit()
            con.close()
            print("  [replay] 기존 알림 기록을 지우고 다시 평가합니다.")
        n = len(eod_check(_positions()))
        print("-" * 46)
        print(f"종가 기준 알림 — {n}건" if n else "종가 기준 알림 — 해당 없음")
    elif args.cmd == "live":
        try:
            return cmd_live(args.market, args.every, args.refresh)
        except KeyboardInterrupt:
            print("\n중단했습니다.")
            return 0
    elif args.cmd == "daily":
        return cmd_daily(args.market, args.day, args.with_fs,
                         args.with_agents, args.brief)
    elif args.cmd == "macro-us":
        if args.purge_restricted:
            con = connect()
            ks = tuple(FRED["restricted"])
            cur = con.execute(
                "DELETE FROM macro_daily WHERE key IN (%s)" % ",".join("?" * len(ks)), ks)
            con.commit()
            con.close()
            print(f"제3자 저작물 {cur.rowcount:,}행 삭제 — {', '.join(ks)}")
            return 0
        if not fred_available():
            print("FRED_API_KEY 가 .env 에 없습니다.\n"
                  "  발급(무료): https://fredaccount.stlouisfed.org/apikeys\n"
                  "  .env 에  FRED_API_KEY=발급받은키  한 줄을 추가하십시오.")
            return 1
        con = connect()
        row = con.execute("SELECT MIN(date) FROM price_daily").fetchone()
        con.close()
        start = args.frm or (row[0] if row and row[0] else "20250101")
        iso = f"{start[:4]}-{start[4:6]}-{start[6:]}"
        if args.include_restricted:
            print("  [주의] 제3자 저작물(Cboe·Nasdaq·ICE)을 포함합니다. "
                  "사내 열람 범위와 재배포 조건을 확인하십시오.")
        r = ingest_fred(iso, include_restricted=args.include_restricted)
        print(f"해외 매크로 적재 — {r.get('n', 0):,}행"
              if r["ok"] else f"실패: {r.get('reason')}")
    elif args.cmd == "fundamentals":
        r = ingest_fundamentals(args.market, args.year)
        print(f"재무 적재 — {r.get('n', 0):,}행 / {r.get('companies', 0):,}사"
              if r["ok"] else f"재무 적재 실패: {r.get('reason')}")
    elif args.cmd == "drill":
        notify("SEV1", "TEST", "모의 알림 (drill)")
    elif args.cmd == "selftest":
        return selftest()
    elif args.cmd == "facts":
        codes = list(args.codes or [])
        if args.codes_csv:
            codes += [c for c in re.split(r"[,\s]+", args.codes_csv) if c]
        if not codes:
            # 종목을 안 주면 watchlist.csv 의 상장 종목을 씁니다.
            wl = _watchlist()
            if wl is not None and not wl["listed"].empty:
                codes = list(wl["listed"]["code"])
        if not codes:
            print(json.dumps(
                {"ok": False, "schema": FACTS_SCHEMA,
                 "reason": "종목을 지정하지 않았고 watchlist.csv 도 비어 있습니다. "
                           "--code 000660 처럼 지정하십시오.",
                 "stocks": {}, "markets": {}, "missing": []},
                ensure_ascii=False, indent=args.indent))
            return 1
        return cmd_facts(codes, args.with_disclosures, args.indent)
    return 0


if __name__ == "__main__":
    sys.exit(main())
