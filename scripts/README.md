# scripts/ — directory layout (reorganized 2026-06-18 PM)

```
scripts/
├── README.md                    (this file)
├── *.sh                          production cron entrypoints (DO NOT MOVE — paths in crontab)
├── cohort-report.ts              called by cohort-report-cron.sh; keep in root
├── cohort-report-diff.ts         operator-run after cohort-report-cron; diffs latest 2 dated JSONs
├── live-state.ts                 operator "is the system alive?" diagnostic
├── launchd/                      operator's launchd plist (caffeinate)
├── canonical/                    ⭐ THE LIBRARY — fully fleshed-out reusable scripts
│   ├── validate-algo.ts                Full Phase A→B validation runner. Consolidates step2-6 + verify-* + analyze-* with Phase B fidelity gates. Replaces ~10 archive scripts.
│   ├── validate-preregistration.ts     B.2.33 (Stage 3.2, 2026-06-20): standalone Zod-validates preregistration.json. Run BEFORE validate-algo to catch typos in 50ms. Subsumes Stage 4.7.1 quarterly audit.
│   ├── preregistration.json            Pre-registered acceptance criteria per algo (loaded by validate-algo).
│   ├── inspect-algo.ts                 Per-algo backtest re-runner with per-trade detail.
│   ├── sample-forex-spreads.ts         Stage 4.2.a (2026-06-20): MetaApi spread sampler. Operator-runs during London/NY sessions to build per-pair × per-window forex spread corpus.
│   ├── sync-account-capital.ts         Stage 0.2 (2026-06-19): one-off broker_connections.account_capital sync from MetaApi (preserved for future SG.17 live_equity work).
│   ├── B6_continuous_validation_cadence.md  Stage 4.7 (2026-06-20). SUPERSEDED by ROADMAP.md Phase H.5; kept for historical derivation of the rolling-12mo holdout decision.
│   ├── algo-search.ts                  Phase E driver (MODE=list/smoke/full/layer-b). Enumerates Layer A candidates + runs Layer B geometry sweep on per-candidate passers. Per ROADMAP.md.
│   ├── algo-search.spec.md             Phase E meta-pre-registration. v2 active; v3 pending per ROADMAP.md Phase F.5.
│   ├── algo-search-acceptance.md       Stage 6.7 operator-stamp decision packet. DEFERRED until F.6 v3 re-evaluation per ROADMAP.md.
│   ├── revalidate-candidates.ts        Re-validate selected candidates under deflated stats (DSR + PBO + reads existing purged_kfold). Generic + env-driven (TARGETS CSV). Auto-derives family from name pattern. Used at ROADMAP Phase F.4 and any future post-Layer-B re-evaluation (e.g. G.5 walk-forward-opt refit verification).
│   └── ROADMAP.md                      ⭐ ACTIVE FORWARD PLAN. F → G → H → I phases. Read this first.
├── ad-hoc/                       throwaway investigations (default: don't commit)
└── archive/                      old scripts kept for reference
    └── 2026-06-18/               ~96 one-off scripts archived during reorg (step*, verify-*, analyze-*, diag-*, discovery-*, deploy-*, sweep-*, replay-*, phase1-*, phase2-*, etc)
```

## validate-algo.ts env vars (Phase B reference)

Defaults match the operator's locked Phase B configuration; override only when investigating one specific gate or comparing methodologies.

**Selection / persistence**
- `ALGO` — exact-match algo name. Omit to run against all deployed algos. Example: `ALGO="Library: Gold sweep_reclaim-DailyBias-Long 4h"`
- `ALGOS` — comma-separated names. Mutually exclusive with `ALGO`. Stage 4.3 (2026-06-20).
- `LIST_ONLY` — `1` prints the selected algos + exits without running backtests or DB writes. Useful smoke before a long PERSIST run. Stage 4.3 (2026-06-20).
- `QUIET` — `1` suppresses per-algo result lines, keeps startup config + warnings + final SUMMARY. B.2.31 (Stage 3.2, 2026-06-20). Use when you only care about the headline counts (e.g. monthly cron-driven verification).
- `PERSIST` — `1` (default) writes `backtest_results` JSONB to DB. `0` for dry-run.
- `OOS_CUTOFF` — date for STEP 6 holdout split. Default `2025-06-18` (= 12 months before the 2026-06-18 default snapshot per [[feedback_oos_cutoff_sweet_spot]] empirical sweep). Hardcoded literal currently — will go stale; B.6.3 punch is to derive dynamically (today − 12mo).

