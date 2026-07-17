# Forensic Audit — 2026-07-09: NIGHT+4 reconstruction, zombie 4th algo, price-data corruption

**Session context:** operator returned after 10 days ("find where we left off") and asked for a full
audit of the right move. This document is the evidence record for everything found and every action
taken. All claims below were verified live against the DB, the transcripts on disk, and re-runs —
sources are named per section.

---

## 1. What happened on 2026-06-29 evening (NIGHT+4) — reconstructed

The operator's last instruction (17:52Z): *"I've done it all. Could you continue the search for more
qualifying gold algorithms on every metric?"*

The session transcript (`26c3a0ef…jsonl`) physically stops mid-turn at **18:01:19Z** (client stopped
logging conversation; only checkpoint footers + file-history snapshots persist after that). The work
continued unrecorded. Reconstruction from recovered transcript fragments, file mtimes, and DB rows:

| Time (Z) | Event | Evidence |
|---|---|---|
| 17:54:21 | `comprehensive-daily-bias-sweep.ts` written + launched | transcript lines 50774–50777 |
| 18:01:19 | Sweep result returned — **31 algos tested, 1 passer** (below) | transcript line 50778 (recovered verbatim) |
| ~18:20 | `four-algo-with-short-stress.ts` written + run | file snapshot @18:20:11 + file mtime |
| 18:40:35 | **CHOCH-Short 4th algo deployed** — active + live on FTMO Test $100K | `algorithms.created_at` + `backtest_results.computed_at` |
| ~18:42 | `five-algo-expansion-stress.ts` written; session ends silently | file snapshot @18:42:12 |

Nothing was committed; no ROADMAP entry; no handoff doc. The four scripts sat untracked for 10 days.

### Recovered sweep output (transcript line 50778, verbatim summary)

31 4h `Search:*` algos augmented with `daily_bias`. **All 31 fail the rigorous per-candidate
criteria** (`per_cand=✗` on every row). Exactly one passes the operator/FTMO hard gates
(WR≥37, DD≤10, daily≤5, trades≥30, return>0):

```
pattern              | dir   | trades | WR     | DD     | daily_DD | Sharpe   | total_R
  CHOCH                Short    45     37.8%   4.97%   1.21%    0.2689    21.0
Summary: 1/31 pass all hard FTMO+operator gates with daily_bias filter
```

So the deploy script's core claim ("only 4h Short passing all hard gates") is **faithful to the
actual sweep output**. The subsequent claims (4-algo "strict dominance": worst ML 9.20% vs 10.86%,
0 vs 3 breaches) come from the lost segment and are **unverifiable** — see §3 for why the underlying
dataset can no longer reproduce them. The five-algo script's verdict was never recorded anywhere.

---

## 2. The 4th algo was a zombie — root-caused

**Every scan evaluation of the CHOCH algo threw from deploy+5min until today:** 52 `error` events in
`activity_log`, all `algorithm_id = 47fef493-…`, all `{"error": "Invalid time value"}`, first
2026-06-29 18:45:21Z, last 2026-07-09 17:15Z. Arithmetic cross-check: each 4h close produced exactly
3 `signal_no_action` (the healthy longs, 165 total ≈ 3×55 closes) + 1 `error` (CHOCH, 52 ≈ 1×55).
**The algo never completed a single evaluation** — no trades, no broker orders, silent for 10 days.

**Root cause (verified against code):** `deploy-choch-short-daily-bias.ts` wrote `news_veto` with the
wrong key shape — `{minutes_before, minutes_after, impact_levels}` — while the schema and every
consumer (`validators/algorithm.ts:24-26`, `scan/entry-gates.ts:75-85`,
`economic-calendar.ts:198-215`) expect `{block_minutes_before, block_minutes_after, min_impact}`.
`Math.max(undefined, undefined) * 60 * 1000 = NaN` → date arithmetic on NaN →
`RangeError: Invalid time value` on every flat-side gate pass. The three healthy algos carry the
correct keys (activated 2026-06-29 via `clampRules`-shaped values).

**Actions taken:** rules corrected to canonical shape; algo set `status='paused'`,
`live_trading_enabled=false`. It stays paused until E2.20 re-derivation (below) decides keep/kill.

**Lesson (filed as memory):** deploys must be schema-validated + smoke-scanned against the LIVE path
before activation, and post-deploy error streams must be watched. 52 consecutive errors on a live
account went unnoticed for 10 days.

---

## 3. Price-data corruption — the systemic P0

### 3a. What was found (all numbers measured, 2026-07-09)

| Row | Stored bars | Distinct instants | Damage |
|---|---|---|---|
| XAU/USD 4h full | 11,169 | 8,838 | 2,331 duplicate instants; **62 dupes inside the live 200-bar eval window**; span reduced to 2023-04→now (~3.2yr) |
| XAU/USD 1day full | 15,032 | 10,040 | 4,992 format-dupes + anchor-mixing (~2.9× true daily count) — **this is the live `daily_bias` input** |
| XAU/USD 30min full | 10,346 | 8,048 | 2,298 dupes |
| EUR/USD 1h full | 32,613 | 17,608 | 15,005 dupes |
| EUR/GBP/JPY 4h fulls | ~11,45x | ~11,11x | ~340 dupes each |

Worse than duplicates: the 4h row's tail contained **hourly bars** (2026-07-07/08 are a continuous
1h grid) and a **fetch-time partial bar** (`2026-07-08T14:31:23.000Z`). Live "4h" pattern evaluation
ran over 1h candles for ~2 days.

### 3b. Root causes (code-verified)

