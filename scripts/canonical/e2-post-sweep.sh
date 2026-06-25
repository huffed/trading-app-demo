#!/usr/bin/env bash
#
# Phase E2 post-sweep orchestrator.
#
# Runs AFTER E2.3 (algo-search.ts MODE=full) has populated
# backtest_results for all Search:* candidates. Chains:
#
#   E2.4 Phase F deflation per per-candidate passer (revalidate-candidates.ts)
#   E2.5 Phase F2 robustness audit per F-survivor (4 sub-gates + aggregate)
#   H.4b proper stepwise feature augmentation per F+F2 passer
#         (stepwise-feature-augmentation.ts)
#
# Output: per-candidate JSON results + a top-level summary listing the
# F+F2 passers + their stepwise-augmented variants ready for operator
# G.6 re-stamp.
#
# Usage:
#   bash scripts/canonical/e2-post-sweep.sh
#
# Env overrides:
#   FORCE                  default 0 (set 1 to skip skip-if-result-exists checks)
#   STEPWISE_AFTER_F_F2    default 1 (set 0 to skip H.4b per survivor)
#   ENABLE_FOREX_SEARCH    default 0 — per [[feedback_gold_only_demo_stage]] the
#                          orchestrator filters to gold-only by default. Set 1
#                          (matching the enumerator's env var) to include forex
#                          cells in post-sweep audit. Only opt in after operator
#                          declares ≥1 stable gold demo player.
#   E2_RESULTS_DIR         default scripts/canonical/e2-results/ (created if absent)
set -euo pipefail

cd "$(dirname "$0")/../.."

E2_RESULTS_DIR="${E2_RESULTS_DIR:-scripts/canonical/e2-results}"
FORCE="${FORCE:-0}"
STEPWISE_AFTER_F_F2="${STEPWISE_AFTER_F_F2:-1}"
ENABLE_FOREX_SEARCH="${ENABLE_FOREX_SEARCH:-0}"

# Gold-only filter for SQL LIKE patterns. With ENABLE_FOREX_SEARCH=1, all 4
# instruments included; default filters to XAU/USD only.
if [ "$ENABLE_FOREX_SEARCH" = "1" ]; then
  SEARCH_NAME_LIKE="Search:%"
  echo "  NOTE: ENABLE_FOREX_SEARCH=1 — all instruments included"
else
  SEARCH_NAME_LIKE="Search: XAU/USD %"
fi
mkdir -p "$E2_RESULTS_DIR"

echo "=============================================="
echo "Phase E2 post-sweep orchestrator"
echo "=============================================="
echo "Results dir : $E2_RESULTS_DIR"
echo "Force re-run : $FORCE"
echo "Stepwise H.4b after F+F2 : $STEPWISE_AFTER_F_F2"
echo "Search name LIKE : $SEARCH_NAME_LIKE (gold-only by default per feedback_gold_only_demo_stage)"
echo ""

# Step 1: identify per-candidate passers (criteria 1-7) via DB query
echo "STEP 1/4: identifying per-candidate passers (criteria 1-7)..."
PASSERS_FILE="$E2_RESULTS_DIR/e2-per-candidate-passers.txt"

pnpm dlx tsx scripts/canonical/e2-list-passers.ts > "$PASSERS_FILE.tmp" 2>&1 | tail -3 || true
# e2-list-passers.ts (companion script) writes one name per line to stdout

# Fall back to direct query if the helper is missing
if [ ! -s "$PASSERS_FILE.tmp" ]; then
  echo "  (e2-list-passers.ts missing or empty; falling back to inline query)"
  SEARCH_NAME_LIKE="$SEARCH_NAME_LIKE" pnpm dlx tsx -e '
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { passesPerCandidate } from "./src/lib/algo-search/criteria";
try { const raw = readFileSync(".env.local","utf8"); for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^[\x27"]|[\x27"]$/g,""); } } catch {}
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await sb.from("algorithms").select("name, backtest_results").like("name", process.env.SEARCH_NAME_LIKE || "Search: XAU/USD %").not("backtest_results", "is", null);
  if (!data) { process.exit(1); }
  for (const r of data) if (passesPerCandidate(r.backtest_results)) console.log(r.name);
}
main().catch(e => { console.error(e); process.exit(1); });
' > "$PASSERS_FILE.tmp"
fi