**Phase B.1 fidelity gates** (each default on; set to `0` to disable for diagnostics)
- `SIBLINGS` — direction-conflict gate (sibling opposite-side blocks entry).
- `SPREAD_GATE` — ATR-ratio proxy for live broker spread.
- `RISK_POOL` — combined open SL-$ cap across siblings.
- `POOL_CAP_PCT` — risk-pool cap as % of capital (default `4`).
- `FTMO_TERMINATION` — force-close all + break timeline on static-DD breach.
- `RE_ENTRY_COOLDOWN` — refuse entry within N minutes of a loss exit (default = 1× bar duration).
- `PORTFOLIO_HALT` — portfolio-level DLL across siblings' realized P&L map.
- `PORTFOLIO_DLL_PCT` — portfolio DLL as % of reference capital (default `5`).

**Portfolio modelling (B.1.7).** Validate-algo groups algos by their `algorithms.broker_connection_id` and treats each group as one portfolio sharing the broker's capital. Siblings (direction-conflict, risk-pool, portfolio-halt) are computed WITHIN groups only — algos on different broker connections don't share capital. Set `broker_connections.account_capital` per account to use the real broker capital as `reference_capital`; algos with unset broker capital (or no broker connection) fall back to per-algo capital (conservative). Example SQL:
```sql
UPDATE broker_connections SET account_capital = 100000
  WHERE label = 'FTMO Test $100k';
```

**Phase B.2 statistical rigor**
- `BLOCK_BOOTSTRAP` — `1` (default) uses moving-block bootstrap; `0` falls back to trade-level i.i.d. (NB: shifts verdicts — see [[feedback_block_bootstrap_verdict_shift]]).
- `BOOTSTRAP_ITERATIONS` — default `2000`.
- `BOOTSTRAP_SEED` — deterministic resampling seed, default `42`.
- `FAMILY_ALPHA` — Bonferroni family-wise alpha, default `0.05`.
- `BONFERRONI_TESTS_PER_ALGO` — per-algo test count for family-size calc. Default `1` (treats step verdicts + pre-reg as a composite hypothesis). Set to ≥5 for strict cross-test correction.
- `PREREG_PATH` — pre-registration file location, default `scripts/canonical/preregistration.json`.

**Usage examples**
```bash
# Default: all gates + block bootstrap + strict pre-reg
pnpm dlx tsx scripts/canonical/validate-algo.ts

# One algo, dry-run, baseline (no gates) for comparing to Phase A
PERSIST=0 SIBLINGS=0 SPREAD_GATE=0 RISK_POOL=0 FTMO_TERMINATION=0 RE_ENTRY_COOLDOWN=0 PORTFOLIO_HALT=0 \
  ALGO="Library: Gold sweep_reclaim-DailyBias-Long 4h" pnpm dlx tsx scripts/canonical/validate-algo.ts

# Re-roll OOS holdout for quarterly cadence
OOS_CUTOFF=2026-03-18 pnpm dlx tsx scripts/canonical/validate-algo.ts

# Trade-level bootstrap (to compare against block bootstrap verdicts)
BLOCK_BOOTSTRAP=0 PERSIST=0 pnpm dlx tsx scripts/canonical/validate-algo.ts
```

**validate-preregistration.ts (Stage 3.2 / B.2.33)** — standalone JSON validator. Catches typos in `preregistration.json` in ~50ms WITHOUT running the full backtest pipeline. Recommended workflow: run this BEFORE every `validate-algo.ts` PERSIST=1 invocation.

```bash
# Default — exits 0 on clean, 1 on schema/JSON error
pnpm dlx tsx scripts/canonical/validate-preregistration.ts

# CI mode — also exits 2 if any entry expired
STRICT_EXPIRED=1 pnpm dlx tsx scripts/canonical/validate-preregistration.ts

# Custom warn threshold
WARN_DAYS=60 pnpm dlx tsx scripts/canonical/validate-preregistration.ts
```

