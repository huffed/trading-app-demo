# Phase E — the modernisation plan (skeleton)

**Status: plan only, drafted 2026-11-06.** No code changes, no renames applied, the whole-tree Prettier PR stays held. Part 1 is written in full because it is structure: it changes where code lives and how it reads, not what it does. Part 2 is placeholders, because what those items should do depends on what the audit finds. Writing them now would be guessing, and every one says what the guess would be. Nothing in this file starts before the audit verdict except the one item marked otherwise, because the `src/` files cited by line on `review/skeptical-audit-2026-10` must not move or be reformatted until then.

`docs/DEBT.md` is the register and carries the evidence; this file is the order of work. `DEBT.md`'s reference to `MODERNISATION.md` §4 means E4, and its "one engine, two adapters" is decision P2.

## Rules for every Phase E PR

- One concern, under about 500 lines, squash-merged, one at a time against `dev` (`docs/decisions/0002`). A pure move never carries a behaviour change, and a behaviour change never carries a move.
- **Proof of no behaviour change:** `make check` is green, `pnpm build` passes, `make backtest` prints `golden: MATCH`, and the PR says so. A PR that cannot show that is not structure and belongs in Part 2.
- **What golden does not prove.** The replay runs `runPortfolioBacktest` and no code under `src/lib/scan/`, and some live gates are never reached from the backtester. A change to live sizing, halts or exits still prints MATCH. So E0's live-path test comes first, and on any PR touching a fenced path or `src/app/api/cron/**` it is part of the standard proof. `make parity` would add to this, but it is not wired yet.
- Strictness only ratchets up. Each PR lowers `.eslint-warning-budget` if it can and never raises it. A touched file that crosses to the target rule set stays there.
- The fence lifts per session and only by the operator (`docs/decisions/0004`, `0006`). Most of Part 1 touches fenced paths, so it needs that for the session, stated in the PR title.
- Paths below are today's. E4 moves many of them, so an item after E4 finds the new path in `CODE_QUALITY.md` §1.2. Counts come from `DEBT.md` or Phase A unless they carry a date, and each item's first PR measures again.

## Part 1. Structure-only work

In this order. The live-path test goes first because every later item proves itself with it, formatting next so later diffs are readable, the other characterisation tests before anything moves money-path code, and names before structure.

### E0. The live-path test (D-05)

Tests only, in `tests/characterisation/`, no production change. The rules above rest on this test, because the golden replay cannot see the live engine. Entry points: `scan/engine.ts` `scanAlgorithm`, `scan/manage.ts` `manageActiveAlgorithms`, and `api/cron/scan-active-algorithms/route.ts`, where `applyPortfolioHalts` runs the portfolio halt. One scenario per path with the database, price feed and broker stubbed: an entry, a stop, a target, a stagnant exit, each halt and a flatten, pinning the size, the rows written and the activity events. The database stub checks each column against the accepted list parsed from the migrations, the way `tests/contracts/db-check-constraints.test.ts` does, with its `checkListFor` exported for this. A stub that accepts everything would pin `daily_loss_halt` as closing a row: `paper_positions.exit_reason` refuses it, while `activity_log.event_type` accepts it. Proof: tests pass against unchanged code.

### E1. Whole-tree Prettier, with a blame-ignore file

**Held until the verdict (operator).** Two PRs, because merges here squash and the hash to ignore does not exist until the first one lands.

1. Extend `.prettierignore` for generated JSON, then `pnpm exec prettier --write .`, and `make format-all-check` flips from informational to a CI step. `make format` takes changed files and `pnpm format` takes `src/**/*.{ts,tsx}` only, so neither is the whole tree. 361 files fail `prettier --check .` today (2026-11-06), 279 of them in `src`. Sixteen generated `scripts/canonical/*.json` files and `src/lib/brokers/ctrader/proto/descriptor.json` are among them and are not ignored, so without the ignore lines the next research run or `proto:gen` would turn a required check red.
2. `.git-blame-ignore-revs` with the squash commit's hash, and the DEV_SETUP line for `git config blame.ignoreRevsFile`.