mv "$PASSERS_FILE.tmp" "$PASSERS_FILE"
PASSER_COUNT=$(grep -c . "$PASSERS_FILE" 2>/dev/null || echo 0)
echo "  per-candidate passers : $PASSER_COUNT"

if [ "$PASSER_COUNT" -eq 0 ]; then
  echo "  STOP: no downstream work."
  exit 0
fi
echo ""

# Step 1.5: Layer B enumeration sweep per per-candidate passer
# Per Phase E methodology: per-candidate passers at Layer A need a Layer B
# geometry sweep (96 variants per cell) before deflation. revalidate-candidates
# computes DSR with the 96-variant family as the trial pool for selection-bias
# correction. Without Layer B, the "family" is a singleton + DSR doesn't
# meaningfully penalize search.
echo "STEP 1.5/5: Layer B enumeration sweep on per-candidate passers..."

if [ "$FORCE" -eq 1 ] || [ ! -f "$E2_RESULTS_DIR/e2-layer-b-done.marker" ]; then
  BASE_NAMES_CSV=$(tr '\n' ',' < "$PASSERS_FILE" | sed 's/,$//')
  MODE=layer-b BASE_NAMES="$BASE_NAMES_CSV" PERSIST=1 pnpm dlx tsx scripts/canonical/algo-search.ts 2>&1 | tee "$E2_RESULTS_DIR/e2-layer-b.log"
  touch "$E2_RESULTS_DIR/e2-layer-b-done.marker"
else
  echo "  (skipped — marker exists; set FORCE=1 to re-run)"
fi
echo ""

# Step 2: Phase F deflation against Layer B families
echo "STEP 2/5: Phase F deflation (DSR + PBO + purged k-fold) per per-candidate family..."

if [ "$FORCE" -eq 1 ] || [ ! -f "$E2_RESULTS_DIR/e2-deflation-done.marker" ]; then
  # For each per-candidate passer, the Layer B family is "LayerB: <body> | %"
  # where <body> is the Search:* name minus the "Search:" prefix. The
  # revalidate-candidates targets need to be ONE representative LayerB variant
  # per family — the family pattern is auto-derived from " | " delimiter.
  # Cheapest target: just pick any LayerB:* row from each passer's family +
  # let revalidate-candidates auto-discover the rest via the family pattern.
  LAYER_B_TARGETS=$(SEARCH_NAME_LIKE="LayerB:%" pnpm dlx tsx scripts/canonical/e2-list-layer-b-targets.ts < "$PASSERS_FILE" 2>/dev/null)
  if [ -z "$LAYER_B_TARGETS" ]; then
    echo "  no LayerB rows found for passers (Layer B sweep may have failed); aborting"
    exit 1
  fi
  TARGETS="$LAYER_B_TARGETS" pnpm dlx tsx scripts/canonical/revalidate-candidates.ts 2>&1 | tee "$E2_RESULTS_DIR/e2-deflation.log"
  touch "$E2_RESULTS_DIR/e2-deflation-done.marker"
else
  echo "  (skipped — marker exists; set FORCE=1 to re-run)"
fi
echo ""

# Step 3: identify F-survivors + run F2 audit per
echo "STEP 3/5: identifying F-survivors (criteria 1-10) + running F2 audit per..."
F_SURVIVORS_FILE="$E2_RESULTS_DIR/e2-f-survivors.txt"

