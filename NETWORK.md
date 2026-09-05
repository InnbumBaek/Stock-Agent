# 사내망에서 막힐 때 — 방화벽 허용 요청서

`python ki_monitor.py diagnose` 가 **"나가는 연결이 전부 막혀 있습니다"** 를 찍었다면
키 문제가 아닙니다. 방화벽·프록시가 바깥으로 나가는 HTTPS 를 막고 있는 것입니다.

푸는 방법은 셋입니다. **A 가 정답이고, B 는 임시방편, C 는 A 가 안 될 때의 우회로**입니다.

---

## A. 전산팀에 허용을 요청한다 — 아래를 그대로 전달하십시오

> ### 방화벽 허용 요청
>
> **요청 사유** — 상장 포트폴리오사의 회수 시점 판단 리포트를 자동 생성합니다.
> 데이터는 **한국거래소·금융감독원·한국은행의 공식 Open API** 에서만 받습니다.
> 웹 크롤링·스크래핑은 하지 않으며, **읽기(GET) 전용**입니다.
>
> **필요한 것** — 아래 호스트로 나가는 **HTTPS(TCP 443)** 아웃바운드.
> 인바운드는 필요 없습니다.
>
> #### 1. 필수 — 이것이 없으면 동작하지 않습니다
>
> | 호스트 | 포트 | 기관 | 용도 |
> |---|---|---|---|
> | `data-dbg.krx.co.kr` | 443 | 한국거래소 | 일별 시세·지수·국고채 |
> | `opendart.fss.or.kr` | 443 | 금융감독원 | 공시·재무제표 |
> | `dart.fss.or.kr` | 443 | 금융감독원 | 공시 원문 열람 링크 |
>
> #### 2. 선택 — 없으면 해당 기능만 빠집니다
>
> | 호스트 | 포트 | 기관 | 없으면 |
> |---|---|---|---|
> | `ecos.bok.or.kr` | 443 | 한국은행 | 거시 지표(금리·환율) 미표시 |
> | `openapi.koreainvestment.com` | **9443** | 한국투자증권 | 실시간 시세 대신 전일 종가 사용 |
> | `api.stlouisfed.org` | 443 | 美 연준 | 해외 매크로 미표시 |
>
> `openapi.koreainvestment.com` 은 **443 이 아니라 9443** 입니다.
>
> #### 3. AI 분석을 쓸 경우에만
>
> | 호스트 | 포트 | 용도 |
> |---|---|---|
> | `api.anthropic.com` | 443 | 에이전트 분석 (claude CLI) |
>
> #### 4. 최초 설치 때만 (그 뒤에는 불필요)
>
> | 호스트 | 용도 |
> |---|---|
> | `pypi.org`, `files.pythonhosted.org` | 파이썬 패키지 설치 |
> | `registry.npmjs.org` | claude CLI 설치 |
>
> #### 요청하지 않는 것
>
> 아래는 이 시스템이 부를 수 있지만 **막혀 있어도 됩니다.** 해외 시세·뉴스용이고,
> 막히면 한국거래소 공식 일봉으로 자동 대체됩니다.
>
> `query1.finance.yahoo.com` · `api.binance.com` · `fapi.binance.com` ·
> `api.bybit.com` · `api.bitget.com` · `api.gateio.ws` · `api.coingecko.com` ·
> `api.alternative.me` · `news.google.com` · `open.er-api.com` · `api.telegram.org`

허용된 뒤 확인:

```bash
cd stock-monitor
python ki_monitor.py diagnose
```

---

## B. 회사 프록시를 통해 나간다 — 프록시가 있는 경우

전산팀이 "프록시를 쓰면 된다"고 하면, 명령 프롬프트에서 주소를 알려 주면 됩니다.
파이썬(`requests`)과 Node 모두 이 환경변수를 자동으로 따릅니다.