The first PR's size is the exception to the 500-line rule because the diff is generated; the PR says so. Proof: the standard one.

### E2. Money-path test plan (D-05)

Tests only, no production change, so that E4 onward can show behaviour held. `tests/characterisation/` already pins sizing and the lot floor, halt flatten, fill simulation, the daily-bias flag and the day-reset timezone. Still missing, in this order:

| Module | What to pin |
|---|---|
| `patterns/evaluate.ts` (304 lines, complexity 39) | one fixture per pattern family, from the pinned slice |
| `algorithm/structural-sl.ts`, `algorithm/stagnant-exit.ts` | the exit reasons and the levels they set |
| `constants/markets.ts` | `riskToLots`, `pnlInUsd`, `clampLotsToConstraints` |
| `market-data/prices.ts` | the fallback order; D-31's failed-call path, as behaviour, without deciding it |
| `market-data/economic-calendar.ts` | D-32's fail-open paths, as behaviour, without deciding them |
| `market-data/twelve-data.ts`, `brokers/metaapi.ts` | response parsing and error shapes, from recorded responses |
| `utils/pnl.ts` | the P&L formulas in use |

Also: `vitest` coverage reported, not gated, for `src/lib/{scan,market-data,algorithm,constants}` (DEBT §4); typed builders for the `asFixture` call sites (D-05 ledger, target 2027-01-31). A known defect becomes an `it.fails` test pointing at its DEBT id, never a skip. Proof: tests pass against unchanged code.

### E2b. Log what the money path discards (D-04, additive half)

`DEBT.md` wants this as the first Phase E PR. It runs after E1 and E2 instead, so its diff is readable and proved: `logger.error` on the discarded errors and a `price_source` value on the fallback path, in log lines only. Nothing is raised and no branch changes; a new column would be a migration and is not this PR. Never log a URL or a raw response: `twelve-data.ts:21,95` carry `apikey=` in the URL, so a logged URL would put the key in the journal. Proof: the standard one.

### E3. Dead code remainder (D-10)

The 22 dead files went in B8. Left because they sit inside audit-cited files: 89 unused `src/lib` exports, the two dead P&L formulas in `utils/pnl.ts:161-178,269-278`, `getTradeStats`, and nine comments that still cite `backtest-engine.ts` or `dual-run-validator.ts`. Neither the Phase A scan's output nor its tool is in the repo, so the first PR pins the tool as a dev dependency, adds a make target and commits the list to `docs/decisions/evidence/`. `defaultLeverage` has no callers and stays anyway, because P15 may need it. One PR per directory. Proof: the standard one, and a repeat of the scan showing the count fall.

### E4. Rename map (D-12), names first

`CODE_QUALITY.md` §1.2 and §1.3 are the map. **Only rows tagged `safe-rename` or `safe-move` are E4**, about 80 of them. The 32 `restructure` rows are not renames: those a later item names go there, and the rest, such as `GateVerdict` and `setActiveCurrency`, get their own plan when reached. Order, so each PR is one idea:

1. `CONVENTIONS.md`: the naming rules and the target layout, which `CODE_QUALITY.md` already refers to and every later step reads. The first PR also strikes the map rows for files B8 deleted (`backtest-engine.ts`, `dual-run-validator.ts`, `strategies/`, `trading-profile.ts`).
2. Exported types and functions whose names lie about what they do: verbs that hide I/O (`checkNewsVeto` fetches, `evaluateAndPrune` writes, `computeLiveMarketState` persists), then `check*` returning objects.
3. The glossary: `symbol` outside `src/lib/brokers/` to `ticker` (265 sites), the 22 `Algo*` types, one spelling of British or American.
4. Files, directory by directory, editing import lines and nothing else: `scan/` to the engine's real shape, `algorithm/` to gates, the four backtesters out of `market-data/`, the auto-pause out of `cohort/`. `CODE_QUALITY.md` §2.1 has the target tree.
5. The 18 type-only import cycles go with the moves that dissolve them (§2.4).

