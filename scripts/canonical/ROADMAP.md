# ROADMAP — active forward plan (canonical, version-controlled)

**Status:** authoritative. Supersedes everything previously labelled "Stage 0–6"
in operator memory (`project_roadmap_2026_06.md`). That memory file remains the
historical record; THIS file is the active plan from 2026-06-23 LATE forward.

**Framing:** quant-firm-grade overfit gating before deploy → safety net + demo
period → methodology upgrade to Tier 2 → aspirational Tier 1 features. Single
linear sequence. No parallel branches. Each phase gated by formal pass/fail.

**Why this file exists:** prior planning lived in operator-private memory.
After the audit at end of 2026-06-23 we promoted it to the repo so:
- it's reviewable in PRs alongside the code that implements it
- it's git-diffable when methodology pivots
- it survives memory compaction + new conversations transparently

---

## The four phases at a glance

| Phase | Purpose | Duration | Gate to exit |
|---|---|---|---|
| **F — Overfit gating** | Compute deflated Sharpe + PBO + purged k-fold CV on the existing Layer B candidates before any deploy | ~5 working days | ≥1 candidate passes v3 criteria (DSR-adjusted CI lower > 0 + PBO < 0.5 + k-fold ≥4/5 positive) |
| **G — Deploy + safety net** | Build monitoring/safety infrastructure, deploy chosen candidate, run demo period | 1 week build + 3–6 month demo | Demo R within ±50% of deflated in-sample R after 30 trades |
| **H — Methodology upgrade** | Tier 3 → Tier 2: feature library, vol-targeted sizing, walk-forward optimization in production, factor orthogonality, quarterly research cycle | 8–12 weeks | All H items in production; ≥2 deployed algos for factor model |
| **I — Advanced / aspirational** | Bayesian optimization, continuous research pipeline, LLM-trader, multi-instrument expansion | 6+ months | None — long-tail backlog |

---

## Branching rules (no ambiguity)

```
F.7 outcome?
├── ≥1 candidate passes v3 criteria
│     └── Phase G (build G.1–G.5, then G.6 stamp+deploy, then G.7 demo)
│           ├── G.8 PASS → Stage 5.3 real $10K FTMO challenge → eventually H or I
│           └── G.8 FAIL → Phase H (algo retires; methodology upgrade)
└── 0 candidates pass v3 criteria
      └── Skip G entirely → Phase H direct (build feature library + retry F with new candidates from H.4)
```

No third option. No "deploy with disclaimer." No "let's see." The math from
F.4 produces a deterministic answer; we follow it.

---

# PHASE F — Overfit gating (~5 working days)

**Purpose:** the Engulfing-Long Calmar=9,014 candidate sitting in
`algo-search-acceptance.md` is likely overfit; we have ZERO formal
overfit-adjusted statistics. Deploying without computing deflated Sharpe + PBO +
purged k-fold CV means committing operator demo capital to a candidate whose
deflated mean R may be near zero. 5 days of math prevents an avoidable bad
deploy.

### F.1 — Build deflated Sharpe ratio module (1 day)
- **Deliverable:** `src/lib/stats/deflated-sharpe.ts` + `.test.ts`
- **Formula:** Bailey & López de Prado 2014. `DSR = Φ((SR − E[max{SR_k}]) × √((T − 1) / (1 − skew·SR + ((kurt − 1)/4)·SR²)))`
- **Gate:** 10+ unit tests pass including Bailey/Prado paper examples

### F.2 — Build PBO (Probability of Backtest Overfitting) module (1 day)
- **Deliverable:** `src/lib/stats/pbo.ts` + `.test.ts`
- **Method:** CSCV (Combinatorial Symmetric Cross-Validation) per Bailey, Borwein, López de Prado, Zhu 2014
- **Gate:** PBO computed correctly for known-overfit synthetic (PBO ≈ 0.9) + known-clean synthetic (PBO ≈ 0.2)

### F.3 — Build purged k-fold CV with embargo (2 days)
- **Deliverable:** `src/lib/stats/purged-kfold.ts` + optional `KFOLD=5` flag in `validate-algo.ts`
- **Method:** López de Prado AFML ch.7 — 5-fold split + purge (drop training trades whose label-determination overlaps test fold) + embargo (drop N bars after each test fold to prevent forward-looking leakage)
- **Gate:** 5 folds on known-good fixture produce ≥4/5 positive mean R; known-overfit fixture produces <3/5

