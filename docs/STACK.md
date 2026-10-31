# STACK — what this repository is, how it runs, and what state the tooling is in

Written 2026-10-28 on branch `tooling/dev-setup` (off `dev` @ `3ee22e2`). Read-only inventory; every number below was measured on that commit with the command shown. Nothing here was fixed — fixes are planned in `DEBT.md`.

**One-line summary.** A single-operator Next.js 16 / TypeScript monolith that hosts the trading engine as HTTP routes, driven by a server crontab on a Hetzner VPS, persisting to Supabase Postgres, with a research harness in `scripts/` and a 268-line Python sidecar. There is no Python engine, no separate backend process, no CI that runs tests, no branch protection, and `main` has never moved past the scaffold commit.

---

## 1. Languages, runtimes, package managers

| Item | Fact | Evidence |
|---|---|---|
| Primary language | TypeScript 5 (`strict: true`) — 627 `.ts` + 165 `.tsx` tracked files; ~104k lines in `src/` (71k in `src/lib`) + 46k lines in `scripts/` | `git ls-files`, `tsconfig.json:8`, `wc -l` |
| Runtime | Node.js. **No version pin anywhere**: no `.nvmrc`, no `engines` in `package.json`. Local `v25.3.0`; VPS `v25.9.0` via nvm (`scripts/README.md:356`); `@types/node` is `^20` | `package.json`, `ls -a` |
| Package manager | pnpm `11.7.0` local; `pnpm-lock.yaml` **committed** (lockfileVersion 9.0, 252 KB); deploy uses `--frozen-lockfile` | `pnpm-lock.yaml:1`, `scripts/README.md:368` |
| Python | Sidecar only: `scripts/python/{bayesian_optimization,feature_importance}.py` (268 lines), spawned as a child process from three research scripts (`scripts/canonical/feature-importance.ts:59-63`, `bo-search.ts:84-86`, `label-reengineering.ts:70-72`). `requirements.txt` has loose `>=` pins and **no lockfile**; venv gitignored. Local interpreter 3.14.2. Not on any production path. | `scripts/python/requirements.txt` |
| Shell | 17 bash cron wrappers in `scripts/*.sh`; each greps `CRON_SECRET` out of `.env.local` and curls a route | `scripts/scan-cron.sh:22-40` |
| SQL | 52 hand-applied Supabase migrations `supabase/migrations/00001…00052` | `ls supabase/migrations` |

## 2. Framework and major dependencies (`package.json`)

Next.js 16.2.4 (App Router, `src/`), React 19.2.4, Supabase (`@supabase/ssr` 0.10, `supabase-js` 2.104), TanStack Query 5, Zustand 5, Zod 4, Tailwind 4 + shadcn/ui base-nova (Base UI, **not Radix**), lucide-react, Recharts 3 **and** klinecharts 9.8 **and** lightweight-charts 4 (three charting libraries), `@anthropic-ai/sdk` 0.92 (dormant LLM-trader), `groq-sdk` 1.1, `protobufjs` 8 (dormant cTrader), PapaParse. Dev: Vitest 4.1.5, ESLint 9 + `eslint-config-next` + `eslint-plugin-import-x`, Prettier 3.8, TypeScript 5. `knip`/`depcheck` flag `long` and `@vitest/expect` as unused (verify before removal — see `DEBT.md`).

## 3. How the engine runs

There is **no engine process**. The engine is a set of Next.js route handlers that run only when something calls them:

```
cron (every 15 min) ─curl─▶ GET /api/cron/scan-active-algorithms   src/app/api/cron/scan-active-algorithms/route.ts
cron (every 5 min)  ─curl─▶ GET /api/cron/manage-positions          src/app/api/cron/manage-positions/route.ts
cron (every 5 min)  ─curl─▶ GET /api/cron/heartbeat
cron (6-hourly)     ─curl─▶ GET /api/cron/alpha-decay, /api/cron/reconcile-broker-positions (*/30), …
```

