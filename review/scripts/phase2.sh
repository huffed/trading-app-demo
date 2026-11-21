#!/usr/bin/env bash
# Reproduces every number in review/02-validation.md. From the repo root:
#   bash review/scripts/phase2.sh
# Rules come from review/inputs/deployed-rules-2026-11-21.json (QT_REVIEW_RULES=live reads the database).
set -euo pipefail
cd "$(dirname "$0")/../.."
echo "### baseline two ways (A2, sizing)";      pnpm exec tsx review/scripts/baseline-two-ways.ts
echo "### statistics (2.1–2.5, 2.7)";           pnpm exec tsx review/scripts/phase2-stats.ts
echo "### prop-firm simulation (2.6) ~15 min"; pnpm exec tsx review/scripts/phase2-propfirm.ts
echo "### window stats (locked-window prereg)"; pnpm exec tsx review/scripts/window-stats.ts
