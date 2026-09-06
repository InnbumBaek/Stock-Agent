# META: {"name":"6-1 모멘텀(목업)","unit":"%","paper":"jt1993","question":"q1","claim":"과거 3~12개월 승자가 이후에도 이겼다","limits":"미국 1965-1989 표본이다. 한국 코스닥 소형주 근거는 아니다","check":{"rate":0.002,"n":300,"win":60,"expect":23.0957,"tol":0.001}}
def compute(df, mkt, list_date, win):
    c = df['close']
    if len(c) < 126:
        return None, len(c), "일봉 126개가 필요합니다"
    base = c.iloc[-126]
    if not base:
        return None, len(c), "기준 시점 종가가 0 입니다"
    return float(c.iloc[-22] / base - 1.0) * 100.0, 126, None