- Auth on every cron/admin route: `Bearer $CRON_SECRET` checked by `verifyAdminAuth` (`src/lib/api/admin-auth.ts`).
- The scan route loads `status='active'` algorithms scoped to `OPERATOR_USER_ID` (`route.ts:108-115`), runs the portfolio daily-loss halt (`:163`), then `scanAlgorithm` per algorithm (`src/lib/scan/engine.ts:65`) → `processTicker` (`src/lib/scan/engine-process-ticker.ts:41`) → manage open positions → `evaluateEntry` (`src/lib/scan/entry.ts:89`) → gate ladder (`entry-deterministic-gates.ts:67`) → conditions → `openPosition` (`entry-open.ts`).
- The manage route runs `manageActiveAlgorithms` (`src/lib/scan/manage.ts:187`) → `manageExistingPosition` (`engine-position-mgmt.ts:65`): stagnant-exit check first, then SL/TP on a polled quote.
- Locally: `pnpm dev` (port 3000) then `./scripts/scan-cron.sh`. Research/ops scripts: `pnpm dlx tsx scripts/canonical/<name>.ts` with env-var knobs (161 distinct `process.env` names across non-archived scripts; `scripts/README.md` documents ~20 of them).
- The full flows (actual order of operations, side effects, where prices come from) are drawn in `CODE_QUALITY.md` §3.

## 4. Production host (verified read-only on the VPS, 2026-10-28)

| Item | Fact |
|---|---|
| Host | Hetzner Cloud VPS `quanttrader-prod`, Ubuntu 26.04 LTS, up 62 days on 2026-10-28. IP/SSH details are in the operator's private ops note and `~/.ssh/config` (`Host qt`, user `ops`), not in the repo. Since 2026-10-29 SSH login is only as `ops` (key, sudo); root SSH is disabled |
| Process | `/etc/systemd/system/quanttrader.service`: `WorkingDirectory=/opt/quanttrader`, `ExecStart=…/node/v25.9.0/bin/pnpm start`, `Restart=always`, `RestartSec=5`, PATH pinned to nvm's `v25.9.0`; **runs as root**; no `EnvironmentFile` — Next.js loads `/opt/quanttrader/.env.local` (0600 root, 14 variable names) itself. Active since the 2026-10-19 redeploy. The unit is **not in the repo** (Phase D) |
| Scheduler | root crontab, 10 entries, UTC: scan `*/15`, manage `*/5`, heartbeat `*/5`, oanda-positioning `*/20`, prune `0 4`, cohort-report `0 23 * * 0`, alpha-decay `10 */6`, broker-health `0 */6`, reconcile `*/30`, m1-band-check `30 21`. **Not installed:** walk-forward-opt, quarterly-research-cycle, validate-algo-monthly, prereg-expiration, broker-spread-sampler. Logs `/var/log/quanttrader/*.log`. The crontab is **not in the repo** |
| Deploy | no deploy script on the host; the README one-liner (`ssh qt`, then `sudo -i` for `cd /opt/quanttrader && git pull && … && pnpm build && systemctl restart quanttrader`) pulls **`dev`** over a read-only SSH deploy key. Checkout verified at `dev @ 3ee22e2`, clean |
| Secrets | `/opt/quanttrader/.env.local` is the only holder of `CRON_SECRET` on the host; wrappers grep it per run. Rotated 2026-10-29. Rotation runbook: `docs/runbooks/rotate-cron-secret.md` |
| Network | ufw active, default deny incoming; `22/tcp` rate-limited (`ufw limit`) from anywhere; anything on `tailscale0`. Next binds `*:3000` (all interfaces) — only ufw keeps it off the internet. sshd since 2026-10-29: `PermitRootLogin no`, `PasswordAuthentication no`, `AllowUsers ops`, `MaxAuthTries 3`, `X11Forwarding no`; one authorized key (the same key for `ops`); fail2ban active (sshd jail, 4 tries / 10 min → 1 h ban); unattended-upgrades active. Hetzner Cloud firewall: not configured (console only). Runbook: `docs/runbooks/harden-vps-ssh.md` |
| UI access | Tailscale (`quanttrader-prod:3000`) or `ssh -L 3000:localhost:3000 qt` |
| Mac stack | disabled 2026-08-27; `scripts/launchd/com.huffed.quanttrader.caffeinate.plist` is the only launchd file in the repo |
| Inventory 2026-10-30 (read-only, Phase D step 0) | checkout still at `dev @ 3ee22e2` (2026-10-19), `node_modules` installed 2026-08-27, build from 2026-10-19; a reboot has been pending since unattended-upgrades last ran (`Automatic-Reboot` not configured); no logrotate rule for `/var/log/quanttrader` (scan.log 8 MB); no backups on the host; only Node v25.9.0 installed, for root; SSH now `ops`-only, root still runs the service, the crontab and the deploy. Full table and the plan: `docs/PHASE_D_PLAN.md` |