**Registration types (B.2.32, Stage 3.2 2026-06-20)** — three values for `registration_type`:
- `true-prereg` — criteria locked BEFORE the data existed. Statistical novelty on pass.
- `forward-pre-registered` — criteria informed by historical analysis but EVALUATED only against post-`registered_at` data. Clean held-out evidence, not novelty.
- `post-hoc-locked` — criteria locked AFTER seeing full data + applied to both past + future. Operator discipline commitment, not science.

**Discipline going forward** (2026-06-18 PM operator-set):
- Don't create a new script every time you want to test something small. Use `scripts/ad-hoc/` for throwaway tests; only promote to `scripts/canonical/` when it's a tool we'll use repeatedly.
- The canonical library stays small and fully documented. Each canonical script has full inline docs + usage examples + clear acceptance criteria.
- Archive (don't delete) old one-offs — they're useful evidence of past investigations.

# Cron scripts

**Production cron runs on the operator's local macOS machine via the system
`cron` daemon.** Each scheduled script loads `CRON_SECRET` from
`.env.local`, sends a Bearer-auth request to a locally-running Next.js
server, and exits non-zero on HTTP failure so cron flags it.

This is intentional — there's no separate cron host. The trade-off is
that the Mac and the dev server must be up for any scheduled task to
fire. Mac sleep, a closed lid without "prevent sleep on AC", or a
crashed `pnpm dev` all stall the schedule until the next tick.

## Current schedule

The list below mirrors `crontab -l`. The crontab itself isn't checked
into the repo (the absolute path is `$HOME`-specific, varies per
operator), but the schedule should be kept in sync with this table.

| Cadence | Script | Endpoint | Log |
|---|---|---|---|
| Every 5 min (`*/5 * * * *`) | `manage-cron.sh` | `/api/cron/manage-positions` | `/tmp/quanttrader-manage.log` |
| **Every 15 min (`*/15 * * * *`)** | `scan-cron.sh` | `/api/cron/scan-active-algorithms` | `/tmp/quanttrader-scan.log` |
| Daily 04:00 UTC (`0 4 * * *`) | `prune-sentiment-cache-cron.sh` | `/api/admin/prune-sentiment-cache?days=30` | `/tmp/quanttrader-prune.log` |
| Every 20 min (`*/20 * * * *`) | `oanda-positioning-cron.sh` | `/api/admin/snapshot-oanda-positioning?instruments=XAU_USD` | `/tmp/quanttrader-oanda-positioning.log` |
| Every 5 min (`*/5 * * * *`) | `heartbeat-cron.sh` | `/api/cron/heartbeat` | `/tmp/quanttrader-heartbeat.log` |
| Weekly Sun 23:00 UTC (`0 23 * * 0`) | `cohort-report-cron.sh` | _(none — direct script via Supabase)_ | `/tmp/quanttrader-cohort-report.log` |
| Weekly Mon 09:00 UTC (`0 9 * * 1`) | `prereg-expiration-cron.sh` | _(none — direct script reads `scripts/canonical/preregistration.json`)_ | `/tmp/quanttrader-prereg.log` |
| Monthly 1st 06:00 UTC (`0 6 1 * *`) | `validate-algo-monthly-cron.sh` | _(none — direct script, computes OOS_CUTOFF=today−12mo)_ | `/tmp/quanttrader-validate-algo-YYYYMMDD.log` (dated) |
| Every 6h (`0 */6 * * *`) | `broker-health-snapshot-cron.sh` | _(none — direct script via MetaApi adapter)_ | `/tmp/quanttrader-broker-health.log` |
| Hourly (`0 * * * *`) | `broker-spread-sampler-cron.sh` | _(none — direct script via MetaApi adapter)_ | `/tmp/quanttrader-broker-spread.log` |
| Daily 09:00 UTC (`0 9 * * *`) | `alpha-decay-cron.sh` | `/api/cron/alpha-decay` | `/tmp/quanttrader-alpha-decay.log` |
| Monthly 1st 06:00 UTC (`0 6 1 * *`) | `walk-forward-opt-cron.sh` | `/api/cron/wfo?dry_run=1` | `/tmp/quanttrader-wfo.log` |
| Quarterly 1st 07:00 UTC (`0 7 1 1,4,7,10 *`) | `quarterly-research-cycle-cron.sh` | `/api/cron/quarterly-cycle` | `/tmp/quanttrader-quarterly-cycle.log` |

### Planned crons (per `scripts/canonical/ROADMAP.md` Phase G)

NOT YET BUILT. Will be added to crontab after their respective Phase G items
ship. Operator-installed via `crontab -e` once script lands; do NOT add to
crontab pre-build.

_(All Phase G crons have shipped — section retained for future phases.)_

The 15-min scan cadence is chosen to align with bar-close moments
across 15m, 1h, and 4h primary timeframes simultaneously. At `*/15 * *
* *` the cron fires at `:00 :15 :30 :45` past each hour, catching
every 15m bar close within seconds AND every 1h bar close at exactly
`:00`. Previously the scan ran hourly (`0 * * * *`) which meant 15m
signals were missed entirely (3 of every 4 bars) and 1h signals had up
to 60 min latency to entry.

When 1d primary-timeframe algos go live, add a separate daily cron
entry aligned to the daily bar close (00:00 UTC for forex/gold)
rather than scanning at finer granularity than needed (saves
price-cache misses).

The 5-minute manage tick still walks open paper positions for SL/TP
and signal-based exit checks. This keeps intraday exit latency at ≤5
minutes without burning quote-API budget on tickers with no open
positions.

Both scripts are idempotent — running more often than the cadence above
is safe; the underlying endpoints just do less work.

## Dead-man's switch (heartbeat-cron.sh)

The pipeline is a chain of local single points of failure: Mac asleep →
cron silent → zero DB traffic → Supabase free tier auto-pauses the
project (this exact chain ran 2026-05-24 → 2026-06-10, unnoticed).
`heartbeat-cron.sh` closes the visibility gap with an **inverted**
monitor:

1. Every 5 min it calls `/api/cron/heartbeat` (the stale-scan detector).
2. Only when fully healthy (HTTP 200 **and** `stale_count: 0`) does it
   ping `HEARTBEAT_PING_URL`.
3. The monitor behind that URL alerts when pings STOP arriving — one
   alert covers Mac sleep, dead cron daemon, crashed server,
   paused/erroring Supabase, and silently-stale scans.

**Active alert channel: GitHub Actions** (`.github/workflows/dead-man.yml`,
2026-06-10). Every 30 min GitHub — independent infrastructure, no extra
account — runs FOUR parallel jobs: (1) `check-heartbeat` calls the
anon-executable `public.last_manage_tick()` RPC and FAILS when the
latest manage_tick is older than 45 min; (2) `check-scan-tick`
(`last_scan_tick()`, 35 min); (3) `check-broker-api` (added
2026-06-11 after MetaApi's global client-API outage went unalerted —
our pipeline was green while broker mirroring was dead) probes the
MetaApi london client host and FAILS on connect-timeout across two
attempts; (4) `check-alpha-decay-tick` (added 2026-07-20, E2.25.i —
the daily G.4 auto-pause safety net had NO liveness signal and died
silently for days in the 2026-07 outage): calls `last_alpha_decay_tick()`
and FAILS when the latest `alpha_decay_tick` heartbeat is older than 26h.
On ANY job failing, a redundant ntfy.sh phone push fires (urgent
priority). GitHub also emails the repo owner on scheduled-workflow
failures, and the failing job's name says which alarm fired. Covers Mac
sleep, dead cron, crashed server, broker-API outage, and paused/erroring Supabase
end-to-end. Secrets `SUPABASE_URL` / `SUPABASE_ANON_KEY` are encrypted
repo secrets (the repo is public — nothing sensitive in the workflow
file).

Alternative/additional channel: create a free check at
https://healthchecks.io (grace ~15 min) and add its ping URL to
`.env.local` as `HEARTBEAT_PING_URL=...` — `heartbeat-cron.sh` pings it
only when fully healthy. Without the var the script still logs health
locally but sends no ping.

Side benefit: the heartbeat's DB query plus the 5-min manage tick keep
enough traffic flowing that the Supabase free tier won't auto-pause
again.

## Pre-requisites

- `.env.local` at the repo root with `CRON_SECRET=...` set.
- A Next.js server running on `localhost:3000` (`pnpm dev` or `pnpm
  start`). Use `pnpm start` for production cron — it's faster and
  doesn't recompile on disk changes.
- macOS Full Disk Access granted to `cron` if the scripts ever read
  files under protected paths (System Settings → Privacy & Security →
  Full Disk Access → add `/usr/sbin/cron`).

## Keep-awake LaunchAgent

`launchd/com.huffed.quanttrader.caffeinate.plist` is a user-level
LaunchAgent that runs `caffeinate -dis` and respawns it on exit. Idle
sleep is what killed the 2026-06-15 evening scan window — the Mac dozed
on the default 10-min AC timer, cron silently missed the 20:00 UTC 4h
bar-close, and only the GH Actions dead-man caught it. This plist holds
`PreventSystemSleep` / `PreventUserIdleSystemSleep` /
`PreventUserIdleDisplaySleep` assertions for as long as the user is
logged in.

Note: `caffeinate -dis` overrides the idle-sleep timer but NOT a
closed-lid sleep. Keep the lid open (or use an external display with
clamshell power settings).

Install on a fresh Mac:

```bash
cp scripts/launchd/com.huffed.quanttrader.caffeinate.plist \
   ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) \
   ~/Library/LaunchAgents/com.huffed.quanttrader.caffeinate.plist
```

Verify:

```bash
launchctl print "gui/$(id -u)/com.huffed.quanttrader.caffeinate" | head
pmset -g assertions | grep -A1 'caffeinate command-line tool'
```

Uninstall:

```bash
launchctl bootout "gui/$(id -u)/com.huffed.quanttrader.caffeinate"
rm ~/Library/LaunchAgents/com.huffed.quanttrader.caffeinate.plist
```

## Editing the schedule

```bash
crontab -e
```

Reference entries (swap `/Users/jack.jones/...` for your repo path):

```cron
# Manage open positions every 5 minutes — handles intraday SL/TP + signal exits
*/5 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/manage-cron.sh >> /tmp/quanttrader-manage.log 2>&1

# Scan active algorithms every 15 minutes — entry evaluation aligned to
# 15m and 1h bar closes (00, 15, 30, 45 past each hour)
*/15 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/scan-cron.sh >> /tmp/quanttrader-scan.log 2>&1

# Prune sentiment_cache rows older than 30 days, daily at 04:00 UTC
0 4 * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/prune-sentiment-cache-cron.sh >> /tmp/quanttrader-prune.log 2>&1

# Snapshot OANDA positioning (XAU_USD by default) every 20 minutes —
# OANDA's positionBook itself only refreshes on a 20-min cadence
*/20 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/oanda-positioning-cron.sh >> /tmp/quanttrader-oanda-positioning.log 2>&1

# Weekly $0 cohort report — learning-loop REVIEW layer. Sunday 23:00
# UTC = post-weekly-close. Writes dated JSON to scripts/cohort-report-*
# AND streams the summary to the log. No endpoint — script connects to
# Supabase directly, doesn't need pnpm dev running.
0 23 * * 0 /Users/jack.jones/Documents/trading-app/demo-1/scripts/cohort-report-cron.sh >> /tmp/quanttrader-cohort-report.log 2>&1

# Weekly pre-registration expiration sweep — SG.3 operator workflow.
# Monday 09:00 UTC = start-of-week review window. STRICT_EXPIRED=1
# inside the wrapper means cron exits non-zero on any EXPIRED entry,
# surfacing the actionable state on the operator's daily log review.
# Entries expiring within WARN_DAYS (default 30) are flagged as
# "EXPIRING SOON" in the report so the operator has runway to plan a
# re-registration walk-forward run BEFORE silent fallback. No endpoint
# — reads scripts/canonical/preregistration.json directly.
0 9 * * 1 /Users/jack.jones/Documents/trading-app/demo-1/scripts/prereg-expiration-cron.sh >> /tmp/quanttrader-prereg.log 2>&1

# Broker spread sampler every hour — B.1.8 closure (data-capture half).
# Calls adapter.fetchQuote per broker_connections × default ticker list
# (XAU/USD, EUR/USD, GBP/USD, USD/JPY). Appends a JSONL row per sample
# to scripts/broker-spread-samples.jsonl. The eventual ATR-correlation
# calibration analysis consumes ≥50 samples/symbol to validate/refute
# the spread-gate ATR proxy used in the backtest fidelity layer.
0 * * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/broker-spread-sampler-cron.sh >> /tmp/quanttrader-broker-spread.log 2>&1

# Broker health snapshot every 6 hours — SG.9.1 closure.
# Calls MetaApi fetchAccountInfo per broker_connections row + writes
# last_synced_at + account_snapshot (success) / last_error (failure).
# The /reports Brokers tab (SG.9) reads from these fields; without this
# cron, they only update when manage/scan crons touch the broker. Light
# enough to stay well inside MetaApi rate limits (4 ticks/day × N
# connections × 1 call = trivial). Per-connection failures are
# first-class data — the cron exits 0 even when individual brokers fail.
0 */6 * * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/broker-health-snapshot-cron.sh >> /tmp/quanttrader-broker-health.log 2>&1

# Monthly full-fleet validate-algo run — Stage 4.7.2 / B.6 cadence.
# 1st of each month, 06:00 UTC (post-Asia close, pre-London open
# = quiet window). Wrapper computes OOS_CUTOFF=today−12mo (BSD `date
# -v-12m` with GNU `date -d "12 months ago"` fallback so the same
# crontab line works if cron host migrates Linux). PERSIST=1 writes
# backtest_results JSONB to Supabase so monthly verdicts are queryable.
# Each run also writes a DATED log /tmp/quanttrader-validate-algo-YYYYMMDD.log
# so per-month verdict diffs accrue rather than getting overwritten.
# Productive even with all algos paused — catches engine regressions
# month-over-month + pre-positions for Stage 5 re-deploy.
0 6 1 * * /Users/jack.jones/Documents/trading-app/demo-1/scripts/validate-algo-monthly-cron.sh >> /tmp/quanttrader-validate-algo-monthly.log 2>&1
```

`crontab -l` shows the active list; `crontab -r` removes everything
(careful — there's no confirmation prompt).

## Verifying a job is running

- Tail the log: `tail -f /tmp/quanttrader-scan.log` (or the prune log).
- Each successful run prints `http=200 body=...`.
- Manual smoke test: just run the script directly —
  `./scripts/scan-cron.sh` and check the exit code.

If the log is silent past the expected tick, check:

1. Is `pnpm dev` / `pnpm start` running? (`curl http://localhost:3000`)
2. Is `cron` allowed to run? (macOS sometimes pauses the daemon on
   battery; plug in.)
3. Does the script run by hand? Run it directly to surface the error.

## Dead-man alert response runbook (E2.24.g.viii, 2026-07-29)

You got an ntfy push / GitHub failure email. The alert is CORRECT until
proven otherwise — the 2026-07-22→28 outage paged for 6 days before
anyone acted. Work the list top-down; total time ~2 minutes.

**Since 2026-07-28 the app server is a launchd service** —
`com.quanttrader.server` runs production `pnpm start` on port 3000
(RunAtLoad + KeepAlive; logs at `~/Library/Logs/quanttrader-server.log`).
Do NOT also run `pnpm dev` on port 3000; it will fight the service.

1. **Is the server up?** `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login`
   - `200` → server fine, go to step 3.
   - anything else → step 2.
2. **Restart the service:** `launchctl kickstart -k gui/$(id -u)/com.quanttrader.server`
   then `tail -20 ~/Library/Logs/quanttrader-server.log` (expect "✓ Ready").
   If the log shows a build/module error (usually after a code merge):
   `pnpm build && launchctl kickstart -k gui/$(id -u)/com.quanttrader.server`.
3. **Are the crons installed + firing?** `crontab -l` (expect ~9 entries) and
   `tail -4 /tmp/quanttrader-scan.log` (expect recent `http=200`).
   Crontab empty → restore from the "Current schedule" section above.
4. **Which tick is stale?** The failing GitHub job names it: scan (>35 min),
   manage/heartbeat (>45 min), alpha-decay (>26 h — cron runs 6-hourly at :10).
5. **Confirm recovery:** wait for the next scheduled dead-man run (≤30 min) or
   force one: `gh workflow run dead-man.yml --ref dev`, then
   `gh run list --workflow=dead-man.yml --limit 1` → conclusion `success`.

After ANY code merge to `dev`, the running service keeps executing the OLD
build until you: `pnpm build && launchctl kickstart -k gui/$(id -u)/com.quanttrader.server`.

## Adding a new cron entrypoint

1. Add the route under `src/app/api/admin/` or `src/app/api/cron/`.
   Gate it with `verifyAdminAuth(request)` from `@/lib/api/admin-auth`.
2. Copy one of the existing scripts and swap the URL / log message.
   Make it executable: `chmod +x scripts/<new-script>.sh`.
3. Add a row to the **Current schedule** table above with the cadence,
   endpoint, and log path.
4. Add the crontab line via `crontab -e`. Reference it in the
   **Editing the schedule** snippet so future operators copy the right
   command on a fresh machine.

## Operator / research tooling

Non-cron scripts live alongside. Each takes `ALGO_ID` and other env
vars where applicable (`pnpm dlx tsx scripts/<name>.ts`). Run from the
repo root.

| Script | Purpose |
|---|---|
| `inspect-algo.ts` | Generalised backtest re-runner for any algorithm. Optional overlay of trailing stop / breakeven / DXY filter via env vars. Used to validate persisted rules against a fresh corpus. |
| `sweep-dxy-params.ts` | Sweeps DXY filter (lookback × pip_threshold × mode) on an algo's corpus. Output ranks by lowest DD with controlled return drag. |
| `sweep-sl-tp-variants.ts` | Sweeps structural SL/TP (swing_anchor × buffer × rr_multiple) via walk-forward. Used to find regime-adaptive SL/TP configs. |
| `rebuild-gold-stack.ts` | Multi-window validator. Tests strategy candidates against full walk-forward + last 6mo + last 60d. Used when our methodology needed a recency check after deploys disagreed with current regime. |
| `reconcile-broker-close.ts` | Operational fallback when a broker-side close isn't auto-reconciled by the manage cron. Reads MetaApi history-deals, writes the close back to `paper_positions`. |
| `replay-friend-trades.ts` | Replays a CSV of a real trader's trades and scores how often our pattern primitives reproduce their entries (≥30% overlap is the bar before claiming "clone"). Canonical replay tool. |
| `gold-search.ts` | Combinatorial search runner restricted to the gold (XAU/USD) universe. |
| `vet-search-candidates.ts` | Vet candidates emitted by `gold-search` against the long-corpus inspect harness before activation. |
| `dryrun-generate-from-search.ts` | Dry-run wrapper around the algorithm-generation flow seeded from search output. Inspect generated rules without writing the algorithms row. |
| `exit-mechanics-replay.ts` | $0 screen: replays recorded WF entries through SL-geometry × exit-mechanics grids (zero LLM calls), with a fidelity gate against recorded outcomes. Screen-then-confirm: candidates that win here go to ONE paid walk-forward confirmation. |
| `cohort-report.ts` | The learning loop's weekly review: per-cohort expectancy (regime / prompt / side / confidence / session / entry-zone) from `llm_decisions` outcomes + `paper_positions` tags, decay flags (last 14d vs prior 14d), and shadow-gate candidates (log-only first, scoped per algo+prompt_version). Run weekly and after any config change. $0. |
| `cohort-report-diff.ts` | **SG.6.2 (2026-06-22 NIGHT LATE).** Diffs the latest two dated `cohort-report-YYYY-MM-DD.json` files written by the weekly cron. Surfaces new/disappeared decay flags + new/disappeared shadow-gate candidates + trade-count growth between consecutive runs. Reads pure JSON — no Supabase access. Schema requirement: both files must be post-SG.6.1 typed-array shape (script rejects pre-SG.6.1 nested-Record schema with a pointer). Run after each weekly cohort cron tick. `pnpm dlx tsx scripts/cohort-report-diff.ts` (auto-picks latest 2) or `pnpm dlx tsx scripts/cohort-report-diff.ts <prior.json> <latest.json>` for explicit pair. |
| `canonical/m1-progress.ts` | **M1 evidence tracker CLI (2026-07-21)** — G.8 gate comparator: live paper-trade per-trade R vs the pinned-corpus baseline (30 trades, ±30% band). Shares `src/lib/cohort/m1-evidence.ts` with the /reports "M1 evidence" tab. Baseline constants in `src/lib/cohort/m1-baseline.ts`, regenerated via `MODE=algo-stats … e2.22-layer-b-pinned.ts` (writes `e2-results/g8-baseline.json`). `pnpm dlx tsx scripts/canonical/m1-progress.ts`. $0. |