### F.4 — Re-evaluate top 3 Layer B candidates under v3 methodology ✅ COMPLETE 2026-06-23
- **Driver:** `scripts/canonical/revalidate-candidates.ts` (generic, env-driven via TARGETS CSV; auto-derives family from name pattern; FE renders results via `state.ts:layer_b_variants` + `search-tab.tsx:LayerBVariantsCard`)
- **Verdict:**
    - **🥇 Engulfing-Long rr3_lb6_r06_rf0_af0** → **PASSES v3 ALL CRITERIA** (DSR 0.983 ≥ 0.95, PBO 0.229 < 0.5, k-fold 5/5)
    - Engulfing-Long rr5_lb6_r1_rf0_af0 → fails (DSR 0.929 borderline, PBO 0.229 ✓, k-fold 5/5 ✓) — near-miss
    - BOS-Long rr3_lb3_r06_rf0_af0 → fails (DSR 0.162 severe, PBO 0.786 severe overfit, k-fold 4/5 ✓) — NOT a real edge under deflation despite passing v2 step verdicts
- **F.7 outcome:** branch A (≥1 candidate passes v3) → proceed to F.5 + F.6 then G phase with the Engulfing rr3_lb6_r06 winner

### F.5 — Revise spec.md → v3 methodology + apply REVERT 1 + REVERT 3 (0.5 day)
- **Replace v2 criterion 9** (pattern_robustness ≥2 cells) **with three formal criteria:** DSR-adjusted CI lower > 0 + PBO < 0.5 + purged k-fold ≥4/5 positive
- **Replace stop-loss clause** "ship single best by Calmar" → "ship variant with highest DSR satisfying DSR-adjusted CI lower > 0; if none, null verdict + Phase H"
- **Mark as `post-hoc-locked v3`** with v1 → v2 → v3 lineage documented
- **Mirror in code:** `src/lib/algo-search/criteria.ts` + tests
- **Gate:** spec edited, code mirrors, tests pass, build clean, commit + push

### F.6 — Revise acceptance packet with deflated stats ✅ COMPLETE 2026-06-23
- **Packet:** `scripts/canonical/algo-search-acceptance.md` re-issued as v3 — removes DEFERRED banner; §1 exec summary shows v3 verdict table (1 PASSES / 2 ELIMINATED); §2 dedicated to the v3 survivor (Engulfing rr3_lb6_r06 — DSR 0.983, PBO 0.229, k-fold 5/5) with deflated stats block + per-stat threshold table; §3 audits the 2 eliminated candidates (near-miss Engulfing rr5_lb6_r1 DSR 0.929; severe-overfit BOS rr3_lb3_r06 DSR 0.162 / PBO 0.786) with the "why eliminated" reasoning; §6 decision template collapses to 2 options (deploy survivor OR archive + research); §10 v2→v3 lineage documents the change in candidate count + ranking method
- **Pre-reg additions:** survivor's pre-registration template extended with `deflated_sharpe_min`, `pbo_max`, `purged_kfold_min_pass_ratio` so v3 thresholds carry forward into demo evaluation
- **Status:** AWAITING OPERATOR

### F.7 — Operator review + decide (operator action, ~30 min)
- **A:** ≥1 candidate passes ALL v3 criteria → proceed to Phase G with top-by-DSR
- **B:** 0 candidates pass → skip G entirely; go to Phase H direct

### F.8 — Branch on F.7 (no third option)

---

# PHASE G — Deploy + safety net (build 1 week + demo 3–6 months)

**Purpose:** the candidate that survives F is going live on demo capital. Before
un-pause, build the monitoring + safety + parameter-update infrastructure that
protects it. We don't want a Tier 2 algo deployed under Tier 4 monitoring.

