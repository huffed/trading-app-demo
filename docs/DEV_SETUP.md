# DEV_SETUP — the tooling around the code

One short section per thing that was set up: **what it is, why it exists, the one command to use it.** Kept current in the same PR as the thing it describes. Sections are added as the Phase B PRs land; the command cheat-sheet in §1 is the only part you need day to day.

## 1. Cheat-sheet

| I want to… | Command | Added in |
|---|---|---|
| see every check | `make help` | B3 |
| run everything CI runs | `make check` (lint + lint-shell + typecheck + test) | B3 |
| lint / type-check / test | `make lint` · `make typecheck` · `make test` | B3 |
| format what I changed | `make format` (then `make format-check`) | B3 |
| hold a new file to the target rules | `make lint-strict FILES=path/to/new-file.ts` | B3 |
| set up the Python sidecar | `make python-env` | B2/B3 |
| rotate the cron secret | `docs/runbooks/rotate-cron-secret.md` (manual, ~5 min) | B1 |
| harden the VPS (**Critical**: password auth is on) | `docs/runbooks/harden-vps-ssh.md` (manual, ~10 min today) | B1 |

Stubs that exit 2 with a message until their PR lands: `make backtest` (golden file, B10), `make validate` / `make parity` (audit scripts, when they reach `dev`), `make db-types` / `make db-types-check` (B7).

## 2. Secrets — where they live and the rules

- **Local:** `.env.local` at the repo root (gitignored by `.env*`). Never committed, never read by tooling or by Claude Code sessions; only the cron wrappers grep single names out of it.
- **VPS:** `/opt/quanttrader/.env.local` (0600, root). The app loads it at start; a restart is required after any change.
- **GitHub Actions:** repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NTFY_TOPIC`, `NTFY_TOKEN` (dead-man workflow only; CI needs none).
- **`.env.example` is the index:** every variable the code reads appears there by name with a one-line purpose, values never. Adding a `process.env.X` read means adding `X` to `.env.example` in the same PR (a CI check for this arrives with the CI PR).
- **Rotation:** `docs/runbooks/rotate-cron-secret.md`. Rotate `CRON_SECRET` now — the 2026-10-28 inventory found its value in a local Claude Code allow-rule (deleted the same day; it was never committed: `git log --all -- .claude/settings.local.json` is empty).
- **Public repo = constraint.** Nothing host-identifying (IPs, user names, SSH lines) goes into the repo; use the `qt` SSH alias and a private ops note.

## 3. GitHub secret scanning and push protection (what to click)

The repo is public, so both are free. They catch a committed token at push time (push protection blocks the push) and in history (scanning alerts).

1. Repo → **Settings** → **Code security** (older UI: "Code security and analysis").
2. **Secret scanning** → **Enable**.
3. Under it, **Push protection** → **Enable**.
4. Optional: **Validity checks** → Enable (GitHub checks whether a found token is live).

Same thing from the CLI (you run it; it changes repo settings):

```bash
gh api -X PATCH repos/huffed/trading-app-demo \
  --input - <<'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