pnpm dlx tsx -e '
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { passesShipCriteria } from "./src/lib/algo-search/criteria";
try { const raw = readFileSync(".env.local","utf8"); for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^[\x27"]|[\x27"]$/g,""); } } catch {}
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const passers = readFileSync(process.argv[2],"utf8").split("\n").filter(Boolean);
  const { data } = await sb.from("algorithms").select("name, backtest_results").in("name", passers);
  if (!data) process.exit(1);
  for (const r of data) {
    const br = r.backtest_results as any;
    if (passesShipCriteria(br, br?.statistical_rigor?.deflated)) console.log(r.name);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
' "$PASSERS_FILE" > "$F_SURVIVORS_FILE" 2>&1

F_SURVIVOR_COUNT=$(grep -c . "$F_SURVIVORS_FILE" 2>/dev/null || echo 0)
echo "  F-survivors : $F_SURVIVOR_COUNT"
if [ "$F_SURVIVOR_COUNT" -eq 0 ]; then
  echo "  STOP: no F-survivors → no F2 audit + no H.4b downstream."
  exit 0
fi

# For each F-survivor, run F2 audit drivers
while IFS= read -r SURVIVOR_NAME; do
  [ -z "$SURVIVOR_NAME" ] && continue
  echo ""
  echo "  ── F-survivor: $SURVIVOR_NAME ──"

  TAG="${SURVIVOR_NAME##* | }"
  BASE_NAME="${SURVIVOR_NAME% | *}"
  FAMILY_PATTERN="$BASE_NAME | %"
  SLUG=$(echo "$SURVIVOR_NAME" | tr '/| :' '_' | tr -s '_')
  CANDIDATE_DIR="$E2_RESULTS_DIR/$SLUG"
  mkdir -p "$CANDIDATE_DIR"

  if [ "$FORCE" -eq 0 ] && [ -f "$CANDIDATE_DIR/aggregate-final.json" ]; then
    echo "    (F2 audit already complete; skipping. Set FORCE=1 to re-run.)"
    continue
  fi

  FAMILY_PATTERN="$FAMILY_PATTERN" SURVIVOR_TAG="$TAG" \
    OUTPUT_JSON="$CANDIDATE_DIR/f2.1-multi-cut.json" \
    pnpm dlx tsx scripts/canonical/robustness-multi-cut.ts 2>&1 | tail -3

  FAMILY_PATTERN="$FAMILY_PATTERN" SURVIVOR_TAG="$TAG" \
    OUTPUT_JSON="$CANDIDATE_DIR/f2.4-alt-objective.json" \
    pnpm dlx tsx scripts/canonical/robustness-alt-objective.ts 2>&1 | tail -3

  # F2.2 leave-N-out cell extraction
  NAME_BODY="${SURVIVOR_NAME#Search: }"
  NAME_BODY_NO_TAG="${NAME_BODY%% | *}"
  SURVIVOR_TICKER=$(echo "$NAME_BODY_NO_TAG" | awk '{print $1}')
  SURVIVOR_PATTERN_DIR=$(echo "$NAME_BODY_NO_TAG" | awk '{print $2}')
  SURVIVOR_TIMEFRAME=$(echo "$NAME_BODY_NO_TAG" | awk '{print $3}')
  SURVIVOR_DIRECTION="${SURVIVOR_PATTERN_DIR##*-}"
  SURVIVOR_PATTERN="${SURVIVOR_PATTERN_DIR%-*}"

  SURVIVOR_TICKER="$SURVIVOR_TICKER" \
    SURVIVOR_TIMEFRAME="$SURVIVOR_TIMEFRAME" \
    SURVIVOR_DIRECTION="$SURVIVOR_DIRECTION" \
    SURVIVOR_PATTERN="$SURVIVOR_PATTERN" \
    OUTPUT_JSON="$CANDIDATE_DIR/f2.2-leave-n-out.json" \
    pnpm dlx tsx scripts/canonical/robustness-leave-n-out.ts 2>&1 | tail -3

  FAMILY_PATTERN="$FAMILY_PATTERN" SURVIVOR_TAG="$TAG" \
    OUTPUT_JSON="$CANDIDATE_DIR/f2.3-bootstrap-bars.json" \
    pnpm dlx tsx scripts/canonical/robustness-bootstrap-bars.ts 2>&1 | tail -3

  MULTI_CUT_JSON="$CANDIDATE_DIR/f2.1-multi-cut.json" \
    LEAVE_N_OUT_JSON="$CANDIDATE_DIR/f2.2-leave-n-out.json" \
    BOOTSTRAP_JSON="$CANDIDATE_DIR/f2.3-bootstrap-bars.json" \
    ALT_OBJ_JSON="$CANDIDATE_DIR/f2.4-alt-objective.json" \
    CANDIDATE_NAME="$SURVIVOR_NAME" \
    OUTPUT_JSON="$CANDIDATE_DIR/aggregate-final.json" \
    pnpm dlx tsx scripts/canonical/robustness-aggregate.ts 2>&1 | tail -5
done < "$F_SURVIVORS_FILE"

echo ""

# Step 4: stepwise feature augmentation per F+F2 passer
if [ "$STEPWISE_AFTER_F_F2" -ne 1 ]; then
  echo "STEP 4/5: SKIPPED (STEPWISE_AFTER_F_F2=0)"
  exit 0
fi

echo "STEP 4/5: stepwise feature augmentation per F+F2 passer..."
F_F2_PASSERS_FILE="$E2_RESULTS_DIR/e2-f-f2-passers.txt"
> "$F_F2_PASSERS_FILE"

while IFS= read -r SURVIVOR_NAME; do
  [ -z "$SURVIVOR_NAME" ] && continue
  SLUG=$(echo "$SURVIVOR_NAME" | tr '/| :' '_' | tr -s '_')
  AGG="$E2_RESULTS_DIR/$SLUG/aggregate-final.json"
  if [ ! -f "$AGG" ]; then continue; fi
  VERDICT=$(python3 -c "import json; d=json.load(open('$AGG')); print(d.get('aggregate_verdict','MISSING'))")
  if [ "$VERDICT" != "PASS" ]; then
    echo "  $SURVIVOR_NAME — F2 verdict $VERDICT (skipping H.4b)"
    continue
  fi
  echo "  $SURVIVOR_NAME — F+F2 PASS → running H.4b stepwise..."
  echo "$SURVIVOR_NAME" >> "$F_F2_PASSERS_FILE"

  ALGO_ID=$(pnpm dlx tsx -e '
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
try { const raw = readFileSync(".env.local","utf8"); for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^[\x27"]|[\x27"]$/g,""); } } catch {}
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await sb.from("algorithms").select("id").eq("name", process.argv[2]).single();
  process.stdout.write(data?.id ?? "");
}
main().catch(() => process.exit(1));
' "$SURVIVOR_NAME" 2>/dev/null)

  if [ -z "$ALGO_ID" ]; then
    echo "    failed to resolve algo_id; skipping H.4b for this candidate"
    continue
  fi

  ALGO_ID="$ALGO_ID" \
    OUTPUT_JSON="$E2_RESULTS_DIR/$SLUG/stepwise-augmentation.json" \
    pnpm dlx tsx scripts/canonical/stepwise-feature-augmentation.ts 2>&1 | tail -10
done < "$F_SURVIVORS_FILE"

F_F2_PASSER_COUNT=$(grep -c . "$F_F2_PASSERS_FILE" 2>/dev/null || echo 0)
echo ""
echo "=============================================="
echo "Phase E2 post-sweep COMPLETE"
echo "=============================================="
echo "  per-candidate passers : $PASSER_COUNT"
echo "  F-survivors           : $F_SURVIVOR_COUNT"
echo "  F+F2 passers          : $F_F2_PASSER_COUNT"
echo ""
echo "Results in: $E2_RESULTS_DIR/"
echo ""
echo "For each F+F2 passer with a stepwise-augmentation result that"
echo "improves baseline: operator stamps clone-augmented-family + runs"
echo "run-augmented-f-f2.sh on the augmented family. Augmented F+F2 PASS"
echo "= deployable candidate → operator G.6 re-stamp + un-pause."
