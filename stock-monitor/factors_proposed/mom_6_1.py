# META: {"name": "6-1 모멘텀", "unit": "%", "paper": "jt1993", "question": "q1", "claim": "과거 3~12개월 승자가 이후에도 이겼다. 최근 1개월은 반대 방향이라 뺀다.", "limits": "미국 1965-1989 표본이다. 한국 코스닥 소형주에 그대로 성립한다는 근거가 이 값 안에 없다.", "check": {"rate": 0.002, "n": 300, "win": 60, "expect": 23.0957, "tol": 0.001}}
def compute(df, mkt, list_date, win):
    """6개월 수익률에서 최근 1개월을 뺀 것. 논문의 3~12개월 구간 안이다."""
    c = df["close"]
    if len(c) < 126:
        return None, len(c), "일봉 126개가 필요합니다"
    p_now, p_then = c.iloc[-22], c.iloc[-126]
    if not p_then:
        return None, len(c), "기준 시점 종가가 0 입니다"
    return float(p_now / p_then - 1.0) * 100.0, 126, None