gh api repos/huffed/trading-app-demo --jq '.security_and_analysis'   # verify
```

Local equivalent (so a secret never reaches GitHub in the first place): `gitleaks` in pre-commit and CI — added by the pre-commit and CI PRs.

## 4. Runbooks

`docs/runbooks/` holds operator procedures with exact commands and a verification checklist each. Current: `rotate-cron-secret.md`, `harden-vps-ssh.md` (**Critical**). Phase D adds deploy, kill-switch, backup/restore.

## 5. Environments — Node, pnpm, Python

**What:** `.nvmrc` pins Node `25.9.0` (what the VPS runs under systemd); `package.json` `engines` says `node >=25.9.0 <26`, `pnpm >=10`; `pnpm-lock.yaml` is committed and installs use `--frozen-lockfile` (local, CI, VPS). The Python research sidecar is pinned by `scripts/python/pyproject.toml` + `uv.lock` (`requires-python >=3.11,<3.14`; `requirements.txt` is exported from the lock for pip users).

**Why:** three different Node versions were in play (local 25.3, VPS 25.9, `@types/node` 20) and the sidecar had loose `>=` pins with no lock, so "works on my machine" was the only guarantee. Node 25 is not an LTS line; moving production to the current LTS is a Phase D decision, not a tooling one.

**Commands:**

```bash
nvm use                                  # reads .nvmrc
pnpm install --frozen-lockfile           # never `pnpm install` without the flag on the VPS or in CI
uv sync --project scripts/python         # creates scripts/python/.venv (the TS drivers auto-detect it)
make python-lock                         # after editing pyproject.toml: uv lock + requirements.txt export (target lands with the Makefile PR)
```

## 6. One entry point per check — the Makefile

**What:** `Makefile` at the root; `make help` lists every target with a one-line description. Each target exits non-zero on failure, so the same command works in a terminal, in pre-commit and in CI. `make check` is the local equivalent of CI.

**Why:** before this, "run the checks" meant remembering five pnpm scripts, and nothing ran `scripts/` at all. One name per check also lets CLAUDE.md and the hooks refer to checks without repeating their commands.

**Commands:** see the cheat-sheet (§1). The targets wrap `pnpm exec …`; the pnpm scripts in `package.json` still work (`pnpm lint`, `pnpm typecheck`, `pnpm test`). `BASE=origin/dev` is the comparison point for `format`/`format-check`; override with `make format BASE=main`.

## 7. Lint, types, format — the baseline and the target

**What:**
- **Baseline** (`eslint.config.mjs`, `tsconfig.json`): the rules the code passes today. `make lint` fails on any error and on more warnings than `.eslint-warning-budget` (174 on 2026-10-28: 117 in `src/`, 57 in live-path scripts). The budget is a ratchet: it may only go down, and a PR that lowers it edits the file.
- **Target** (`eslint.config.strict.mjs`): `typescript-eslint` strict + stylistic type-checked rules, `complexity ≤ 10`, 80-line functions, 300-line files, `no-console` (scripts excepted), no `any`, no object-literal casts, explicit module boundary types, no floating promises, no empty catch, ordered acyclic imports. Every **new** file is held to it from its first PR (pre-commit and CI run it on added files); existing files migrate one PR at a time after the audit verdict and never go back. Settings are never loosened.
- **Types:** `make typecheck` runs `tsc --noEmit` over `src/`, `tests/` and `scripts/` **including test files**. It goes green with PR B5 (155 type errors in test files, type-only fixes, assertions unchanged).
- **Format:** Prettier on changed files only (`make format`, pre-commit). The whole-tree format is one dedicated PR after the audit verdict, with its hash in `.git-blame-ignore-revs`. `make format-all-check` shows the current whole-tree state (informational).
- **Shell:** `make lint-shell` = `shellcheck -S error` on the cron wrappers (0 errors today); target is `-S warning` (6 `SC2155` "declare and assign separately" warnings, DEBT.md).

**Why:** CI has to exist today, so it starts at the level the code passes; new code must not add to the debt, so it starts at the target. The two configs make that split explicit instead of a convention nobody checks.

## 8. `scripts/` — what is checked and what is not

**What:** `scripts/dev/checked-scripts.mjs` is the single list. Everything under `scripts/` is **live-path** and checked like `src/` (ESLint baseline, tsc, Prettier) **except** the 42 research one-offs it names (`e2.*`, `verify-*`, `robustness-*`, stress runs, feature/label experiments, search drivers), which ESLint skips. `scripts/archive/` and run caches are never checked. `node scripts/dev/checked-scripts.mjs` prints the live-path file list for tools that cannot import it.

**Why:** 46k lines were excluded from every check, including the deploy scripts, the cron wrappers' TypeScript and the verdict/baseline scripts that produced the live rules. Research scripts are excluded by name, not by directory, so moving nothing (renames wait for the audit) still lets the live-path scripts be checked. Each research script has a target date in `docs/DEBT.md` D-20 (2027-01-31) to be brought under the checks or archived; adding a script to the research list needs a DEBT.md line.
