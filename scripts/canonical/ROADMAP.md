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

### F.6 — Revise acceptance packet with deflated stats (0.5 day)
- **Update** `scripts/canonical/algo-search-acceptance.md` §1/§2/§3 with DSR-adjusted CI lower + PBO + k-fold consistency per candidate
- **Update §5** risk acknowledgments with deflated context ("expect demo R of X, not in-sample Y")
- **Update §6** decision template — only candidates passing v3 criteria appear as Options A/B/C
- **Gate:** packet shows real expected R, not in-sample illusion

### F.7 — Operator review + decide (operator action, ~30 min)
- **A:** ≥1 candidate passes ALL v3 criteria → proceed to Phase G with top-by-DSR
- **B:** 0 candidates pass → skip G entirely; go to Phase H direct

### F.8 — Branch on F.7 (no third option)

---

# PHASE G — Deploy + safety net (build 1 week + demo 3–6 months)

**Purpose:** the candidate that survives F is going live on demo capital. Before
un-pause, build the monitoring + safety + parameter-update infrastructure that
protects it. We don't want a Tier 2 algo deployed under Tier 4 monitoring.

### G.1 — Build SG.19 (cron-idle activity_log emission) (0.5 day)
- Scan + manage `/api/cron/*` endpoints emit `cron_idle` event when 0 active algos
- Heartbeat endpoint distinguishes `idle` vs `healthy` semantically
- `/reports` last-cron-tick reading derives from activity_log OR cron log file successful HTTP-200 tail
- **Gate:** with 0 active algos, dashboard shows "idle ✓" not "stale ✗"

### G.2 — Build SG.18 (dead-man alert delivery verification) (0.5 day)
- Verify GitHub Actions dead-man workflow ran during recent 3-day silence (`gh run list --workflow=dead-man.yml --limit 50`)
- Verify alert channel delivers to operator-visible inbox; fix if broken
- **Gate:** test alert reaches operator's phone within 5 minutes

### G.3 — Build vol-targeting sizing (1 day)
- New `position_sizing.type = "vol_target"` option in `AlgorithmRules` + Zod schema + backtest engine handler
- **Math:** `position_notional = capital × target_vol_pct / max(per_trade_R_std × instrument_vol_pct, MIN_VOL_FLOOR)`
- Validate via re-backtest of chosen candidate
- **Gate:** ≥10% Sharpe improvement OR documented why not. Subsumes old Phase D.2.

### G.4 — Build alpha decay monitoring (1–2 days)
- New cron `scripts/alpha-decay-cron.sh` (daily 09:00 UTC) + `src/lib/cohort/alpha-decay.ts` shared module + `/reports?tab=drift` integration (extends existing drift surface)
- Per-live-algo rolling 30d/90d Sharpe + hit rate vs in-sample baseline
- Auto-pause threshold: current Sharpe < 0.5 × baseline sustained 30 days
- **Gate:** correctly flags decay scenarios on synthetic fixture; with 0 live algos runs without error

### G.5 — Build walk-forward OPTIMIZATION re-fit cron + apply REVERT 2 + REVERT 4 (2 days)
- New monthly cron `scripts/walk-forward-opt-cron.sh` (1st of month, 06:00 UTC) + `src/lib/algo-search/walk-forward-opt.ts`
- Re-runs Layer B-style geometry sweep on rolling 12-month window ending today
- If best-by-DSR differs from current parameters AND new-best DSR > current + 0.05 buffer: UPDATE `algorithms.rules` JSONB
- Initial mode: `DRY_RUN=1` (logs what it WOULD update); operator flips to live after 2–3 dry-run cycles confirm stability
- **REVERT 2:** Layer B becomes diagnostic-only / one-time exploration
- **REVERT 4:** static deployment → walk-forward-optimized deployment
- **Gate:** DRY_RUN cycles confirm parameters don't flap month-to-month

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
