#!/bin/bash
# Local cron entrypoint: M1 / G.8 mean-R band check (the "standing read").
#
# Runs the existing, vetted M1 comparator (scripts/canonical/m1-progress.ts
# → src/lib/cohort/m1-evidence.ts — the SAME computation behind the
# /reports M1 tab), then surfaces the result without the operator pulling
# it by hand:
#   - ALWAYS logs the one-line summary (closed count, realized mean R,
#     band verdict) to the cron log.
#   - NOTIFIES (phone push via ntfy, reusing the dead-man NTFY_TOPIC
#     pattern) only on a STATE CHANGE — a newly-closed trade moved the
#     cohort, or the band verdict flipped (IN<->OUTSIDE). This gives the
#     "recompute each time a trade closes" behaviour without nagging on
#     quiet days (the portfolio can sit flat for weeks in a non-bullish
#     gold regime — long-only + daily_bias-bullish by design).
#
# R, baseline band, and clock-start all come from m1-evidence.ts — this
# wrapper adds NO numeric logic of its own (single source of truth).
#
# Requires:
#   - .env.local in the repo root with SUPABASE_SERVICE_ROLE_KEY +
#     NEXT_PUBLIC_SUPABASE_URL (the CLI reads these).
#   - Optional: NTFY_TOPIC (+ NTFY_TOKEN) in .env.local or the environment
#     to enable phone push. Without it, breaches are logged only.
#
# Usage: ./scripts/m1-band-check-cron.sh
# To wire to the server crontab, run `crontab -e` and add (daily 21:30 UTC,
# after the US session's 4h closes so a fresh close is reflected same day):
#   30 21 * * * /opt/quanttrader/scripts/m1-band-check-cron.sh >> /var/log/quanttrader/m1-band-check.log 2>&1
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"
STATE_FILE="${M1_BAND_STATE_FILE:-/tmp/quanttrader-m1-band.state}"
TS="[$(date -u +%FT%TZ)]"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "$TS ERROR: .env.local not found at $ENV_FILE" >&2
  exit 1
fi

cd "$REPO_DIR"

# Run the vetted comparator. Capture everything; the lines we parse are
# specific enough to ignore any package-manager progress noise.
OUT="$(pnpm dlx tsx scripts/canonical/m1-progress.ts 2>&1)" || {
  echo "$TS ERROR: m1-progress CLI failed:" >&2
  echo "$OUT" >&2
  exit 1
}

# Parse the three load-bearing values straight from the CLI's own output.
PROGRESS_LINE="$(echo "$OUT" | grep -E 'Progress: [0-9]+/[0-9]+ closed trades' | head -1 || true)"
REALIZED_LINE="$(echo "$OUT" | grep -E '^Realized mean R:' | head -1 || true)"
BAND_LINE="$(echo "$OUT" | grep -E 'PASS band:' | head -1 || true)"

if [[ -z "$PROGRESS_LINE" || -z "$BAND_LINE" ]]; then
  echo "$TS ERROR: could not parse M1 CLI output. Raw:" >&2
  echo "$OUT" >&2
  exit 1
fi

CLOSED="$(echo "$PROGRESS_LINE" | grep -oE '[0-9]+/[0-9]+' | head -1 | cut -d/ -f1)"
if echo "$BAND_LINE" | grep -q 'OUTSIDE band'; then
  BAND_STATE="OUTSIDE"
elif echo "$BAND_LINE" | grep -q 'IN band'; then
  BAND_STATE="IN"
else
  BAND_STATE="ACCRUING" # < min trades, band verdict not yet meaningful
fi

SUMMARY="${REALIZED_LINE//Realized mean R: /}"
echo "$TS M1: ${CLOSED} closed | ${BAND_STATE} band | ${SUMMARY}"

# --- state-change detection -------------------------------------------------
PREV_CLOSED=""
PREV_STATE=""
if [[ -f "$STATE_FILE" ]]; then
  PREV_CLOSED="$(cut -d'|' -f1 "$STATE_FILE" 2>/dev/null || true)"
  PREV_STATE="$(cut -d'|' -f2 "$STATE_FILE" 2>/dev/null || true)"
fi
printf '%s|%s\n' "$CLOSED" "$BAND_STATE" > "$STATE_FILE"

NOTIFY_REASON=""
if [[ -z "$PREV_CLOSED" ]]; then
  NOTIFY_REASON="first run"
elif [[ "$CLOSED" != "$PREV_CLOSED" ]]; then
  NOTIFY_REASON="new trade(s): ${PREV_CLOSED}->${CLOSED} closed"
elif [[ "$BAND_STATE" != "$PREV_STATE" ]]; then
  NOTIFY_REASON="band verdict changed: ${PREV_STATE}->${BAND_STATE}"
fi

if [[ -z "$NOTIFY_REASON" ]]; then
  echo "$TS no change (prev ${PREV_CLOSED} closed / ${PREV_STATE}) — logged only."
  exit 0
fi
echo "$TS CHANGE: ${NOTIFY_REASON}"

# --- phone push (best-effort) ----------------------------------------------
NTFY_TOPIC="${NTFY_TOPIC:-$(grep -E '^NTFY_TOPIC=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"
NTFY_TOKEN="${NTFY_TOKEN:-$(grep -E '^NTFY_TOKEN=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)}"

if [[ -z "$NTFY_TOPIC" ]]; then
  echo "$TS NTFY_TOPIC unset — breach/update logged only (add it to .env.local for phone push)."
  exit 0
fi

# OUTSIDE band wakes the phone; IN/ACCRUING updates are non-urgent.
if [[ "$BAND_STATE" == "OUTSIDE" ]]; then PRIORITY="urgent"; else PRIORITY="default"; fi
TITLE="QuantTrader M1: ${CLOSED}/30 — ${BAND_STATE} band"
BODY="${NOTIFY_REASON}. ${SUMMARY}"
AUTH_ARGS=()
[[ -n "$NTFY_TOKEN" ]] && AUTH_ARGS=(-H "Authorization: Bearer $NTFY_TOKEN")

if curl -fsS -X POST "https://ntfy.sh/$NTFY_TOPIC" \
    "${AUTH_ARGS[@]}" \
    -H "Title: $TITLE" \
    -H "Priority: $PRIORITY" \
    -H "Tags: chart_with_downwards_trend,robot" \
    -d "$BODY" >/dev/null; then
  echo "$TS pushed to ntfy (priority $PRIORITY)."
else
  echo "$TS WARN: ntfy push failed (logged only)." >&2
fi