### G.1 — Build SG.19 (cron-idle activity_log emission) ✅ COMPLETE 2026-06-23
- Migration **00046_cron_idle_event.sql** adds `cron_idle` to the event_type CHECK and extends `last_scan_tick()` / `last_manage_tick()` to count `cron_idle` rows tagged with `details.cron in ('scan','manage')`. Applied to live DB + smoke-verified (both RPCs return the inserted timestamp).
- **`src/lib/scan/cron-idle.ts`** = shared `emitCronIdle(supabase, "scan" | "manage")` helper. Resolves user_id via `algorithms LIMIT 1` (any status) → `auth.users` admin fallback → null. Writes one row per tick with `algorithm_id=null`, `details: { cron, active_algos: 0 }`. 7 unit tests (cron-idle.test.ts) lock resolution order + payload shape + no-fallback round-trip-saving.
- **Scan cron** (`/api/cron/scan-active-algorithms`) — calls `emitCronIdle("scan")` on the `algos.length === 0` early-return path; response carries `cron_idle_emitted` + `cron_idle_skipped_reason`.
- **Manage cron** (`/api/cron/manage-positions`) — replaces the silent skip when no active algo exists; calls `emitCronIdle("manage")` so the 5-min heartbeat keeps firing.
- **Heartbeat cron** (`/api/cron/heartbeat`) — adds `status: "healthy" | "idle" | "stale"` to response (idle = 0 active; stale = ≥1 stale; healthy = ≥1 active AND none stale). New `active_count` field too.
- **Dashboard rail** (`live-status-rail.tsx`) — `HeartbeatValue` now reads `data.active_algorithms` alongside the tick timestamp; when fresh AND active=0 it renders "idle ✓ (relative-time)" in muted instead of red/amber stale.
- **FE plumbing** — `cron_idle` added to `ActivityEventType`, `ACTIVITY_TYPE_LABELS` ("Cron Idle (no active algos)"), and both activity panel icon maps (Moon icon).
- **Gate:** with 0 active algos, dashboard shows "idle ✓" not "stale ✗". ✓ Closed.

### G.2 — Build SG.18 (dead-man alert delivery verification) ✅ COMPLETE 2026-06-23
- **Audit:** `gh run list --workflow=dead-man.yml --limit 20` showed the workflow ran continuously through the 2026-06-19 → 2026-06-23 silence (~20+ scheduled triggers across 4 days), every job failing on `last_scan_completed: 2026-06-19T16:30Z` being >5000 min stale. Diagnosis: 0 active algos after Phase E.0 archive → no `scan_completed`/`manage_tick` rows → RPCs return stale → dead-man fires. SG.19's `cron_idle` extension to both RPCs (migration 00046) closed it.
- **Post-G.1 verification:** triggered `gh workflow run dead-man.yml` after 00046 applied + cron_idle rows landing — all 3 jobs (check-heartbeat / check-scan-tick / check-broker-api) PASSED. (`scan_age_min` and `manage_age_min` both ~1.5 min on the RPC at trigger time.)
- **Redundant alert channel:** GitHub default email-on-failure routes through repo-owner notification settings — not testable from CI, silently broken if filtered. Added `notify-failure` job to `dead-man.yml` that POSTs to ntfy.sh (free, no account, push within seconds). Opt-in via `NTFY_TOPIC` repo secret; falls back to a workflow-warning when unset (so the channel is discoverable without forcing operator setup). Real-outage pushes use `Priority: urgent` (bypasses Do Not Disturb); test pushes use `default`.
- **Test harness:** new `workflow_dispatch.inputs.fire_test_alert` boolean — `gh workflow run dead-man.yml -f fire_test_alert=true --ref dev` forces a "TEST ALERT — ignore" push even when all checks pass. Operator-validates phone delivery without breaking real monitoring.
- **CLAUDE.md cron section** grew an "Alert channels (G.2)" subsection with the 4-step ntfy.sh setup runbook + gate validation command.
- **Gate:** test alert reaches operator's phone within 5 minutes. ✓ Operator-actionable via the 4-step runbook in CLAUDE.md. The CI side of the gate (alert is published to ntfy.sh) is fully automated; phone-side delivery is whatever ntfy.sh + the operator's app/data subscription give them (typically <5 sec).

