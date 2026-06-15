#!/bin/bash
# Local cron entrypoint: scheduled $0 cohort-report run. The learning
# loop's REVIEW layer — operates on existing llm_decisions +
# paper_positions rows (zero LLM spend, no broker calls). Writes a
# dated JSON to scripts/cohort-report-YYYY-MM-DD.json AND streams the
# human-readable summary to stdout (captured to the log by the cron
# redirect).
#
# Unlike manage-cron.sh / scan-cron.sh, this does NOT hit a Next.js
# endpoint — cohort-report.ts loads .env.local directly and queries
# Supabase via the service-role client. Works whether or not pnpm
# dev/start is running.
#
# Recommended cadence: weekly, Sunday 23:00 UTC (post-weekly-close).
# Captures the full prior trading week + any settled trades.
#
# Usage: ./scripts/cohort-report-cron.sh
# To wire to macOS cron, run `crontab -e` and add:
#   0 23 * * 0 /Users/jack.jones/Documents/trading-app/demo-1/scripts/cohort-report-cron.sh >> /tmp/quanttrader-cohort-report.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
TIMESTAMP="[$(date -u +%FT%TZ)]"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$TIMESTAMP ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

cd "$REPO_DIR"

echo "$TIMESTAMP --- cohort-report start ---"
# cohort-report.ts honours DAYS / SOURCE / MIN_N / ACTIVITY_DAYS env
# vars — left at defaults here (14d decay window, live source, MIN_N=5,
# 7d activity window). Override per-run if needed.
pnpm dlx tsx scripts/cohort-report.ts
echo "$TIMESTAMP --- cohort-report end ---"