## 5. Data stores

| Store | Fact | Evidence |
|---|---|---|
| Supabase Postgres (Pro tier since 2026-10-19) | 15+ tables incl. `algorithms` (1,059 rows: 1,024 `draft` search candidates, 5 `active`), `paper_positions`, `activity_log` (CHECK-constrained `event_type`), `price_cache` (JSONB bars per ticker/interval, capped at 2,000 bars on write since E2.34), `llm_decisions`, `broker_connections` (RLS; stores broker API tokens), `portfolios`, `strategies` | audit `review/00-project-map.md`; `src/lib/market-data/price-cache.ts` |
| Migrations | 52 SQL files applied **by hand** (Supabase MCP `apply_migration` or SQL editor). No ledger of what is applied where; no migration tool. The latest CHECK migration the code needs (00053, widening `exit_reason`/`event_type`) exists only on draft PR #291 | `supabase/migrations/`, `README.md:44` |
| Generated DB types | `src/lib/supabase/database.types.ts` last regenerated **2026-06-23** (`9f59f06`); migrations 00044–00052 landed after it (last 2026-10-05). The TS view of the schema is nine migrations stale | `git log -1 -- src/lib/supabase/database.types.ts` |
| Pinned market data | `scripts/canonical/data/*-pinned.json` — 18 files (4 instruments × D/H4/H1/M30), ~100 MB tracked, each with an embedded sha256 re-hashed on load; gold pins end 2026-07-09/17 | `ls -la scripts/canonical/data` |
| Tick corpus | `scripts/canonical/data/ticks/` gitignored (~79 M ticks), manifest committed | `.gitignore:111` |
| Research artifacts | `scripts/archive/2026-06-18/` holds 266 tracked `.json/.jsonl/.log` run outputs; `scripts/canonical/e2-results/` 29 more | `git ls-files` |
| Client caches | In-process: `price_cache` row copy (10-min TTL), `prices.ts` 1-h memory cache, memoised Supabase admin client | `src/lib/market-data/price-cache.ts`, `prices.ts`, `src/lib/supabase/admin.ts:13` |

## 6. External services

