# Phase E — the modernisation plan (skeleton)

**Status: plan only, drafted 2026-11-06.** No code changes, no renames applied, the whole-tree Prettier PR stays held. Part 1 is written in full because it is structure: it changes where code lives and how it reads, not what it does. Part 2 is placeholders, because what those items should do depends on what the audit finds. Writing them now would be guessing, and every one says what the guess would be. Nothing in this file starts before the audit verdict except the one item marked otherwise, because about 220 `src/` files are cited by line on `review/skeptical-audit-2026-10` and must not move or be reformatted until then.

`docs/DEBT.md` is the register and carries the evidence; this file is the order of work. `DEBT.md`'s references to `MODERNISATION.md` §4 mean Part 1's order below.

## Rules for every Phase E PR

- One concern, under about 500 lines, squash-merged, one at a time against `dev` (`docs/decisions/0002`). A pure move never carries a behaviour change, and a behaviour change never carries a move.
- **Proof of no behaviour change:** `make backtest` prints `golden: MATCH`, `make check` is green, and the PR says so. A PR that cannot show that is not structure and belongs in Part 2.
- Strictness only ratchets up. Each PR lowers `.eslint-warning-budget` if it can and never raises it. A touched file that crosses to the target rule set stays there.
- The fence lifts per session and only by the operator (`docs/decisions/0004`, `0006`). Most of Part 1 touches fenced paths, so it needs that for the session, stated in the PR title.

## Part 1. Structure-only work

In this order. Formatting goes first so later diffs are readable, characterisation tests go before anything that moves money-path code, and names go before structure.

### E1. Whole-tree Prettier, with a blame-ignore file

**Held until the verdict (operator).** One commit from `make format`'s whole-tree form, then a second adding `.git-blame-ignore-revs` with that commit's hash and the DEV_SETUP line for `git config blame.ignoreRevsFile`. The tree was 52% unformatted when measured. Pre-commit holds changed files to it already, so this is one mechanical diff. Proof: `make format-all-check` flips from informational to a CI step in the same PR, golden MATCH. Size is the exception to the 500-line rule because the diff is generated; the PR says so.

### E2. Money-path test plan (D-05)

Tests only, no production change, so that E4 onward can show behaviour held. `tests/characterisation/` already pins sizing and the lot floor, halt flatten, fill simulation, the daily-bias flag and the day-reset timezone. Still at 0 tests, in order of risk:

| Module | What to pin |
|---|---|
| `patterns/evaluate.ts` (304 lines, complexity 39) | one fixture per pattern family, from the pinned slice |
| `algorithm/structural-sl.ts`, `algorithm/stagnant-exit.ts` | the exit reasons and the levels they set |
| `constants/markets.ts` | `riskToLots`, `pnlInUsd`, `clampLotsToConstraints` |
| `market-data/prices.ts` | the fallback order; D-31's failed-call path, as behaviour, without deciding it |
| `market-data/twelve-data.ts`, `brokers/metaapi.ts`, `utils/pnl.ts` | response parsing and error shapes, from recorded responses |

Also: `vitest` coverage reported, not gated, for `src/lib/{scan,market-data,algorithm,constants}` (DEBT §4); typed builders for the 73 `asFixture` call sites (D-05 ledger, target 2027-01-31). A known defect becomes a `fails: true` test pointing at its DEBT id, never a skip. Proof: tests pass against unchanged code.

### E3. Dead code remainder (D-10)