**Excluded, whatever the row says:**

- The exit-reason and activity-event rows (§1.3): P1.
- One ATR and one Sharpe: P13.
- `symbol` as data. `trades.symbol` is a database column (`00002_create_trades.sql:7`, `types/trade.ts:8`) and `symbol` is Twelve Data's request field. Both keep the name; changing the column is a migration, not a rename.
- A name something outside the app calls. `scripts/ops/kill-switch.sh:110` POSTs to `/api/admin/flatten-algo`, and that script streams from the local `origin/dev` to a host running the last deployed commit, which can be a week behind. Renaming the route in one PR would give the switch a 404 and leave positions open, with `make check` and golden green. Such a rename is four steps: add the new name as an alias, deploy, change the caller, then remove the alias after the next deploy. The cron wrappers' URLs get the same treatment.

CI holds added files to the strict rule set. A move counts as a rename and passes through (tested 2026-11-06), but a stub left at the old path, a split, or a small file falling under 50% similar makes the new file an added one. So a move PR edits import lines only, leaves no stub, and shows no `A` rows in `git diff --name-status`.

Each PR updates `.claude/hooks/live-paths.txt` and decision 0006's list in the same commit, or the fence silently stops covering the moved file; `make fence-check` gains a test that every glob matches at least one file. Proof: the standard one. `docs/CODE_QUALITY.md` and `docs/DEBT.md` line citations go stale here by design, and the PR updates the ones it touches.

### E5. Duplication clusters (D-11)

After E4, so shared code lands in its final directory. The byte-identical groups only: both `TOOLTIP_STYLE` variants, `meanOf`/`stdOf`/`sharpeFromR` into `r-stats.ts` beside the search code, `intervalMinutes`, `EVENT_ICONS`, `fmtCurrency` 2 of 4, `formatDuration` 2 of 3, `computeRMultiple` 2 of 3, `ScanResultsList`, `pnlState`, `LoadingStrip`, `isoToUnixSeconds`, `isPriceIndicator`, `AlgorithmWithWatchlist`, `mulberry32`, and the row types that really are one shape (`ClosedRow` is not one across its six files). `fmtPrice`, `PriceBarLike` and `closesUpTo` are already done. Inline fragments after that: the pagination tail and the admin-route preamble. Each PR compares the copies again before merging them. **Not merges:** `StatCard`, the `fmtCurrency` null-guard and `abs` variants, `holdDuration`, `SaveButton`, the R-multiple variant, three Sharpe formulas and four ATR helpers differ in behaviour, so choosing one is P13. Route catch blocks differ too, and they belong to P3. jscpd is not in the repo, so the first PR pins it and adds a make target. Proof: the standard one, and jscpd's count falling from 167 clones.

### E6. Type escapes (D-15)

The 13 ad-hoc `AlgoRow` projections into one row type, and the three private `SupabaseClient<any,any,any>` aliases removed, along with the different alias at `chart/chart-markers.ts:9`. 22 `as unknown as`, 7 `as never` and 13 `any` come down through those. **Not here:** the `event_type`, `exit_reason` and `reason` unions and `checkExitTrigger(): string | null` (P1), a real parse in `rulesFromRow` (P16), and stricter compiler flags (P17). Proof: the standard one.

### E7. Config consolidation (D-09)

`src/lib/env.ts` exists and nothing imports it, and wiring it in as it stands is a behaviour change. Its accessors throw on a missing key, where `economic-calendar.ts:128-132` warns and returns `[]`, so a missing Finnhub key would throw instead of switching the veto off. The structure half is narrower:

- One module reads the 19 env names at 40 sites, **each keeping today's behaviour on a missing value**, and leaf modules take values as arguments. D-09's `OPERATOR_USER_ID` case and any key that becomes required are P14.
- Literals get a name with their value unchanged: leverage `?? 30` at four sites plus the ternary at `helpers.ts:108`, the two premium-zone thresholds, the timeframe maps. Nothing merges. Those values differ, some on purpose, so choosing between them is P15.