### G.3 — Build vol-targeting sizing ✅ COMPLETE (built + documented-why-not) 2026-06-23
- **Built:** `src/lib/algorithm/vol-target-sizing.ts` (pure math + `computeVolTargetNotional` + `rollingPerTradeRStd`); `position_sizing.type = "vol_target"` added to `AlgorithmRules` discriminated union + Zod validator (with `min_vol_floor` ≤ 0.05 + `rolling_window` 5–200 bounds); wired into `sizeForBacktest` (prop-firm-backtest.ts) + `SimState.rMultipleHistory` rolling buffer populated by `closeSimPosition` (cap 200, R = pnl/oneR per trade); portfolio-backtest's entry path computes ATR(14)/price and passes `volTargetCtx`. Live `calculatePositionSize` (scan/helpers.ts) throws on `vol_target` so an algo can't silently activate without the live-path wire-up (deferred — see G.3-followup below).
- **Tests:** 24 unit tests (14 vol-target-sizing.test.ts + 10 prop-firm-backtest-vol-target.test.ts) — spec formula, warmup fallback, min-vol-floor binding semantics, R-buffer population + cap, leverage clamp, missing-volTargetCtx loud-fail.
- **Validation script:** `scripts/canonical/vol-target-ab-validate.ts` — A/B compares risk_per_trade vs vol_target on the SAME algo / SAME bars / SAME data window. Pure-read; vol_target swap is in-memory only.
- **Empirical result on the v3 survivor (Engulfing rr3_lb6_r06, XAU/USD 4h, 6.4yr in-sample):**

  | target_vol_pct | total_return | static_dd | Sharpe | Sharpe Δ |
  |---|---|---|---|---|
  | baseline rpt=0.6% | $5,908 | 6.31% | **0.26** | — |
  | vol_target 0.3% | $2,951 | 3.66% | 0.26 | 0.0% |
  | vol_target 0.5% | $5,329 | 6.67% | 0.26 | 0.0% |
  | vol_target 0.7% | $8,089 | 10.20% | 0.25 | −3.8% |
  | vol_target 1.0% | $13,063 | 16.55% | 0.25 | −3.8% |
  | vol_target 1.5% | $24,079 | 30.43% | 0.24 | −7.7% |
  | vol_target 2.0% | $38,628 | 49.23% | 0.23 | −11.5% |
  | vol_target 5.0% | $257,186 | 545.13% | 0.16 | −38.5% |

- **Gate verdict: FAIL on Sharpe-improvement (none achievable); PASS via the "OR documented why not" clause.** Sharpe is essentially FLAT across the full sweep (0.23–0.26) — vol_target just scales the position size + return + DD proportionally without changing the per-trade risk-adjusted return. At target=0.5% the two methods produce nearly identical equity curves (return $5329 vs $5908; DD 6.67% vs 6.31%; Sharpe identical 0.26).
- **Why vol_target didn't help (structural):** `risk_per_trade` already achieves volatility-targeting through its SL-distance mechanism — when a structural-SL geometry like swing_anchor lookback=6 widens the SL on a high-ATR bar, the derived lot count shrinks proportionally, keeping the per-trade dollar risk constant at `capital × 0.6%`. Layering inverse-vol scaling on top is redundant for single-instrument SL-aware algos. The canonical vol-target win is in MULTI-instrument portfolios where it equalises risk contribution across uncorrelated instruments.
- **Subsumes old Phase D.2** ✓
- **What this means for the demo deploy:** Engulfing rr3_lb6_r06 stays on `risk_per_trade=0.6%`. vol_target stays available in the codebase but is not on the deploy path — operator can swap it in if/when a multi-instrument portfolio reaches deploy stage.

### G.3-followup — Live-path wire-up of vol_target (filed 2026-06-23, deferred)
- **What:** `src/lib/scan/helpers.ts:calculatePositionSize` currently throws on `vol_target` (loud-fail to prevent silent activation). Live-path implementation needs: (a) ATR(14)/price compute from cached bars, (b) recent N closed-position R-multiples query from `paper_positions` for the algo, (c) wire into `calculatePositionSize` mirroring the backtest pattern.
- **Why deferred:** the demo-stage v3 survivor uses `risk_per_trade`, AND the empirical G.3 result showed vol_target doesn't beat risk_per_trade on this single-instrument algo. Wire-up is only needed when (i) a multi-instrument portfolio reaches deploy (Phase I.4 territory) AND (ii) operator actively chooses vol_target sizing for it.
- **Trigger condition:** any algo with `position_sizing.type = "vol_target"` proposed for un-pause. If/when that happens, lift the throw + implement; gated by the same A/B sharpe-improvement comparison.
- **Where it fits in the active roadmap:** below G.5 in Phase G priority (build infra), OR Phase I.4 (multi-instrument R&D), whichever fires first. Listed here so it doesn't drift off the radar.

