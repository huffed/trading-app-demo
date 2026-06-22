#!/bin/bash
# Local cron entrypoint: monthly full-fleet validate-algo run.
# Closes Stage 4.7.2 — the B.6 continuous-validation cadence's monthly tick.
#
# What this does
# --------------
# Runs `validate-algo.ts PERSIST=1` against the full deployed-algo fleet
# (currently 18 algos per the Library) with `OOS_CUTOFF` computed as
# `today - 12 months` so the held-out window slides forward over time.
# Writes the resulting verdicts to `algorithms.backtest_results` JSONB
# AND to a dated log file (`/tmp/quanttrader-validate-algo-YYYYMMDD.log`)
# so an operator review trail accrues per month rather than getting
# overwritten by the next tick.
#
# Why monthly, even with all algos paused
# ---------------------------------------
# 1. Engine-regression detection. A code change between months that
#    silently changes verdicts (e.g. a friction-source default shift,
#    a gate threshold drift, a stat-method tweak) surfaces in the
#    next monthly run as a verdict diff vs the previous month's log.
# 2. Pre-positions for Stage 5 re-deploy. When operator decides to
#    re-activate, the most recent monthly verdict IS the deployment
#    decision artifact — no separate "is this still ELIGIBLE today?"
#    re-run needed.
# 3. Holdout window slides. The rolling 12mo OOS holdout means each
#    month's run uses a fresh held-out tail; running monthly keeps the
#    fleet's "is this ELIGIBLE today" answer one tick old at worst.
# 4. Catches data quality drift. If price_cache picks up gaps,
#    auto-pause events, or coverage degradation, the fleet run's
#    `EXCLUDED` count drift surfaces it.
#
# Cross-platform date arithmetic
# ------------------------------
# macOS BSD `date -u -v-12m +%Y-%m-%d` and Linux GNU `date -u -d
# "12 months ago" +%Y-%m-%d` produce the same output. The `||` fallback
# lets the same script work if the cron ever migrates host (BSD first
# because the operator's box is macOS).
#
# Unlike manage-cron.sh / scan-cron.sh, this does NOT hit a Next.js
# endpoint — validate-algo.ts loads .env.local directly + queries
# Supabase via the admin client. Works whether or not pnpm dev/start
# is running.
#
# Recommended cadence: 1st of each month, 06:00 UTC (post-Asia close,
# pre-London open — quiet window).
#
# Usage: ./scripts/validate-algo-monthly-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 6 1 * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/validate-algo-monthly-cron.sh >> /tmp/quanttrader-validate-algo-monthly.log 2>&1
#
# Exit codes (mirrors validate-algo.ts):
#   0 — fleet run completed (verdicts written to DB + log; review the dated log)
#   non-zero — validate-algo threw mid-run; investigate the log
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
TIMESTAMP="[$(date -u +%FT%TZ)]"
LOG_DATE="$(date -u +%Y%m%d)"
LOG_FILE="/tmp/quanttrader-validate-algo-${LOG_DATE}.log"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$TIMESTAMP ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

cd "$REPO_DIR"

# Compute OOS_CUTOFF = today - 12mo. BSD date first (macOS), GNU date
# fallback (Linux migration path). Either branch returns YYYY-MM-DD;
# script aborts if both fail (operator should never see this).
OOS_CUTOFF=$(date -u -v-12m +%Y-%m-%d 2>/dev/null || date -u -d '12 months ago' +%Y-%m-%d 2>/dev/null || true)
if [[ -z "$OOS_CUTOFF" ]]; then
  echo "$TIMESTAMP ERROR: failed to compute OOS_CUTOFF (neither BSD nor GNU date arithmetic worked)" >&2
  exit 1
fi

# Optional heartbeat ping — mirrors heartbeat-cron.sh pattern. Only sent
# on successful completion (validate-algo exit 0). External monitor
# (healthchecks.io / UptimeRobot) flags a missed monthly ping.
HEARTBEAT_PING_URL=$(grep -E '^VALIDATE_MONTHLY_HEARTBEAT_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)

echo "$TIMESTAMP --- validate-algo monthly run start ---" | tee -a "$LOG_FILE"
echo "$TIMESTAMP OOS_CUTOFF=$OOS_CUTOFF (today - 12mo)" | tee -a "$LOG_FILE"
echo "$TIMESTAMP dated log: $LOG_FILE" | tee -a "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Run the fleet validator. PERSIST=1 writes backtest_results JSONB so the
# monthly verdict is queryable. Tee the output so stdout goes to BOTH the
# dated log AND the cron's append-log (set by the crontab `>>` redirect).
if OOS_CUTOFF="$OOS_CUTOFF" PERSIST=1 pnpm dlx tsx scripts/canonical/validate-algo.ts 2>&1 | tee -a "$LOG_FILE"; then
  RC=0
  echo "$TIMESTAMP --- validate-algo monthly run end (rc=0) ---" | tee -a "$LOG_FILE"
  # Optional heartbeat ping on success
  if [[ -n "$HEARTBEAT_PING_URL" ]]; then
    if curl -fsS -m 10 "$HEARTBEAT_PING_URL" >/dev/null; then
      echo "$TIMESTAMP heartbeat ping sent → $HEARTBEAT_PING_URL" | tee -a "$LOG_FILE"
    else
      echo "$TIMESTAMP heartbeat ping FAILED (non-fatal)" | tee -a "$LOG_FILE" >&2
    fi
  fi
else
  RC=$?
  echo "$TIMESTAMP --- validate-algo monthly run FAILED (rc=$RC — investigate) ---" | tee -a "$LOG_FILE" >&2
  exit $RC
fi