The first PR has to meet three constraints. Next inlines only literal `process.env.NEXT_PUBLIC_X` references, so a schema over `process.env` sees nothing in the browser. CI's `make build` sets two public variables, so a parse at module load fails the build. There is no `instrumentation.ts`, so nothing runs "at startup" until one exists. Proof: the standard one, and a test for each changed read with its key unset.

### E8. Complexity hotspots (D-13)

182 functions over cyclomatic 10, 39 at 20 or more. `CODE_QUALITY.md` §2.2 has a split proposal for each file over 400 lines. In order: `scan/helpers.ts calculatePositionSize` (30), `prop-firm-backtest.ts closeSimPosition` (29), `market-state.ts computeMarketState4h` (39), `patterns/evaluate.ts evaluateIctSmcPattern` (39), then `portfolio-backtest.ts`'s `tryOpenEntry` (59) and `runPortfolioBacktest` (50). Each extraction sits behind E2's tests. CI holds new files to the strict rules (complexity 10, 80 lines per function), so a function at 59 cannot land in a new file as it is. Split inside the existing file first, and move a piece out only once it meets those rules. Proof: the standard one, and the ESLint warning budget falling by what the split removed.

### E9. Datetimes (D-14), the mechanical half

Injectable clocks in the halts, defaulting to the system clock, so day-boundary tests stop needing fake timers. `parseBarDate` (`market-data/parse-bar-date.ts`) at the bare `new Date()` calls on bar strings: `inspect-backtest/route.ts:109,111,120,121`, `loser-analysis/route.ts:49,52,227,229,245,246`, `walk-forward.ts:101,114,115`, `position-chart-actions.ts:87,91`. Sites that compare with each other change together: `loser-analysis:49` and `:52` agree today only because both are local. `parseBarDate` has no test of its own and its comment does not cover date-only daily bars, so the first PR pins that input before using it on daily bars.

**Not here:** which instant a trading day starts at. Every boundary is UTC midnight while FTMO uses 00:00 CE(S)T, and moving it changes halts. Nor `analytics.ts:242,287`, which bucket by local month and weekday in the browser: making them UTC changes what the operator sees and picks a reporting day. Both are P6. Proof: the standard one, and a test run under a non-UTC `TZ`, because on CI's UTC the old and new parsing agree. For the same reason the swap preserves behaviour only on a UTC host, so the first PR confirms the VPS timezone, read-only and with the operator's approval.

### E10. Research folder (D-20)

`scripts/canonical` is 62 flat scripts. Target from `CODE_QUALITY.md` §1.2 with one change: `scripts/{deploy,feed,research,reporting}/`. **The 13 scripts that row sends to `ops/` go to a new `scripts/deploy/` instead**, and they go first because they touch production: `deploy-*`, `enable-broker-mirror`, `sync-account-capital`, `metaapi-connection-doctor`, `broker-mirror-readiness-check`, `snapshot-broker-health`, `capture-broker-spread`, `sample-forex-spreads`, `build-spread-model`. `scripts/ops/` is permanently unfenced (decision 0006), and `deploy-*` scripts can insert algorithms with mirroring on (D-33). `scripts/deploy/` joins `.claude/hooks/live-paths.txt` and decision 0006 in the same PR, and `tests/hooks/cases.ts:17` changes with it.

Helper copies move to `scripts/canonical/lib/` only where they are byte-identical. `loadBars` must not merge: `revalidate-candidates.ts:119-128` reads pinned data and refuses otherwise, while `feature-veto-validate.ts:209-223` reads `price_cache`, so one copy would break the pinned-data rule or change a script.

