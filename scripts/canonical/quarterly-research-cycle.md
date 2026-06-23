# Quarterly Research Cycle (H.5)

**Cadence:** 1st of Jan / Apr / Jul / Oct at 07:00 UTC.
**Cron:** `scripts/quarterly-research-cycle-cron.sh` → `/api/cron/quarterly-cycle`.
**Replaces:** `scripts/canonical/B6_continuous_validation_cadence.md` (marked SUPERSEDED there).

This document defines the QUARTERLY review process. It's a superset of the
B-era monthly `validate-algo` cadence — the monthly cron still runs as a
sub-component, but the quarterly cycle adds the broader research review:
feature library refresh, alpha library snapshot, decay report, and
new-hypothesis log.

The cron route auto-runs the first 3 artifacts and emits a hypothesis-log
template the operator fills in.

---

## What each cycle produces

The cron writes a single markdown file to
`/tmp/quanttrader-cycles/<YYYY>-Q<n>-research-cycle.md` containing 4 sections:

### 1. Feature library refresh

Snapshot of `src/lib/features/`:
- Total feature count
- Per-category breakdown (volatility / momentum / trend / structure / time / volume / context / pattern)
- All feature names (collapsed `<details>` for brevity)

Operator-action: if the count has grown since the last cycle, note WHAT was
added in the hypothesis log (§4) for the next cycle's xgboost re-run (H.3).

### 2. Alpha library snapshot

All `active` + `paused` algos with their current `algorithms.backtest_results`
JSONB stats:
- Total return, max DD, baseline Sharpe, deflated Sharpe (DSR), PBO, total trades
- Status + live trading enabled flag + ticker

Operator-action: any algo whose stats have changed materially since the last
cycle (Sharpe drop, DSR drop, status change) gets investigated in §4.

### 3. Alpha decay report (G.4)

Reuses `buildAlphaDecaySummary` from `src/lib/cohort/alpha-decay.ts`:
- Per-algo rolling 30d / 90d Sharpe vs in-sample baseline
- Severity counts (decay / warn / none / insufficient_data / no_baseline)
- Per-algo detail when ≥1 algo evaluated

Operator-action: any algo in `warn` or `decay` severity needs an in-band
review BEFORE the next cycle (the alpha-decay cron may already have
auto-paused `decay` severity algos per G.4).

### 4. New-hypothesis log

Template prompt the operator fills in. Each entry is a research thread for
the NEXT cycle — what to investigate, what evidence is needed, what success
looks like.

Format:
```
- [ ] <hypothesis> — depends on <prerequisite> — evidence needed: <X>
```

Examples:
- `- [ ] Test whether pattern_engulfing_signed retains importance under regime split — depends on H.6 — evidence needed: per-regime AUC delta > 5%`
- `- [ ] Add USD/JPY positioning_contrarian to v3 survivor — depends on G.6 + H.1-validation — evidence needed: ≥30 live XAU trades + ≥30 days of USDJPY positioning cache`

---

## Operator review workflow (per cycle)

1. **Auto-fire:** cron writes `/tmp/quanttrader-cycles/<cycle_id>-research-cycle.md`
2. **Read the file:** `cat /tmp/quanttrader-cycles/<cycle_id>-research-cycle.md`
3. **Fill in §4** with new-hypothesis entries (operator-maintained)
4. **Archive (optional):** if the cycle is worth keeping, copy into the repo:
   ```bash
   mkdir -p scripts/canonical/cycles
   cp /tmp/quanttrader-cycles/<cycle_id>-research-cycle.md scripts/canonical/cycles/
   git add scripts/canonical/cycles/<cycle_id>-research-cycle.md && git commit -m "chore(cycle): archive <cycle_id>"
   ```
   Skipping archive is fine — `/tmp` files persist until the next reboot;
   the report can be re-generated on-demand via curl.
5. **Act on §3 decay alerts** if any: investigate, decide whether the auto-pause
   was correct, manually un-pause if it was a false positive.
6. **Schedule next-cycle work:** §4 hypotheses become work items between now
   and the next quarter.

---

## On-demand preview

The cron is curl-able for an ad-hoc snapshot of the current cycle's state.
Useful when you want to know "what would the next quarterly report look like
right now":

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/quarterly-cycle"
```

Returns JSON with `cycle_id`, `feature_count`, `alpha_count`, `decay_*`, and
the full markdown in the `markdown` field. The file is also written to
`/tmp/quanttrader-cycles/`.

---

## Why this exists separately from the monthly `validate-algo` cadence

The B-era monthly `validate-algo` cron re-validates each algo against the
rolling 12mo OOS window — purely backtest-vs-pre-reg compliance.

The quarterly cycle is the BROADER research review:
- Was the H.2 feature library expanded? (drives H.3 re-runs in the next cycle)
- Are any deployed alphas decaying? (G.4 may have already paused them)
- What's worth investigating next quarter? (operator-maintained hypothesis log)

The monthly cron handles "is the existing config still valid". The quarterly
cycle handles "what should we do differently for next quarter".

---

## Gate (per `scripts/canonical/ROADMAP.md` H.5)

> template exists; first cycle executes 90 days from now

- **Template exists:** ✓ this document
- **First cycle executes:** triggered automatically by the cron's next firing
  (1st of next quarter at 07:00 UTC). Operator can validate the cron wiring
  immediately via the curl command above.
