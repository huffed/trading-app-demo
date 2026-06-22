#!/bin/bash
# Local cron entrypoint: hourly broker spread sampler.
# Closes B.1.8 (data-capture half) — the spread sampler that the
# eventual ATR-correlation calibration analysis will consume.
#
# What this does
# --------------
# Calls capture-broker-spread.ts which iterates every metaapi
# broker_connections row × default ticker list (XAU/USD, EUR/USD,
# GBP/USD, USD/JPY per the current library scope) + calls
# adapter.fetchQuote per pair. Each successful quote becomes a JSONL
# row appended to scripts/broker-spread-samples.jsonl. Failures are
# logged to stderr but don't abort the batch.
#
# Cadence rationale: ATR-correlation calibration needs samples spread
# across market hours + sessions. Hourly captures during the 24h cycle
# (24/day × N connections × M tickers) produces enough variation for a
# meaningful correlation test within a couple of weeks. Heavier than
# the broker-health cron (6h) because spread varies more intra-day
# than account balance / token state.
#
# Per-call failures are FIRST-CLASS DATA. The wrapper exits 0 even
# when individual (broker × ticker) calls fail — that variation is part
# of what we're measuring (which tickers / hours have higher failure
# rates is itself a signal about broker reliability).
#
# Recommended cadence: hourly. Operator can drop to 6-hourly if
# Anthropic Haiku LLM budget is the binding constraint (the sampler
# itself burns ~0 LLM budget — only MetaApi rate quota).
#
# Usage: ./scripts/broker-spread-sampler-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/broker-spread-sampler-cron.sh >> /tmp/quanttrader-broker-spread.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
TIMESTAMP="[$(date -u +%FT%TZ)]"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$TIMESTAMP ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

cd "$REPO_DIR"

echo "$TIMESTAMP --- broker-spread sampler start ---"
if pnpm dlx tsx scripts/canonical/capture-broker-spread.ts; then
  echo "$TIMESTAMP --- broker-spread sampler end (rc=0) ---"
else
  RC=$?
  echo "$TIMESTAMP --- broker-spread sampler FAILED (rc=$RC — investigate) ---" >&2
  exit $RC
fi