Nine decision-feeding scripts are already under ESLint; the 33 that remain come under it or go to `scripts/archive/` by 2027-01-31. `verify-stress-test`, `verify-session-boundary` and `verify-mc-challenge` become vitest tests, a rewrite in its own PR, because they are top-level code ending in `process.exit`. **Which scripts are superseded is P7.** Proof: `make typecheck`, which covers `scripts/`, a diff showing only import lines and strings naming a moved script changed, and `git grep` for each old path finding no code. The compiler cannot see the string calls: `algo-search.ts:241`, `comprehensive-daily-bias-sweep.ts:62` and `e27.5-cell-coverage-augmented.ts:177` start other scripts by path. **Never run or import a moved script as proof.** Every script runs on import, 58 of the 62 through a module-level `main()` and the rest as top-level code, and none reads `process.argv`, so `--help` is ignored: `enable-broker-mirror.ts` would set `live_trading_enabled: true` on production. The one script `make test` already runs is `validate-preregistration.ts`, which writes nothing. A dry-run guard is an edit to a fenced script, so it is its own PR. Every cron wrapper's path changes in the same PR, with the fence.

### E11. Repository hygiene (D-17)

285 tracked run artifacts under `scripts/archive/2026-06-18/` (253 JSON and JSONL, 32 logs): move out of git or keep with a README saying why, the operator's call on size. About 100 MB of pinned JSON stays in git by policy; a note on LFS cost and benefit, no migration unless the operator asks. Stale references: `scripts/canonical/ROADMAP.md:315` and `docs/PROJECT_CONTEXT.md:216`. Proof: the standard one, and the size change stated in the PR.

### E12. Next.js 16 checklist