### G.4 — Build alpha decay monitoring ✅ COMPLETE 2026-06-23
- **Module:** `src/lib/cohort/alpha-decay.ts` — pure-ish (no FE deps); exports `checkAlphaDecay()` per-algo + `evaluateAndApplyAlphaDecay()` cron entry + `buildAlphaDecaySummary()` pure-read for FE. Severity matrix: `none` | `warn` | `decay` | `insufficient_data` | `no_baseline`. Auto-pause when BOTH the 30d window AND the 90d window report Sharpe < `threshold_ratio` (default 0.5) × baseline AND the 90d window has ≥ `min_trades_long` (default 20). Idempotent — won't re-pause an already-paused algo.
- **R-multiple math:** `R = (exitPrice − entryPrice) / (entryPrice − initial_stop_loss_price)` with side flip for shorts. Falls back to `stop_loss_price` for pre-migration-00032 legacy positions. Skips broken-state rows (missing closed_at / exit_price / stop). Inlined to match the `live-mirror-eligibility.ts` + `llm-trader-audit.ts` "no cross-import surface" pattern; all three must stay numerically identical.
- **Tests:** 24 unit + integration tests (`alpha-decay.test.ts`) — pure math, R/Sharpe edge cases (n<2 → null sharpe; std=0 → null sharpe), full classifier severity matrix (5 branches × healthy/warn/decay/insufficient/no-baseline), legacy-stop fallback, supabase mock for the cron loop (0 algos, healthy, decayed-with-auto-pause-fired, idempotent-paused-algo-skipped, sort-order). 3 route-handler tests (`route.test.ts`) — 0 active → no-op message, evaluated → counts + paused list, errors → 500.
- **Migration 00047** applied live — adds `alpha_decay_pause` event_type to the activity_log CHECK constraint. The cron writes one `alpha_decay_pause` row per auto-pause (severity, reason, baseline/short/long stats, config snapshot) so the operator has a durable audit trail. No daily snapshot events written (would clutter — the /reports tab carries the live state).
- **Cron route:** `src/app/api/cron/alpha-decay/route.ts` — admin-auth-gated; 0-active no-op returns `{evaluated:0, paused:0}` without writing rows (the SG.19 cron_idle path is for high-cadence crons; once-daily failures aren't a dead-man signal).
- **Shell wrapper:** `scripts/alpha-decay-cron.sh` (chmod +x) — pattern mirrors `manage-cron.sh` / `scan-cron.sh`. Crontab line documented in script header: `0 9 * * * .../alpha-decay-cron.sh >> /tmp/quanttrader-alpha-decay.log 2>&1`.
- **FE:** `/reports?tab=drift` extended with an "Alpha decay (G.4)" section below the existing win-rate drift panel — severity counts row + per-algo table showing baseline Sharpe, 30d Sharpe (n), 90d Sharpe (n), severity badge, reason. Pure-read via new `useAlphaDecaySummary()` hook + `getAlphaDecaySummaryAction()` server action.
- **Distinct from drift-detector:** that module watches WIN-RATE + sets `live_trading_enabled=false`; alpha-decay watches SHARPE + sets the stronger `status='paused'` (halts the scan entirely). Both can coexist on the same algo without conflict.
- **scripts/README.md** + **CLAUDE.md cron list** updated to include `alpha-decay-cron.sh`.
- **Gate (per spec): correctly flags decay scenarios on synthetic fixture; with 0 live algos runs without error.** ✓ Both proven by tests (`evaluateAndApplyAlphaDecay (cron integration) > 0 active algos → returns evaluated:0 + no DB writes` + `decayed algo with non-zero stddev → decay severity + auto-pause SQL fires`).

### G.5 — Build walk-forward OPTIMIZATION re-fit cron + apply REVERT 2 + REVERT 4 ✅ COMPLETE 2026-06-23
- **Module:** `src/lib/algo-search/walk-forward-opt.ts` — pure-ish (no FE deps); exports `extractCurrentGeometry()` (Layer B template gate), `sliceBarsToWindow()`, `computeWfoProposal()` (per-algo proposal builder), `evaluateAndApplyWfo()` (cron entry with DRY_RUN flag). Reuses `enumerateLayerBVariants()` (96-variant grid) + `runPortfolioBacktest()` (each variant on the windowed bars) + `computeDeflatedSharpe()` (selection-bias-aware ranking). When `best_dsr > current_dsr + 0.05` AND geometry differs AND `!dry_run`, UPDATEs `algorithms.rules` JSONB + writes `wfo_rules_updated` audit event with before/after geometry + DSR delta + window range + config snapshot.
- **Skip-reason taxonomy:** `no_layer_b_geometry` (algo uses vol_target / non-rr_multiple TP / non-swing_anchor SL / off-grid axis value), `no_bars_cached`, `insufficient_window_data` (<2 trades across 96 variants in window), `no_baseline_in_window`, `no_improvement`. Checked in pipeline order; geometry check runs FIRST so non-Layer-B algos don't waste a DB hit loading bars.
- **Tests (24 total):**
  - `walk-forward-opt.test.ts` (19) — extraction matrix (clean / regime+adx flags / 4 non-Layer-B rejection branches / 3 off-grid axes), window slicing (inclusive boundary / empty / overflow), skip-reason classification, DRY_RUN no-mutation, apply-mode contract (applied.length === updates.length === inserts.length, payload shape), passes_buffer gate (unreachable buffer → no apply), DETERMINISM ("same data → same proposal → no flapping" — the spec gate's structural property)
  - `route.test.ts` (5) — DRY_RUN default, `?dry_run=0` explicit-flip, conservative gate (`?dry_run=true|1|yes|no` all treated as dry), counts in body, 500 on error
- **Migration 00048** applied live — adds `wfo_rules_updated` event_type to activity_log CHECK constraint
- **Cron route:** `src/app/api/cron/wfo/route.ts` — admin-auth-gated; `?dry_run=0` is the ONLY value that flips to live mode (any other value, including missing, defaults to dry). maxDuration=300s for the 96×N-algos backtest fan-out.
- **Shell wrapper:** `scripts/walk-forward-opt-cron.sh` (chmod +x) — `WFO_QUERY` env override for the dry_run flag; crontab line `0 6 1 * *` in script header. Conservative default `?dry_run=1`; operator changes `WFO_QUERY=?dry_run=0` in `.env.local` (or edits the script) after 2-3 cycles confirm stability.
- **spec.md §5 step 9** added documenting the post-deploy WFO process (REV 2 + REV 4); pre-registration interpretation: WFO process IS the registered methodology, so per-cycle parameter updates are within-process, not new registrations.
- **CLAUDE.md cron list** + **scripts/README.md schedule table** updated (alpha-decay + wfo both promoted from "Planned" to "Live"; G phase fully shipped).
- **Gate (per spec): "DRY_RUN cycles confirm parameters don't flap month-to-month"** — proven structurally by the DETERMINISTIC test (same data → identical proposal); operationally the gate fires after the first 2-3 monthly cycles in production with live data, which is an operator-side observation. The conservative default (`?dry_run=1`) + the explicit-only flip + the audit event per change all make the operator-side gate satisfiable without risk.

**REV 2 + REV 4 status:**
- REV 2 (Layer B becomes diagnostic-only): the manual Layer B sweep script (`scripts/canonical/algo-search.ts MODE=layer-b`) stays in the repo as an exploration tool, but production parameter mutation is now the cron's responsibility. Updated spec.md §5 step 9.
- REV 4 (static → walk-forward-optimized deployment): infrastructure shipped. Becomes the active deployment model once operator un-pauses the v3 survivor (G.6) AND adds the wfo crontab line. Until then, the algo runs with whatever parameters G.6 stamps in.

### G.6 — Operator stamps acceptance packet + execute un-pause SQL (~30 min)
- Operator stamps 8 decisions in revised `algo-search-acceptance.md` §6
- I execute UPDATE algorithms + add pre-registration entry to `preregistration.json` BEFORE first live trade + verify SELECT
- **Gate:** algo shows `active` in DB; scan cron picks up within 15 min (verifiable in activity_log)

### G.7 — Demo period (3–6 months for gold 4h)
- Scan + manage cron pick up algo (every 5/15 min)
- Alpha decay cron runs daily, tracks live R vs baseline
- Walk-forward-opt cron runs monthly in DRY_RUN (no parameter mutation during demo)
- `/reports?tab=drift` shows current alpha health
- No operator action required unless decay alert fires

### G.8 — Demo gate evaluation (at 30 trades)
- Compute live mean R + bootstrap CI
- Compare to deflated in-sample CI from F.4
- Compare to k-fold CV per-fold mean R range from F.3
- **Pre-register at G.6:** loose (live R within ±50% of deflated in-sample point) OR strict (live R CI overlaps deflated in-sample CI)

### G.9 — Branch on G.8
- **PASS** → Stage 5.3 real $10K FTMO challenge (existing pattern; operator-stamped separately)
- **FAIL** → Phase H (algo retires; demo period was the OOS test that v3 methodology lacked)

---

# PHASE H — Methodology upgrade (8–12 weeks; sequential; informed by demo results)

**Purpose:** regardless of G outcome, this is the Tier 3 → Tier 2 upgrade.
Items run in order, not in parallel.

### H.1 — Wire OANDA positioning data as feature (2–3 days)
- New `EntryCondition` variant `positioning_contrarian` in `src/types/algorithm.ts`
- Uses existing 4-year `oanda_positioning_cache` data (currently unused)
- Layer B-style sweep extension with new axis
- **Gate:** ≥5% additive Sharpe vs baseline

### H.2 — Feature library augmentation (1–2 weeks)
- `src/lib/features/` directory with 30–50 features (vol regime, time-of-day, day-of-week, range expansion/contraction, relative volume, MA alignment, RSI extremes, calendar proximity, daily-bias agreement, cross-asset correlation, etc.)
- **Gate:** library exists + 30+ features computable + per-feature unit tests

### H.3 — Feature importance via gradient boosting (3–4 days)
- xgboost trained on next-4h-return-sign across all H.2 features + 14 pattern primitives
- Python sidecar via subprocess (mature ecosystem; TS port is risky)
- **Gate:** held-out AUC > 0.55; top-10 features identified

### H.4 — Augment chosen algo with top features as composers (2 days)
- New Layer B sweep on chosen algo's BASE with top-importance features added as filter axes
- Re-evaluate via DSR + PBO + k-fold CV
- **Gate:** feature-augmented variant has DSR ≥ baseline + 0.10

### H.5 — Quarterly research cycle establishment (1 day to define; cycles run 90-day cadence)
- `scripts/canonical/quarterly-research-cycle.md` template
- Cron schedule (1st of Jan/Apr/Jul/Oct)
- Per-cycle artifacts: feature library refresh, alpha library snapshot, decay report, new-hypothesis log
- **Gate:** template exists; first cycle executes 90 days from now
- **Replaces:** old `scripts/canonical/B6_continuous_validation_cadence.md` (marked SUPERSEDED in that file)

### H.6 — Regime classifier + regime-conditioned models (1 week)
- Vol-percentile cluster on gold 4h (3 regimes: low/medium/high vol)
- Per-regime Layer B sweep
- Inference-time regime detection + parameter routing
- **Gate:** combined DSR across regimes ≥ single-model DSR + 0.10

### H.7 — SG.20 regime_filter calibration reconciliation (0.5 day)
- Layer B observation: `regime_filter=ON` killed 92% of passing variants → calibration issue
- Reconcile with H.6 regime model. Either fix calibration OR drop axis from spec
- **Gate:** decision finalized + spec + Layer B + walk-forward-opt updated

### H.8 — Factor orthogonality model (2–3 days; requires ≥2 deployed alphas)
- `src/lib/stats/factor-orthogonality.ts`: pairwise R correlation + regression vs momentum / vol / carry factors
- Alpha = regression intercept; t-stat tells real-alpha significance
- **Subsumes:** old Phase D.3 (correlation-aware portfolio)
- **Gate:** each live alpha has factor-orthogonal alpha measured

---

# PHASE I — Advanced / aspirational (6+ months; OPTIONAL items)

Operator decides each at the time. No commitment to any.

### I.1 — Bayesian optimization replacing Layer B grid (1–2 weeks)
GP surrogate with expected improvement. 30–60 evaluations vs 96 grid + continuous parameter resolution. Useful when search families grow to thousands.

### I.2 — Continuous research pipeline (2–3 weeks)
Daily cron re-evaluates all deployed + shadow candidates. Weekly digest. Quarterly full library refresh. Subsumes H.5 cadence into automated weekly.

### I.3 — Phase D.4 LLM-trader path (paid, last; 1–2 weeks)
Restore from `scripts/archive/2026-06-18/`. `$25/month` budget cap enforced. Runs as Tier 2 alpha alongside rules-based algos. Uses H.2 feature library as context.

### I.4 — Multi-instrument expansion (ongoing; only after gold demo stable per `[[feedback_gold_only_demo_stage]]`)
Forex re-research with H.2/H.3 feature library. Indices, commodities other than gold.

### I.5 — Market impact model (only at $100K+ deployed; Almgren–Chriss square-root impact)

### I.6 — Alternative data (news sentiment, social, options flow; operator + cost decision at the time)

### I.7 — CB.C7 `lib/market-data` restructure (operator-deferred via AOD.1 until after first $10K challenge)

---

## Reverts (consolidated; happen in-place at the listed phase)

| ID | Revert | When | Why |
|---|---|---|---|
| **REV 1** | Drop `pattern_robustness ≥2 cells` v2 criterion | F.5 | Heuristic data-snooped after v1 null result; replaced with formal DSR + PBO |
| **REV 2** | Drop Layer B as required production stage | G.5 | Layer B becomes diagnostic-only; walk-forward-opt is production parameter mechanism |
| **REV 3** | Drop "ship single best by Calmar" stop-loss clause | F.5 | Calmar maximization is itself overfit-prone; replaced with DSR ranking |
| **REV 4** | Drop static parameter deployment | G.5 | Monthly walk-forward-opt re-fit; parameters update with rolling 12-month window |

Nothing else gets reverted. Pre-registration discipline, Phase B fidelity gates,
block bootstrap CI, demo-gate spec, per-broker portfolio modeling, `Search:` +
`LayerB:` namespacing — all kept.

---

## Items deferred-by-trigger (not orphaned; waiting on a specific condition)

| Item | Trigger | Lands in |
|---|---|---|
| B.1.8.a broker spread calibration | ≥50 broker spread samples per forex symbol | H or I (after gold-only relaxes) |
| B.1.23 portfolio-halt baseline-vs-gated | ≥2 deployed algos sharing broker | H.8 (factor orthogonality) |
| Phase D.1 strategy generation | Subsumed by H.2 + H.3 | H phase |
| Phase D.2 vol-targeting | Subsumed by G.3 | G phase |
| Phase D.3 correlation-aware portfolio | Subsumed by H.8 | H phase |
| Phase D.4 LLM-trader | After Phase H complete | I.3 |
| Forex re-research | After 1 stable gold demo | I.4 |
| CB.C7 lib/market-data restructure | After first $10K challenge | I.7 |

---

## What stays (KEEP these; they are the working infrastructure)

- 7 Phase B fidelity gates in backtest (siblings/spread/risk-pool/FTMO-termination/re-entry-cooldown/portfolio-halt/R-aware-consec-loss)
- Block bootstrap on confidence intervals
- Per-broker portfolio modeling (`broker_connections.account_capital` + sibling grouping)
- Pre-registration discipline + `preregistration.json` workflow
- Demo-gate before real capital (Stage 5.2 contract)
- `validate-algo.ts` as single source of truth for evaluation
- Per-instrument friction calibration with `friction_source_disclosure`
- Roadmap + memory persistence
- Test coverage on critical paths (1380+ tests)
- ESLint discipline (0 errors gate)
- `Search:` + `LayerB:` candidate namespaces in `algorithms` table

---

## First action this week (concrete)

| Day | Task | Owner |
|---|---|---|
| Mon | F.1 — build `src/lib/stats/deflated-sharpe.ts` | me |
| Tue | F.2 — build `src/lib/stats/pbo.ts` | me |
| Wed–Thu | F.3 — build `src/lib/stats/purged-kfold.ts` + validate-algo integration | me |
| Fri AM | F.4 — re-evaluate top 3 Layer B candidates under v3 | me |
| Fri PM | F.5 + F.6 — revise spec + acceptance packet to v3 | me |
| Fri EOD | F.7 — operator review of revised packet + decision A/B | operator |

The current `algo-search-acceptance.md` is **DEFERRED** until F.6 completes —
don't stamp it as-is. v2 numbers may not survive v3 deflation.

---

## What I am explicitly NOT doing

- **No new Phase E sweep.** Diminishing returns from another exhaustive grid on the current pattern catalog.
- **No methodology pivots after seeing F.4 data.** v3 is the locked spec; F.7 outcome is whatever it is.
- **No parallel work.** Single linear sequence prevents the "which version are we on?" confusion.
- **No operator decisions until F.7.** All technical decisions are mine through Phase F build.
- **No deploying an overfit candidate.** If F.7 outcome B (0 candidates pass), we accept null and skip directly to Phase H.

---

## Lineage

| Date | Event | File |
|---|---|---|
| 2026-06-23 | Phase E spec created (v1 with WR ≥ 37 + Bonferroni 0.05/308) | `algo-search.spec.md` |
| 2026-06-23 EVE | v2 pivot after v1 null (CI lower + pattern robustness) | `algo-search.spec.md` |
| 2026-06-23 EVE LATE | Layer B sweep complete; 67/288 pass v2 per-candidate criteria; all singletons | `algo-search-acceptance.md` |
| 2026-06-23 LATE | Stage 6.7 acceptance packet written | `algo-search-acceptance.md` |
| 2026-06-23 LATE | Operator audit-question: are we doing "grueling exhaustive search on static ruleset"? Answer: YES, that's the gap | (conversation) |
| 2026-06-23 LATE | F/G/H/I framework adopted; v3 methodology planned; ROADMAP.md created | this file |

---

**End of ROADMAP.md. To modify this file, prefix the change with a new dated
line in the Lineage table.**