| Service | Used for | Env var | Notes |
|---|---|---|---|
| OANDA practice REST | bars (head of the fallback chain); positionBook snapshots | `OANDA_API_KEY`, `OANDA_API_HOST` (undocumented) | `src/lib/market-data/oanda.ts` |
| Twelve Data | **live quotes for paper fills and SL/TP checks** (`fetchBatchQuotes`); bar fallback | `TWELVE_DATA_API_KEY` | 800 credits/day; HTTP-200 error bodies unchecked (audit F1) |
| Yahoo Finance (unauthenticated) | bar fallback (refuses 4h) | — | |
| Alpha Vantage | last-resort bars; news sentiment | `ALPHA_VANTAGE_API_KEY` | 25 req/day |
| Finnhub | economic calendar for the news veto (fails open) | `FINNHUB_API_KEY` | |
| MetaApi (MT5) | broker mirroring, spreads, reconcile — currently off (`live_trading_enabled=false` ×5) | token in `broker_connections` rows | `src/lib/brokers/metaapi*.ts` |
| cTrader Open API | dormant by design | `CTRADER_CLIENT_ID/SECRET` (undocumented) | `src/lib/brokers/ctrader*` |
| Anthropic (Haiku 4.5) | dormant LLM-trader path | `ANTHROPIC_API_KEY` | no spend cap on the live path (audit F7) |
| Groq (Llama 3.3) | LLM fallback; journal analysis; sentiment | `GROQ_API_KEY` | |
| ntfy.sh | phone push from dead-man + M1 band check | GitHub secrets `NTFY_TOPIC`/`NTFY_TOKEN`; `.env.local` on VPS | delivery never confirmed end-to-end (audit F6) |
| GitHub Actions | dead-man monitor only (see §9) | repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY` | |
| Tailscale | operator access to the VPS UI | — | |

## 7. Secrets — where they live and what the scan found

- **Local:** `.env.local` (gitignored by `.env*` + `!.env.example`, `.gitignore:40-41`). Twelve documented names in `.env.example`; **eight names read by `src/` are not in `.env.example`** (`CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, `ENABLE_AXES_2026_10`, `ENABLE_FOREX_SEARCH`, `OANDA_API_HOST`, `PORTFOLIO_BACKTEST_FALLBACK_WARN`, `ROBUSTNESS_AUDIT_DIR`, `NODE_ENV`) and `src/lib/env.ts`, the typed accessor module, is **imported by nothing** (`grep -rn "lib/env" src scripts` → none).
- **VPS:** `/opt/quanttrader/.env.local`. **GitHub:** four repo secrets (above). **Supabase MCP:** `.mcp.json` (gitignored) carries the project ref only.
- **Git history scan (requested):** `git log --all --name-only -- '.env*'` → only `.env.example` was ever committed (10 commits, 2026-04-20 → 2026-07-20). A regex sweep of every historical diff (`git log -p --all`) for Anthropic/Groq/AWS/GitHub/Slack key shapes, JWTs and private-key blocks: **no hits**. `git grep` over tracked files for `apikey=`, `Bearer …`, `token=`: **no hits**. The two personal CSV exports at the repo root are gitignored and were never committed. `gitleaks`/`trufflehog` are not installed; the sweep above is regex-based (see §11).
- **Finding — rotate:** `.claude/settings.local.json` (gitignored, local only) contains a Bash allow-rule with a literal 64-hex bearer token that matches the `CRON_SECRET` shape (`curl -s -H "Authorization: Bearer 6f7d…" http://localhost:3000/api/admin/walk-forward…`). It never reached git, but it sits in plaintext in a config file that Claude Code reads on every session. Rotate `CRON_SECRET` (local + VPS `.env.local`) and delete the rule. A second allow-rule greps `TWELVE_DATA_API_KEY` out of `.env.local` at run time (no value stored).
- **Finding — public disclosure, not a secret:** the repository is **PUBLIC** (`gh repo view` → `visibility: PUBLIC`) and `scripts/README.md:352-368` publishes the VPS public IP, the Tailscale IP and a root SSH one-liner. SSH is key-only, so this is an information leak rather than a credential leak; still, it belongs in a private ops note, not a public README (Phase B item). `scripts/canonical/ROADMAP.md:1264` repeats the IP.

## 8. Tests, lint, format, types, build — measured state

| Check | Command | Result on `3ee22e2` |
|---|---|---|
| Unit tests | `pnpm test` (`vitest run`) | **133 files, 1,918 tests, all pass, 49.7 s** wall. Only `src/**/*.test.ts` (`vitest.config.ts:7`): `scripts/` has **zero** tests; no `.test.tsx`, no DOM environment, so **0 component/hook/server-action tests**. 128 of 242 backend source files have no sibling test (`metrics/untested-files.txt`) |
| Type check | `pnpm exec tsc --noEmit` | **155 errors in 25 files — all `*.test.ts`** (worst: `src/lib/scan/readiness-check.test.ts` 24, `entry-deterministic-gates.test.ts` 15). Vitest does not type-check and `next build` skips test files, so these have been invisible. Excluding tests: **0 errors** on 566 files in 8 s |
| Build | `pnpm build` | passes; 39 s wall; runs TypeScript (15.7 s) on non-test files |
| Lint | `pnpm lint` (`eslint`) | **0 errors, 117 warnings** in 76 files: 70 `import-x/order`, 18 `no-nested-ternary`, 15 `max-lines-per-function`, 12 `max-lines`, 2 `curly`. `scripts/**` is **globally ignored** (`eslint.config.mjs:112`) — 46k lines never linted; `database.types.ts` ignored |
| Format | `pnpm format:check` (prettier on `src/**/*.{ts,tsx}`) | **323 of 626 files (52 %) fail** — the config exists, nothing enforces it; `scripts/` not covered |
| Import cycles | `madge --circular src` | **18 cycles**, 10 inside `src/lib/scan` (`entry.ts` ↔ `entry-deterministic-gates.ts`; `entry.ts` → `entry-llm-*` → back), 4 in `app/(dashboard)/chart`, 3 in `lib/algorithm/combinatorial-search`, 1 in `components/algorithms/position-chart-*`. ESLint's `import-x/no-cycle` is set to `error` yet reports none — its TS resolver treats type-only edges as severed, so the runtime cycles above are either type-only or unseen (see `CODE_QUALITY.md` §7) |
| Duplication | `jscpd --min-tokens 50` on `src` + `scripts` (non-archive) | **396 clones, 5,053 duplicated lines (5.96 %), 7.7 % of tokens**; `src` alone ≈ 4–5 % |
| Dead code | import-graph reachability (`metrics/reachability.mjs`) + `knip` | **24 `src` files (≈3,000 lines) reachable from no page, route, action, script or middleware**; 16 more reachable only from `scripts/`; knip: 141 unused exports + 84 unused types; details in `DEBT.md` |
| Complexity (ad-hoc eslint run) | `complexity ≥ 10` | 182 functions in `src` (39 with complexity ≥ 20; `portfolio-backtest.ts tryOpenEntry` = 59, `runPortfolioBacktest` = 50; `scan/helpers.ts calculatePositionSize` = 30), 77 in `scripts/canonical` (`validate-algo.ts main` = 82) |
| Git hooks | — | none (no husky, lint-staged, `core.hooksPath`) |