Read from the bundled guide (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`) and checked against the repo on 2026-11-06, Next 16.2.4:

| Change | State here |
|---|---|
| `middleware` renamed `proxy`; the edge runtime is not supported in `proxy` | **Outstanding.** `middleware.ts` still uses the deprecated name. Rename with its function, confirm it needs no edge runtime, and update the three-places note in `CLAUDE.md` and `docs/PROJECT_CONTEXT.md:161,342,406` |
| Async `cookies`, `headers`, `draftMode`, `params`, `searchParams` | Done: no synchronous use found |
| Async `id` and params on image and sitemap routes | Not applicable: none exist |
| `next/image` defaults, `next/legacy/image`, `images.domains` | Not applicable: `next/image` is not used |
| Parallel routes need `default.js` | Not applicable: none exist |
| Turbopack by default; `next.config.ts` keys | `next.config.ts` has no `webpack`, `experimental` or `images` keys; `next build` already runs it |
| `next lint` removed, flat config | Done: `eslint` directly, flat config |
| AMP, runtime config, `devIndicators` options, `unstable_rootParams`, `experimental.dynamicIO` | Not used |
| `revalidateTag` second argument, `updateTag`, `refresh` | Not used |
| Concurrent `dev` and `build`; `.next/dev` | No action |

`proxy.ts` is the only code change. It is a rename on the auth path that also moves auth from edge to Node, so it follows E4's rules. The matcher covers `/api/:path*`, so the host check is a sign-in and a cron tick. Audit citations: `review/05-frontend.md` names `middleware.ts`.

### E13. Hook gaps and the sandbox (D-22) — not blocked by the verdict

No audited file moves here, so this can land at any time, target 2026-12-31. Enable Claude Code's sandbox with reads of `.env*` denied, after checking that `make db-types` and `pnpm build`, which read `.env.local`, still work under it. In `hook-input.cjs`, join backslash-newline continuations before the guard's line loop, with a hook case for each rule. Then the false positive on `find src/app -type d -name '@*'`, refused 2026-11-06. Until then the guards stay the explained stop and the deny rules the hard stop for file tools. Proof: a canary file in `tests/hooks/` that the sandbox refuses, and `make check`.

## Part 2. Waits for the audit verdict

Each of these needs the audit's numbers or verdict, or changes behaviour that the audit is measuring. **Waits for audit verdict** is the status of every entry, and `review/VERDICT.md` on the audit branch releases them (operator, 2026-11-06). That file does not exist yet. The Phase 2 report does (`review/02-validation.md`, `ccd3d70`, 2026-10-28), and it reads: "'Might work but the sample can't tell us yet' is the strongest honest statement; 'selected noise riding a bull market' is equally consistent with the data." It also finds the result does not survive the selection it came from (deflated Sharpe 0.25 to 0.34). Phases 3, 6 and 7 decide what is worth keeping. Where the audit already answers part of a row, the row says so, but that does not release it. The fourth column gives that answer and what writing the item now would still be guessing.

| # | Item | Debt | What the audit has said, and what is still a guess |
|---|---|---|---|
| P1 | Which contract is canonical for exit reasons and activity events, and then the `event_type`, `exit_reason` and `reason` unions and `checkExitTrigger` | D-01, D-15 | Three versions exist; the choice depends on what the engine has actually written and what the audit's measurements read. A4 lists what the database rejects: `stagnant_exit`, `daily_loss_halt`, `portfolio_halt` and four activity events. Migration 00053 on draft #291 is part of this |
| P2 | One implementation of the rules: is live or the backtester the reference for sizing, fills and halts; and `quantity` and `sl_distance` on the trade record | D-02 | A6, A9, A10 and A11 are the drift inventory. A6: bias differs on 3.76% of bars and 5.26% of signals (227 live only, 22 backtest only), and in a mini-simulation the live-only signals average +0.21R gross (n=315 algorithm-signals) against about 0.35. A9: the live cache has 39 zero-volume Friday 21:00 bars the pins lack, touching 0.7% of signals and 2.8% of P&L. A10: no once-per-bar throttle on the deterministic path; 3 of 14 live entries fired 121 to 210 minutes after bar close. A11: paper fills on Twelve Data quotes against OANDA bars, by accident. A5, the fills: on the 7 paper trades that match a backtest trade, the whole gap is one NFP stop filled $49 through the level at the 5-minute poll; across all 14, missed and extra trades (−0.31R) outweigh that fill (−0.16R). Which side becomes the reference is still open, because choosing first would pick which results stay valid |
| P3 | Which logged errors become raised errors on the money path, including route catch blocks and wrapper exit codes | D-04 | Raising changes what trades happen on a bad tick; the audit says which failures matter. Error codes differ between routes, and `scan-active-algorithms/route.ts:199` turns a failure into a 200 |
| P4 | Lot quantisation and pool capital as a parameter; with them the static FX table, `m1-evidence.ts:198` and manual-close pricing | D-08 | **A2 answers the floor's effect on the baseline: there it is a harness artefact.** The baseline ran a $10K pool with a 0.01-lot floor that skipped 101 of 862 signals, while paper sizes $100K with no floor. At paper sizing the baseline is n=862, mean R 0.343, against the published n=843, 0.2551; the audit does not reconcile 862 − 101 with 843. On a real $10K account the floor is a real broker minimum, which `02-validation.md` §2.6 models, so it stays in the challenge simulations. Still open: the epsilon fix, which changes trades, and re-deriving the verdicts that used the $10K pool |
| P5 | Delete, fence or fix the self-modifying and dormant paths | D-06, D-07 | **A3 answers part of D-06:** the hour-filter ratchet and pair auto-pause exist only live, and simulated over the baseline they cut 872 trades to 46 and mean R from 0.340 to −0.028, with every algorithm auto-paused by January 2016. **A13 answers part of D-07:** the dormant LLM path can still exit and move the stop to break-even, and its close lacks the atomic claim. Delete, fence or fix still depends on the verdict on the five algorithms and on the LLM path |
| P6 | The trading-day boundary, and the reporting day in `analytics.ts` and on client pages | D-14 | FTMO's 00:00 CE(S)T against UTC changes halts and day attribution, so it changes results. A16 also notes that daily loss is measured on fixed `capital`, not the day-start balance, and that there is no live 10% max-loss halt, only a UI gauge |
| P7 | Which research scripts are superseded | D-20 | Depends on which verdicts survive re-deriving at paper capital (P4) and the daily-bias fix (P18); 31 are provisionally superseded |
| P8 | What the golden file should pin | Golden rule | Today it pins the backtester's current behaviour, not correct behaviour. Decisions that change the backtester regenerate it on purpose. P3 and P5 are live-only, so golden cannot see them and the live-path test carries them |
| P9 | The bar path on a failed OANDA call | D-31 | Whether the unfiltered fallback bars change results is the audit's fill finding; the fix follows the measurement |
| P10 | The news veto | D-32 | A working calendar or the rule off: either changes live behaviour against a baseline that never applied it. A16: FTMO imposes no news restriction during Challenge or Verification, so this veto is self-imposed and unmodelled |
| P11 | The fenced half of a failed broker close | D-25 | Keeping the paper row open changes what analytics count |
| P12 | Roadmap sequencing after Phase E | `scripts/canonical/ROADMAP.md` | Depends on the verdict itself |
| P13 | Which formula or component survives where the copies differ: Sharpe, ATR, R-multiple, `StatCard`, `SaveButton`, the money formatter (recorded in `CONVENTIONS.md`, operator 2026-10-29) | D-02, D-11 | Each choice changes numbers the audit reads |
| P14 | What fails at startup. **High priority within Phase E (operator, 2026-10-28).** `OPERATOR_USER_ID` unset runs all users' rows today; which keys become required | D-09, D-18 | Failing closed changes startup behaviour, and a service that will not start runs no manage ticks, so each key needs its own decision. Ships as its own PR |
| P15 | Config values that differ: leverage `?? 30` against `defaultLeverage` (50 for gold); premium zones 60/40 and 67/33, which `entry-cohort.ts:13-16` says differ on purpose; the `default: 240` timeframe fallback | D-09 | Choosing changes sizing, a gate or a persisted cohort. All five deployed rules set `leverage: 50`, so golden cannot show the change |
| P16 | Whether `algorithms.rules` is parsed on the scan path, and the three shapes of `backtest_results` | D-06, D-15 | `algorithmRulesSchema` strips unknown keys and adds `type` to legacy conditions, so a parse changes what the engine reads. Golden already feeds parsed rules and cannot show it |
| P17 | `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` | DEBT §4 | One root tsconfig, so they turn on once. Fixes in bar loops add guards, which are control flow, so they follow P2 |
| P18 | The dropped daily-bias flag | D-02 | A6: the backtest is one session staler on the 17:00 and 21:00 bars, not leaky, and live is leak-free. Forwarding the flag changes trades, and P7 depends on it. `tests/characterisation/daily-bias-alignment.test.ts:88` holds it as `it.fails` |
| P19 | Orphan adoption, the session-started dashboard, the script that turns mirroring on | D-26, D-29, D-33 | Whether and when mirroring is wanted depends on the verdict |
| P20 | Production's recorded migration history against the files | D-34 | Both fixes are outside structure work: a baseline migration changes migration files under the audit freeze, and `supabase migration repair` writes production's `supabase_migrations.schema_migrations`; migrations are fenced either way. Even a history that replays does not let the files rebuild the schema from zero, which is D-34's second half. The D.6 restore drill shows whether the recorded history replays, before anything changes |

## Before any algorithm gets `live_trading_enabled=true`

Not Phase E work as such, but a gate it must not pass over. Each of these is mirrored money going wrong:

- **P1:** the exit-reason CHECK rejects halt-flatten values and nothing reads the error, so a flatten can leave the broker closed and the paper row open.
- **P4:** `live-execution.ts:146-151` clamps up to the broker's minimum, so 0.0084 lots on a $10K pool becomes 0.01, about 19% over the intended risk on a signal the backtest skips.
- **P10:** the news veto.
- **P19:** D-26, D-29 and D-33.
- **D-25, both halves, D-27 and D-28:** a failed broker close must be seen, a re-run of the switch must flatten, and resume must not read OK with algorithms active. The script fixes are on #324; the engine half of D-25 is P11.
- **D-19, before real capital:** 16 raw `fetch()` calls have no outbound timeout.
- **No live 10% max-loss halt (audit A16):** FTMO's max loss fails the account, and only a UI gauge watches it. Its DEBT row follows after the window, when #323 and #324 have merged.
- **P6, a decision either way:** FTMO's day is CE(S)T and every boundary here is UTC, so the operator either moves it or accepts the gap in writing.
