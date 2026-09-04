# TradingAgents — local, no-API-billing setup

Run [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)
(the paper's multi-agent LLM trading framework, Python + LangGraph) on this PC
**without paying for an OpenAI API key**.

The trick: a tiny OpenAI-compatible proxy (`server/claude-shim.js`) accepts the
framework's `ChatOpenAI` requests and answers each one with the local `claude`
CLI (`claude -p`), which draws on the machine's **Claude Max subscription quota**
instead of per-token API billing.

```
TradingAgents (langchain-openai ChatOpenAI, provider "openai",
               backend_url = http://localhost:8787/v1)
        │  POST /v1/chat/completions  (+ /v1/embeddings)
        ▼
server/claude-shim.js   ── serializes messages+tools into one prompt ──►  claude -p --model opus
        ▲                                                                        │
        └────────────── OpenAI-shaped JSON (content or tool_calls) ◄────────────┘
```

---

## What got installed

| Item | Detail |
|------|--------|
| Repo | `vendor/TradingAgents` (cloned `--depth 1` from upstream, version **0.3.1**) |
| Python | **3.12.4** venv at `vendor/ta-venv` (repo requires `>=3.10`; 3.12 chosen for wheel coverage — 3.14 is on this box but too new for some deps) |
| Install | `pip install -e vendor/TradingAgents` — all deps resolved, **exit 0** |
| Key deps | langchain-core 1.5.2, langchain-openai 1.4.1, langgraph 1.2.10, yfinance 1.5.2, pandas 3.0.5, stockstats 0.6.8, openai 2.50.0 |

Import verified:
```
python -c "from tradingagents.graph.trading_graph import TradingAgentsGraph"   # OK
```

---

## Files added (this setup)

```
server/claude-shim.js          OpenAI-compatible proxy -> claude -p  (Node built-ins only)
vendor/TradingAgents/          upstream repo (clone)
vendor/ta-venv/                Python 3.12 virtualenv with deps installed
vendor/run-local.py            configures & runs TradingAgentsGraph against the shim
vendor/start-shim.cmd          launches the shim (port 8787)
vendor/run-tradingagents.cmd   activates venv + runs run-local.py [TICKER] [DATE]
vendor/.env.example            env template (keyless profile needs nothing)
vendor/README-LOCAL.md         this file
```

---

## How to run

### A) Through the shim — uses Claude Max quota, no API billing (default)

Two terminals:

```bat
REM  terminal 1 — start the proxy (keep it open)
cd vendor
start-shim.cmd
REM  cheaper/faster for testing:   set SHIM_MODEL=haiku  &  start-shim.cmd

REM  terminal 2 — run an analysis
cd vendor
run-tradingagents.cmd NVDA 2026-07-24
REM  (ticker defaults to NVDA, date defaults to today)
```

`run-local.py` sets `provider=openai`, `backend_url=http://localhost:8787/v1`,
injects a dummy `OPENAI_API_KEY`, and uses the low-spec profile: **1 debate
round, 1 risk round, 2 analysts (market + fundamentals)**.

### B) Direct to OpenAI — real API billing (bypasses the shim)

Don't start the shim. Put a real key in the environment and clear the backend URL:

```bat
set OPENAI_API_KEY=sk-...your-real-key...
set TRADINGAGENTS_LLM_BACKEND_URL=
cd vendor
ta-venv\Scripts\activate.bat
python -c "from tradingagents.default_config import DEFAULT_CONFIG as c; from tradingagents.graph.trading_graph import TradingAgentsGraph as G; G(config=c).propagate('NVDA','2026-07-24')"
```

This path pays OpenAI per token and uses the real (default) models `gpt-5.5` /
`gpt-5.4-mini`. The framework also supports Anthropic/Google/etc. directly — see
`vendor/TradingAgents/.env.example`.

---

## The shim (`server/claude-shim.js`)

Node **built-ins only** (`http`, `crypto`, `child_process`) — nothing to `npm install`.

Endpoints:
- `POST /v1/chat/completions` — non-streaming; also a minimal single-chunk SSE if
  `stream:true`.
- `POST /v1/embeddings` — deterministic **fake** vectors (see caveats).
- `GET /v1/models`, `GET /healthz` — convenience.

Environment variables:

| Var | Default | Meaning |
|-----|---------|---------|
| `SHIM_PORT` | `8787` | listen port |
| `SHIM_MODEL` | `opus` | **every** request maps to this `claude --model` (try `haiku`/`sonnet` to save quota) |
| `SHIM_TIMEOUT` | `240000` | ms per `claude` spawn |
| `SHIM_CLAUDE` | `claude` | claude executable |
| `SHIM_EMBED_DIM` | `1536` | fallback embedding dimension |

**Tool-call emulation.** When a request carries `tools`, the shim appends a strict
protocol to the prompt: Claude must reply with exactly one JSON object —
`{"tool_call":{"name","arguments"}}` or `{"final":"..."}`. The shim parses that
back into OpenAI `tool_calls` (`finish_reason:"tool_calls"`, `arguments` as a JSON
string) or plain content. This is what makes the analysts' `bind_tools` ReAct
loop and the managers'/trader's `with_structured_output` (schema-as-tool) work.

Verified end-to-end against the framework's real `langchain-openai` client:
```
bind_tools(...).invoke(...)  ->  result.tool_calls = [{'name':'get_stock_price','args':{'ticker':'AAPL'},...}]
llm.invoke("Reply HELLO")    ->  "HELLO"
```

---

## Key / data requirements

**The default profile needs NO API keys.** The `market` and `fundamentals`
analysts read only from **yfinance** (prices, technical indicators, verified
snapshot, fundamentals, income/balance/cashflow statements) — keyless. The
benchmark download in the reflection layer is yfinance too.

You only need a key if you change the profile:

| Feature | Vendor | Key | Notes |
|---------|--------|-----|-------|
| market / fundamentals / news-by-ticker | yfinance | none | the keyless default |
| Macro indicators (CPI, PCE, unemployment, fed funds, yields) | FRED | `FRED_API_KEY` (free) | pulled in only if you add the **`news`** analyst (`get_macro_indicators`). Free key: https://fred.stlouisfed.org/docs/api/api_key.html |
| Prediction markets | Polymarket | none | keyless |
| Alt data vendor | Alpha Vantage | `ALPHA_VANTAGE_API_KEY` | only if you switch `data_vendors` off yfinance |

See `vendor/.env.example`. TradingAgents auto-loads a `.env` from its own package
dir, or you can `set VAR=...` in the shell.

---

## Honest constraints & caveats

- **Speed.** Each agent step spawns a fresh `claude -p` process — tens of seconds
  apiece. A full run makes **dozens** of LLM calls (analysts loop over tools,
  then researchers debate, then risk debate, then trader + managers). Expect a
  single ticker to take **many minutes to tens of minutes**, serially. Use
  `SHIM_MODEL=haiku` while testing.
- **Fake embeddings.** `/v1/embeddings` returns deterministic hash-based vectors
  with **no semantic meaning** — a safety net so an embeddings-dependent memory
  layer won't crash. **This 0.3.1 fork doesn't actually use embeddings**: its
  memory is a plain markdown decision log (`TradingMemoryLog`), so the endpoint
  is effectively unused here. It exists for other/older callers.
- **Streaming.** Only a single-chunk SSE is emitted. TradingAgents doesn't need
  token streaming — its `graph.stream(...)` streams LangGraph *node states*,
  while each `ChatOpenAI.invoke` is a blocking call — so this is sufficient.
- **Tool-call reliability.** Emulation depends on Claude emitting clean protocol
  JSON. If it ever wraps prose around the JSON, the shim extracts the first
  balanced `{...}`; if nothing parses, the text becomes plain content. The
  framework also has its own graceful fallback (`invoke_structured_or_freetext`
  retries structured misses as free text), so a stray miss degrades rather than
  crashes.
- **Non-determinism.** Claude ignores the OpenAI `temperature`/`reasoning_effort`
  params the client may send; runs are not bit-reproducible.
- **Responses API off.** The `openai` provider would use OpenAI's Responses API on
  a native `api.openai.com` URL, but because `backend_url` is `localhost`, the
  client automatically falls back to the standard Chat Completions API — which is
  exactly what the shim speaks.
```