## 9. CI, automation, branches

- **Workflows:** `.github/workflows/dead-man.yml` (every 30 min: three Supabase RPC freshness checks + MetaApi probe + ntfy push) and `ftmo-gate-reminder.yml` (a one-shot for 2026-07-11 whose header says to delete it). **No workflow runs tests, lint, type-check or build on any push or PR.**
- **Branch protection:** none on `dev` (`gh api …/branches/dev/protection` → 404 "Branch not protected"); no rulesets. `main` is the "Initial commit from Create Next App" (2026-04-20) and is **763 commits behind `dev`**; GitHub's default branch is `dev`.
- **Merge discipline:** on `dev` first-parent history, 47 PR merges vs **366 direct commits** all-time; since 2026-06-19, 4 PR merges vs **109 direct commits**. The CLAUDE.md "feature branch → PR → dev" workflow is not what happens.
- **Open PRs:** #291 (draft, audit safety fix, do not merge yet).
- **Implication for this work:** `tooling/dev-setup` was branched from `dev`, not `main` as the brief says, because `main` contains no project code. Protecting `main` would protect nothing; the check-in proposes either protecting `dev` or fast-forwarding `main` and switching the default (see the Phase A check-in).

## 10. Documentation inventory and drift

| Doc | Status |
|---|---|
| `CLAUDE.md` (41 KB) | Authoritative in intent, stale in fact: says cron runs on the operator's Mac (§"Cron / live trading"), "Coil-1h + Dip-Buyer are LIVE", 4-algo portfolio at 0.58 % (it is 5 at 0.42 %), `preregistration.json` is `{}` (it has 6 entries), latest migration 00049 (it is 00052), consistency rule 40 % (deployed rows use 0), `LLM_MONTHLY_BUDGET_USD` is enforced (only in an archived script) |
| `README.md` | Describes a product that no longer exists: "AI-powered autopilot", onboarding wizard (deleted PR #269), Twelve Data as primary bars, Mac cron |
| `scripts/README.md` | Opens with "Production cron runs on the operator's local macOS machine" and ends with "PRODUCTION HOST: VPS — the Mac stack is DISABLED"; its cron table lists three jobs that are not installed; a Mac-launchd runbook sits between them |
| `scripts/canonical/ROADMAP.md` (1,282 lines) | The active plan and lineage log; the only document that tracks reality, but it is a journal, not a reference |
| `docs/*.md` (3 files, April 2026) | Proposals that predate the current system; historical |
| `AGENTS.md` | One paragraph pointing at `node_modules/next/dist/docs` |
| `review/` on branch `review/skeptical-audit-2026-10` | The audit's own documents (not on `dev`) |

## 11. What this inventory did not do

- The VPS was inspected read-only on 2026-10-28 (scope: host, unit, crontab, checkout, env var **names**, sshd, ufw); §4 reflects it. Not inspected: the Hetzner Cloud firewall, journald retention, the deploy key's GitHub permissions.
- Did not run `gitleaks`/`trufflehog` (not installed); the secrets sweep is a regex over full history + tracked files, which misses unusual key formats.
- Did not open `.env.local` or `.mcp.json` values; did not query Supabase or any provider.
- Did not measure test coverage (no `@vitest/coverage-*` installed); "untested" means "no sibling test file".
- Did not run the Python sidecar.
