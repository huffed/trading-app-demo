#!/usr/bin/env bash
# Reproduces every number in review/02-validation.md. From the repo root:
#   bash review/scripts/phase2.sh
# Needs .env.local (read by the scripts for the read-only Supabase rules lookup).
set -euo pipefail
cd "$(dirname "$0")/../.."
echo "### baseline two ways (A2, sizing)";      pnpm dlx tsx review/scripts/baseline-two-ways.ts
echo "### statistics (2.1–2.5, 2.7)";           pnpm dlx tsx review/scripts/phase2-stats.ts
echo "### prop-firm simulation (2.6) ~15 min"; pnpm dlx tsx review/scripts/phase2-propfirm.ts
echo "### window stats (locked-window prereg)"; pnpm dlx tsx review/scripts/window-stats.ts