```cmd
set HTTPS_PROXY=http://프록시주소:포트
set HTTP_PROXY=http://프록시주소:포트
python ki_monitor.py diagnose
```

인증이 필요한 프록시라면:

```cmd
set HTTPS_PROXY=http://아이디:비밀번호@프록시주소:포트
```

### `SSLError` · `CERTIFICATE_VERIFY_FAILED` 가 나오면

회사 프록시가 HTTPS 를 중간에서 풀어 보는(TLS 검사) 방식입니다. 사내 인증서를
알려 주어야 합니다. 전산팀에서 받은 `.crt`(또는 `.pem`) 파일 경로를 넣으십시오.

```cmd
set REQUESTS_CA_BUNDLE=C:\경로\사내인증서.crt
set NODE_EXTRA_CA_CERTS=C:\경로\사내인증서.crt
```

> **`verify=False` 로 끄지 마십시오.** 검증을 끄면 그 연결은 누가 중간에 있어도
> 알 수 없게 됩니다. API 키가 그 연결로 나갑니다.

매번 치기 번거로우면 `PIXEL_FLOOR.cmd` 같은 실행기 맨 위(`@echo off` 다음 줄)에
`set` 줄을 넣어 두면 됩니다.

---

## C. 다른 망에서 원장을 만들어 옮긴다 — A·B 가 다 막힐 때

**원장(`ki.sqlite`)은 그냥 파일입니다.** 인터넷이 되는 컴퓨터에서 만들어 USB 로
옮기면, 사내 PC 는 API 를 한 번도 부르지 않고 리포트를 만들 수 있습니다.

```bash
# ① 인터넷 되는 컴퓨터에서 (집·개인 노트북·모바일 핫스팟)
python ki_monitor.py ingest --from 20250101 --universe KOSDAQ
python ki_monitor.py ingest --from 20250101 --universe KOSPI
python ki_monitor.py fundamentals --market KOSDAQ

# ② 만들어진 파일을 사내 PC 의 같은 위치로 복사
#     stock-monitor\ki.sqlite   (약 87MB)

# ③ 사내 PC 에서 — API 를 부르지 않습니다
python ki_monitor.py report --market KOSDAQ
```

이 경로에서 되는 것과 안 되는 것:

| | |
|---|---|
| ✅ 리포트 §1~§18 전부 | 원장만 있으면 계산됩니다 |
| ✅ 에이전트 분석 | 캔들을 원장에서 가져옵니다(`ki.candleFallback`) — 단 `api.anthropic.com` 은 필요 |
| ❌ 실시간 시세 | 전일 종가로 표시되고, 리포트에 그 사실이 적힙니다 |
| ❌ 거시 지표 | 해당 절이 빠집니다 |
| ⚠️ 매일 갱신 | 인터넷 되는 쪽에서 다시 만들어 옮겨야 합니다 |

**모바일 핫스팟**도 방법입니다. 최초 적재 30분만 붙였다가 끊으면 됩니다.

> ⚠️ `ki.sqlite` 를 옮길 때 주의 — 포트폴리오사 시세가 든 파일입니다.
> USB 는 회사 반출 규정을 확인하시고, 메일·클라우드로는 보내지 마십시오.

---

## 무엇이 막혔는지 먼저 확인하십시오

```bash
cd stock-monitor
python ki_monitor.py diagnose
```

| 진단 결과 | 뜻 | 할 일 |
|---|---|---|
| **전부 X + "한 곳의 문제"** | 아웃바운드 전면 차단 | **A** (또는 B·C) |
| KRX 만 X, `401`/`403` | 방화벽이 아니라 **서비스 사용신청** 누락 | data.krx.co.kr 에서 서비스별 URL 신청 |
| 일부만 X | 그 호스트만 막힘 | 그 줄의 호스트만 A 로 요청 |
| `SSLError` | TLS 검사 프록시 | **B** 의 인증서 설정 |
| 전부 O | 정상 | 다음 단계로 |
