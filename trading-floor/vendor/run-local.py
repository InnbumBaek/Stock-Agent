#!/usr/bin/env python
"""
run-local.py — run TauricResearch/TradingAgents against the local claude-shim.

The shim (server/claude-shim.js, default http://localhost:8787/v1) is an
OpenAI-compatible proxy that answers every LLM call with `claude -p`, so the
whole multi-agent pipeline runs on the machine's Claude Max subscription quota
instead of a paid OpenAI API key.

Usage:
    python run-local.py [TICKER] [YYYY-MM-DD]

Examples:
    python run-local.py                 # defaults: NVDA, today
    python run-local.py AAPL
    python run-local.py TSLA 2026-07-24

Prerequisites:
    1. Start the shim first (separate terminal):  ..\\vendor\\start-shim.cmd
       (or:  node ..\\server\\claude-shim.js)
    2. Run this inside the vendor/ta-venv virtualenv (run-tradingagents.cmd does
       this for you).

This is the LOW-SPEC / KEYLESS profile:
    * provider "openai" pointed at the shim's base_url (Chat Completions API)
    * 1 debate round + 1 risk round
    * 2 analysts (market + fundamentals) — both use keyless yfinance data
    * A dummy OPENAI_API_KEY is injected because the "openai" provider requires
      one to be present; the shim never validates it.
"""

import os
import sys
from datetime import date

# ---------------------------------------------------------------------------
# Environment must be set BEFORE importing tradingagents, because the LLM client
# reads OPENAI_API_KEY at construction time. The "openai" provider requires the
# variable to exist; the shim ignores its value entirely.
# ---------------------------------------------------------------------------
os.environ.setdefault("OPENAI_API_KEY", "sk-local-dummy")

# Shim endpoint (override with SHIM_BACKEND_URL if you moved the port).
BACKEND_URL = os.environ.get("SHIM_BACKEND_URL", "http://localhost:8787/v1")

# Cosmetic model labels. The shim maps ANY model name to its SHIM_MODEL env var,
# so these strings only affect logging / capability lookup (they resolve to the
# default function-calling capability set, which is what we want).
DEEP_MODEL = os.environ.get("SHIM_DEEP_MODEL", "local-claude-deep")
QUICK_MODEL = os.environ.get("SHIM_QUICK_MODEL", "local-claude-quick")

from tradingagents.default_config import DEFAULT_CONFIG  # noqa: E402
from tradingagents.graph.trading_graph import TradingAgentsGraph  # noqa: E402


def main() -> int:
    ticker = sys.argv[1] if len(sys.argv) > 1 else "NVDA"
    trade_date = sys.argv[2] if len(sys.argv) > 2 else date.today().isoformat()

    config = DEFAULT_CONFIG.copy()
    config["llm_provider"] = "openai"
    config["backend_url"] = BACKEND_URL
    config["deep_think_llm"] = DEEP_MODEL
    config["quick_think_llm"] = QUICK_MODEL

    # Low-spec debate settings (keep the number of LLM calls small).
    config["max_debate_rounds"] = 1
    config["max_risk_discuss_rounds"] = 1

    # Provider-specific reasoning knobs off (Claude ignores them via the shim).
    config["openai_reasoning_effort"] = None
    config["temperature"] = None

    # Keyless data profile: the two analysts below only touch yfinance (core
    # stock data, indicators, verified snapshot, fundamentals / statements).
    # None of these need an API key. (Adding the "news" analyst would pull in the
    # FRED macro tool, which requires a free FRED_API_KEY — see vendor/.env.example.)
    selected_analysts = ("market", "fundamentals")

    print("=" * 70)
    print("TradingAgents — LOCAL (claude-shim) run")
    print("=" * 70)
    print(f"  ticker            : {ticker}")
    print(f"  trade_date        : {trade_date}")
    print(f"  llm_provider      : {config['llm_provider']}")
    print(f"  backend_url       : {config['backend_url']}")
    print(f"  analysts          : {', '.join(selected_analysts)}")
    print(f"  debate/risk rounds: {config['max_debate_rounds']}/{config['max_risk_discuss_rounds']}")
    print(f"  OPENAI_API_KEY    : {'set (dummy)' if os.environ.get('OPENAI_API_KEY') else 'MISSING'}")
    print("-" * 70)
    print("NOTE: every agent step spawns `claude -p`, which can take tens of")
    print("seconds each. A full run makes dozens of calls -> expect many minutes.")
    print("Make sure the shim is running (vendor/start-shim.cmd).")
    print("=" * 70)

    ta = TradingAgentsGraph(
        selected_analysts=selected_analysts,
        debug=True,
        config=config,
    )

    _, decision = ta.propagate(ticker, trade_date)

    print("\n" + "=" * 70)
    print("FINAL DECISION")
    print("=" * 70)
    print(decision)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