The 22 dead files went in B8. Left because they sit inside audit-cited files: 89 unused `src/lib` exports (measured in Phase A; that scan's output was not committed, so the first PR re-runs it and commits the list to `docs/decisions/evidence/`), the two dead P&L formulas in `utils/pnl.ts:161-178,269-278`, `getTradeStats`, and nine comments that still cite `backtest-engine.ts` or `dual-run-validator.ts`. One PR per directory. Proof: `make check`, golden MATCH, and a repeat of the reachability scan showing the count fall.

### E4. Rename map (D-12), names first

`CODE_QUALITY.md` §1.2 and §1.3 are the map: 81 file and module rows, 43 exported type and function rows. It is written; none of it is applied. Order, so each PR is one idea:

1. Exported types and functions whose names lie about what they do: verbs that hide I/O (`checkNewsVeto` fetches, `evaluateAndPrune` writes, `computeLiveMarketState` persists), then `check*` returning objects.
2. The glossary: `symbol` outside `src/lib/brokers/` to `ticker` (265 sites), the 22 `Algo*` types, one spelling of British or American.
3. Files, directory by directory, with no content change: `scan/` to the engine's real shape, `algorithm/` to gates, the four backtesters out of `market-data/`, the auto-pause out of `cohort/`. `CODE_QUALITY.md` §2.1 has the target tree.
4. The 18 type-only import cycles go with the moves that dissolve them (§2.4).

Each PR updates `.claude/hooks/live-paths.txt` and decision 0006's list in the same commit, or the fence silently stops covering the moved file; `make fence-check` gains a test that every glob matches at least one file. Proof: golden MATCH and `make check`. `docs/CODE_QUALITY.md` and `docs/DEBT.md` line citations go stale here by design, and the PR updates the ones it touches.

### E5. Duplication clusters (D-11)

The byte-identical groups only: `fmtPrice`, `PriceBarLike`, both `TOOLTIP_STYLE` variants, `closesUpTo`, `meanOf`/`stdOf`/`sharpeFromR` into `algo-search/r-stats.ts`, `intervalMinutes`, `EVENT_ICONS`, `fmtCurrency` 2 of 4, `formatDuration` 2 of 3, `ScanResultsList`, `pnlState`, `LoadingStrip`, `isoToUnixSeconds`, `isPriceIndicator`, `AlgorithmWithWatchlist`, `mulberry32`, the row types. Inline fragments after that: the pagination tail, the admin-route preamble, route catch blocks. **Not merges:** `StatCard`, the `fmtCurrency` null-guard and `abs` variants, `holdDuration`, `SaveButton`, the R-multiple variant, three Sharpe formulas and four ATR helpers differ in behaviour, so choosing one is a Part 2 decision, and a new `CONVENTIONS.md` records the one money formatter (operator, 2026-10-29). Proof: jscpd's count falls from 167 clones, golden MATCH.

### E6. Type escapes (D-15)

`string`-typed `event_type`, `exit_reason` and `reason` fields become the unions, 38 sites, once placeholder P1 below says which union; `checkExitTrigger(): string | null` with them. Independent of P1: the 13 ad-hoc `AlgoRow` projections into one row type, the four private `SupabaseClient<any,any,any>` aliases removed, `rulesFromRow` from a bare cast to a parse in the shape it already has (the parse that can reject a row is a behaviour change, so it waits for P5). 24 `as unknown as`, 7 `as never` and 13 `any` come down through those. Then TypeScript's `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, one directory at a time (DEBT §4). Proof: `make typecheck` stricter, golden MATCH.

### E7. Config consolidation (D-09)

`src/lib/env.ts` exists and nothing imports it. One validated config at the composition root, read once at startup: 19 env names at 40 sites, plus 8 missing from `.env.example`'s `src/` set if any remain. Design: a Zod schema over `process.env`, `server` and `public` parts, imported by route handlers and the scan composition root, never by leaf modules, which take values as arguments. Constants next: leverage `?? 30` at 8 sites against `defaultLeverage()`, the two premium-zone thresholds, the timeframe maps. **High priority within Phase E (operator, 2026-10-28)** because a missing `OPERATOR_USER_ID` today means scan and manage run all users' rows; making that fail closed is a startup-behaviour change, so it ships as its own PR with its own proof, not inside the move.

### E8. Complexity hotspots (D-13)

182 functions over cyclomatic 10, 39 at 20 or more. The 19 files over 400 lines in `CODE_QUALITY.md` §2.2 each have a split proposal. In order: `scan/helpers.ts calculatePositionSize` (30), `prop-firm-backtest.ts closeSimPosition` (29), `market-state.ts computeMarketState4h` (39), `patterns/evaluate.ts evaluateIctSmcPattern` (39), then `portfolio-backtest.ts`'s `tryOpenEntry` (59) and `runPortfolioBacktest` (50). Each extraction is a pure move behind E2's tests. Proof: golden MATCH, the ESLint warning budget falls by what the split removed.

### E9. Datetimes (D-14), the mechanical half

Injectable clocks in the halts, so day-boundary tests stop needing fake timers; `parseBarDate` (`market-data/parse-bar-date.ts`) at the four bare `new Date()` sites (`inspect-backtest`, `loser-analysis`, `walk-forward.ts:130`, `position-chart-actions.ts:87`), which is behaviour-preserving on a UTC host and is tested as such; `analytics.ts:242,287` and the `toLocaleString` server components to explicit UTC. **Not here:** which instant a trading day starts at. Every boundary is UTC midnight while FTMO uses 00:00 CE(S)T, and moving it changes halts, so that is placeholder P6.

### E10. Research folder (D-20)

`scripts/canonical` is 62 flat scripts. Target from `CODE_QUALITY.md`: `scripts/{ops,feed,research,reporting}/`, with `deploy-*`, `snapshot-*` and broker scripts leaving the research tree first because they touch production. The four helper copies move to `scripts/canonical/lib/`. Nine decision-feeding scripts are already under ESLint; the 33 that remain come under it or go to `scripts/archive/` by 2027-01-31. The three `verify-*` checks become vitest tests. **Which scripts are superseded is placeholder P7.** Proof: the golden replay and `make regime-report` run from the new paths; every cron wrapper's path updated in the same PR, with the fence.

### E11. Repository hygiene (D-17)

266 tracked run artifacts under `scripts/archive/2026-06-18/`: move out of git or keep with a README saying why, the operator's call on size. About 100 MB of pinned JSON stays in git by policy; a note on LFS cost and benefit, no migration unless the operator asks. Stale references: `ROADMAP.md:315`, `docs/PROJECT_CONTEXT.md:215`, and the `scripts/README.md:352-368` host details (D-18).

### E12. Next.js 16 checklist

Read from the bundled guide (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`) and checked against the repo on 2026-11-06, Next 16.2.4:

| Change | State here |
|---|---|
| `middleware` renamed `proxy`; the edge runtime is not supported in `proxy` | **Outstanding.** `middleware.ts` still uses the deprecated name. Rename with its function, confirm it needs no edge runtime, and update the three-places note in `CLAUDE.md` |
| Async `cookies`, `headers`, `draftMode`, `params`, `searchParams` | Done: no synchronous use found |
| Async `id` and params on image and sitemap routes | Not applicable: none exist |
| `next/image` defaults, `next/legacy/image`, `images.domains` | Not applicable: `next/image` is not used |
| Parallel routes need `default.js` | Not applicable: none exist |
| Turbopack by default; `next.config.ts` keys | `next.config.ts` has no `webpack`, `experimental` or `images` keys; `next build` already runs it |
| `next lint` removed, flat config | Done: `eslint` directly, flat config |
| AMP, runtime config, `devIndicators` options, `unstable_rootParams`, `experimental.dynamicIO` | Not used |
| `revalidateTag` second argument, `updateTag`, `refresh` | Not used |
| Concurrent `dev` and `build`; `.next/dev` | No action |

`proxy.ts` is the only code change, and it is a rename on the auth path, so it follows E4's rules and gets a sign-in check on the host. Audit citations: `review/05-frontend.md` names `middleware.ts`.

### E13. Hook gaps and the sandbox (D-22) — not blocked by the verdict

No audited file moves here, so this can land at any time, target 2026-12-31. Enable Claude Code's sandbox with reads of `.env*` denied, proved by a canary file in `tests/hooks/`. In `hook-input.cjs`, join backslash-newline continuations before the guard's line loop, with a hook case for each rule. Then the false positive on `find src/app -type d -name '@*'`, refused 2026-11-06. Until then the guards stay the explained stop and the deny rules the hard stop for file tools.

## Part 2. Waits for audit Phase 2

Each of these needs the audit's numbers or verdict. **Waits for audit Phase 2** is the status of every entry; the second column says what writing it now would be guessing.

| # | Item | Debt | Guesswork without the audit |
|---|---|---|---|
| P1 | Which contract is canonical for exit reasons and activity events | D-01 | Three versions exist; the choice depends on what the engine has actually written and what the audit's measurements read. Migration 00053 on draft #291 is part of this |
| P2 | One implementation of the rules: is live or the backtester the reference for sizing, fills and halts | D-02 | The parity numbers decide. Choosing first would pick which results stay valid |
| P3 | Which logged errors become raised errors on the money path | D-04 | Raising changes what trades happen on a bad tick; the audit says which failures matter |
| P4 | Lot quantisation, and whether the $10K floor is a bug or a rule | D-08 | The epsilon fix changes trades, and the audit's G.8 baseline finding turns on this floor |
| P5 | Delete, fence or fix the self-modifying and dormant paths | D-06, D-07 | Depends on the verdict on the five algorithms and on the LLM path |
| P6 | The trading-day boundary | D-14 | FTMO's 00:00 CE(S)T against UTC changes halts and day attribution, so it changes results |
| P7 | Which research scripts are superseded | D-20 | Depends on which verdicts survive the look-ahead fix; 31 are provisionally superseded |
| P8 | What the golden file should pin | Golden rule | Today it pins current behaviour, not correct behaviour. Each of P1 to P6 regenerates it on purpose |
| P9 | The bar path on a failed OANDA call | D-31 | Whether the unfiltered fallback bars change results is the audit's fill finding; the fix follows the measurement |
| P10 | The news veto | D-32 | A working calendar or the rule off: either changes live behaviour against a baseline that never applied it |
| P11 | The fenced half of a failed broker close | D-25 | Keeping the paper row open changes what analytics count |
| P12 | Roadmap sequencing after Phase E | `scripts/canonical/ROADMAP.md` | Depends on the verdict itself |

## Before any algorithm gets `live_trading_enabled=true`

Not Phase E work as such, but a gate it must not pass over: D-25's engine half, D-26 orphan adoption, D-29 the session-started dashboard, D-33 the script that turns mirroring on, and P10.
