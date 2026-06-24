#!/usr/bin/env bash
#
# H.4b — augmented family F+F2 audit orchestrator.
#
# Runs after validate-algo on the augmented LayerB+ family has populated
# backtest_results. Chains: revalidate-candidates (DSR/PBO/k-fold) →
# F2.1 multi-cut → F2.4 alt-objective → F2.3 bootstrap-bars (background)
# → F2.5 aggregate verdict.
#
# F2.2 leave-N-out is informational-only for augmented family (the source
# Layer A universe is unchanged; F2.2 already failed on the un-augmented
# v3 survivor and the augmentation doesn't change WHICH patterns pass at
# the cell, only HOW WELL the v3 pattern performs). Driver invocation
# kept for completeness.
#
# Usage:
#   bash scripts/canonical/run-augmented-f-f2.sh
#
# Env overrides (rarely needed):
#   AUGMENTED_SURVIVOR_NAME (default v3-survivor-augmented name)
#   AUGMENTED_FAMILY_PATTERN (default LayerB+: ... | %)
#   AUGMENTED_CANDIDATE_ID (auto-resolved by SQL when omitted)
#
# Wall clock: ~15 min foreground + ~80 min F2.3 background.
set -euo pipefail

cd "$(dirname "$0")/../.."

AUGMENTED_SURVIVOR_NAME="${AUGMENTED_SURVIVOR_NAME:-LayerB+: XAU/USD Engulfing-Long-DBfilter 4h | rr3_lb6_r06_rf0_af0}"
AUGMENTED_FAMILY_PATTERN="${AUGMENTED_FAMILY_PATTERN:-LayerB+: XAU/USD Engulfing-Long-DBfilter 4h | %}"

echo "=============================================="
echo "H.4b augmented family F+F2 audit orchestrator"
echo "=============================================="
echo "Survivor: $AUGMENTED_SURVIVOR_NAME"
echo "Family  : $AUGMENTED_FAMILY_PATTERN"
echo ""

echo "STEP 1/5: Revalidate candidates (DSR + PBO + k-fold) — ~10 min"
TARGETS="$AUGMENTED_SURVIVOR_NAME" pnpm dlx tsx scripts/canonical/revalidate-candidates.ts 2>&1 | tee /tmp/aug-revalidate.log
echo ""

echo "STEP 2/5: F2.3 block-bootstrap-bars — backgrounded (~80 min)"
FAMILY_PATTERN="$AUGMENTED_FAMILY_PATTERN" \
  SURVIVOR_TAG="rr3_lb6_r06_rf0_af0" \
  OUTPUT_JSON="scripts/canonical/robustness-bootstrap-bars-augmented-results.json" \
  pnpm dlx tsx scripts/canonical/robustness-bootstrap-bars.ts \
  > /tmp/aug-f2.3-bootstrap.log 2>&1 &
F23_PID=$!
echo "  F2.3 backgrounded (pid=$F23_PID; log /tmp/aug-f2.3-bootstrap.log)"
echo ""

echo "STEP 3/5: F2.1 multi-cut OOS — foreground (~8 min)"
FAMILY_PATTERN="$AUGMENTED_FAMILY_PATTERN" \
  SURVIVOR_TAG="rr3_lb6_r06_rf0_af0" \
  OUTPUT_JSON="scripts/canonical/robustness-multi-cut-augmented-results.json" \
  pnpm dlx tsx scripts/canonical/robustness-multi-cut.ts 2>&1 | tee /tmp/aug-f2.1-multi-cut.log
echo ""

echo "STEP 4/5: F2.4 alt-objective — foreground (~8 min)"
FAMILY_PATTERN="$AUGMENTED_FAMILY_PATTERN" \
  SURVIVOR_TAG="rr3_lb6_r06_rf0_af0" \
  OUTPUT_JSON="scripts/canonical/robustness-alt-objective-augmented-results.json" \
  pnpm dlx tsx scripts/canonical/robustness-alt-objective.ts 2>&1 | tee /tmp/aug-f2.4-alt-obj.log
echo ""

echo "STEP 5/5 INTERIM: F2.5 aggregate (without F2.3; F2.3 still backgrounded)"
MULTI_CUT_JSON="scripts/canonical/robustness-multi-cut-augmented-results.json" \
  LEAVE_N_OUT_JSON="scripts/canonical/robustness-leave-n-out-results.json" \
  BOOTSTRAP_JSON="scripts/canonical/robustness-bootstrap-bars-augmented-results.json" \
  ALT_OBJ_JSON="scripts/canonical/robustness-alt-objective-augmented-results.json" \
  CANDIDATE_NAME="$AUGMENTED_SURVIVOR_NAME" \
  OUTPUT_JSON="scripts/canonical/robustness-audit-augmented-interim.json" \
  pnpm dlx tsx scripts/canonical/robustness-aggregate.ts 2>&1 | tee /tmp/aug-aggregate-interim.log
echo ""

echo "Waiting for F2.3 background (pid $F23_PID) to finish..."
wait $F23_PID
echo "  F2.3 finished (exit code $?)"
echo ""

echo "STEP 5/5 FINAL: F2.5 aggregate (complete with F2.3)"
MULTI_CUT_JSON="scripts/canonical/robustness-multi-cut-augmented-results.json" \
  LEAVE_N_OUT_JSON="scripts/canonical/robustness-leave-n-out-results.json" \
  BOOTSTRAP_JSON="scripts/canonical/robustness-bootstrap-bars-augmented-results.json" \
  ALT_OBJ_JSON="scripts/canonical/robustness-alt-objective-augmented-results.json" \
  CANDIDATE_NAME="$AUGMENTED_SURVIVOR_NAME" \
  OUTPUT_JSON="scripts/canonical/robustness-audit-augmented-final.json" \
  pnpm dlx tsx scripts/canonical/robustness-aggregate.ts 2>&1 | tee /tmp/aug-aggregate-final.log
echo ""

echo "=============================================="
echo "DONE. Final verdict in: scripts/canonical/robustness-audit-augmented-final.json"
echo "=============================================="