1. **Format-duplicate bug (DQ.2):** `price-cache.ts#normalizeBarDate` passed any `T…Z` string
   through untouched, so OANDA's nanosecond ISO (`…T21:00:00.000000000Z`) and Twelve Data's
   normalized ISO (`…T21:00:00Z`) never collided in `savePricesToCache`'s dedupe Map. One bar per
   provider format per instant, growing on every provider alternation.
2. **Cross-granularity pollution (DQ.3):** the fallback chain can serve finer bars under a coarser
   request (observed: 1h bars into the 4h row); the merge accepted them blindly.
3. **Deep-history destruction:** live cron merges + provider count-caps (OANDA 5000, TD 5000)
   reshaped the 4h row from the ~10.5yr corpus (which all Phase E/F backtests through 2026-06-29
   read) down to a ~3.2yr dual-provider union. The June-29 committed stress runs (0/529 windows)
   used the deep row; by today only 157 windows' worth of data existed.

### 3c. Consequences for prior conclusions

- **My earlier "the deploy numbers don't reproduce — falsified" claim (this session, pre-audit) is
  RETRACTED.** The re-runs compared different datasets (and a corrupted one at that). Neither
  confirmation nor falsification of the NIGHT+4 four-algo/five-algo claims is currently possible.
- **All historical backtests that read `price_cache` full rows carry a data-quality caveat** —
  including the June-29 10.5yr runs (the deep row was built by the same merge machinery and may have
  contained interleaved provider grids in its middle years). The E2.20 re-derivation on the pinned
  single-source dataset is therefore a re-confirmation pass for the THREE DEPLOYED LONGS too, not
  just for CHOCH.
- The 4h row's `total_R=0.0` output in the four-algo script was a type bug (`BacktestTrade` has no
  `r_multiple`), present in the as-run 2026-06-29 output as well (tsx doesn't type-check).

### 3d. Fixes landed (this session, all verified)

| Fix | Where | Verification |
|---|---|---|
| Canonical bar dates: every recognized format → fixed-width `toISOString()` output | `price-cache.ts#normalizeBarDate` (DQ.2) | 8/8 unit tests; one instant = one string across nano/plain/space/date-only/offset |
| OANDA emits canonical dates at source | `oanda.ts#oandaToBar` | build ✓ |
| Cross-granularity write rejection (median-spacing < 0.75× interval → reject + warn) | `price-cache.ts#savePricesToCache` (DQ.3) | unit tests: 240min median across weekend ✓, 60min pollution rejected ✓ |
| One-shot dedupe repair across all 26 cache rows | `repair-price-cache-dupes.ts` (APPLY=1 run) | post-repair: every XAU row total == distinct |
| **Pinned research datasets** — OANDA-paginated deep history, hashed manifest | `fetch-pinned-history.ts` → `data/xau-usd-h4-pinned.json` (17,810 bars, 2015-01-01→2026-07-09, sha256 6d10d04b…) + `data/xau-usd-d-pinned.json` (2,993 bars, sha256 2002afce…) | single-grid, single-source, versioned in repo |
| Live gold rows rebuilt from pinned files | `rebuild-price-row-from-pinned.ts` | 4h tail-200: 200 instants / 40 days ≈ 5/day single grid ✓; D1 tail-60: 60 bars / 60 days ✓ |

**Policy (filed as memory + E2.19):** verdict-grade research reads pinned files, never the live
cache. The live cache is for live scans only.

### 3e. Residual data risks (explicitly NOT fixed today)

- Forex/other-ticker rows: format-dupes repaired, but mid-history provider-grid interleaving remains
  (matters at Phase I.4 forex re-research; rebuild from pinned files then).
- D1 anchor semantics: live `daily_bias` reads provider D1 bars (now single-anchor OANDA); backtests
  resample from primary TF. This live-vs-backtest input difference predates today and is filed in
  E2.19 follow-ups, not silently ignored.
- Yahoo fallback can still emit a fetch-time partial bar as the last bar (the DQ.3 median guard
  doesn't catch a single odd bar). Filed in E2.19.

---

## 4. Live-system state after this session

| Item | State |
|---|---|
| ARB / Engulfing / ARB25 (+DailyBias) longs | **ACTIVE, live-mirrored**, re-enabled after data repair (operator-stamped config unchanged: $100K, 0.80% risk each) |
| CHOCH-Short 4th algo | **PAUSED, live=false**, rules repaired — unpause gated on E2.20 |
| Price cache (gold 4h + D1) | Clean, single-grid, deeper than ever (2015→now) |
| Cron stack | scan/manage/heartbeat/oanda-positioning/prune/cohort installed + firing. **alpha-decay (G.4), WFO (G.5), quarterly (H.5) NOT in crontab** — G.4 should be armed (safe); G.5 must stay unarmed until E2.19 verification |
| Broker connection | see readiness check; re-auth if stale before expecting mirrored orders |
| Open positions | 0 (none opened since deploy — consistent with daily_bias-gated cadence in a falling gold tape, though the corrupted window means some entries may have been missed; quantified re-scan filed in E2.20) |
| Known-stale test | `algo-search/state.test.ts` "308 enumerated" — pre-existing failure (universe count moved by E2.7.5 augmentation), attributed via stash-test; filed |

## 5. What is still UNVERIFIED (honest list)

1. The NIGHT+4 four-algo dominance numbers and the five-algo verdict — reproducible only on the
   pinned dataset (E2.20).
2. The three deployed longs' backtest evidence on CLEAN data — June-29 numbers came from the
   old merge-built row (E2.20 priority 1).
3. Whether any long entry was missed during 2026-06-29→07-09 due to corrupted bars (E2.20 re-scan).
4. Live behavior of the fixed pipeline — first verified on the next scan ticks after un-pause
   (watch `activity_log` for errors + `[price-cache] REJECTED` warnings in the scan log).
