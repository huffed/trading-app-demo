# QuantTrader — one entry point per check. Every target exits non-zero on failure.
# `make help` lists them. Details and the baseline/target rules: docs/DEV_SETUP.md.
SHELL := /bin/bash
.DEFAULT_GOAL := help
PNPM ?= pnpm
BASE ?= origin/dev

.PHONY: help install lint lint-strict lint-shell typecheck format format-check format-all-check \
        test test-watch build check backtest validate parity db-types db-types-check \
        secrets-scan secrets-scan-history env-check backtest-update lint-workflows python-env python-lock

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "} {printf "  %-18s %s\n", $$1, $$2}'

install: ## Install dependencies exactly as locked
	$(PNPM) install --frozen-lockfile

lint: ## ESLint, baseline rules; fails on any error or on more warnings than .eslint-warning-budget
	$(PNPM) exec eslint . --max-warnings "$$(cat .eslint-warning-budget)"

# lint-strict splits FILES on spaces and passes it NUL-separated: make expands the variable inline,
# and a path with a Next.js route group such as src/app/(dashboard)/… is a bash syntax error unquoted.
lint-strict: ## ESLint target rule set on FILES=... (new code is held to this; CI runs it on files added in a PR)
	@test -n "$(FILES)" || { echo "usage: make lint-strict FILES='path/a.ts path/b.ts'"; exit 2; }
	@printf '%s' "$(FILES)" | tr ' ' '\n' | grep -v '^$$' | tr '\n' '\0' | xargs -0 $(PNPM) exec eslint --config eslint.config.strict.mjs --no-ignore

lint-shell: ## shellcheck on the cron wrappers (baseline: errors; target: warnings, see DEBT.md)
	shellcheck -S error scripts/*.sh

lint-workflows: ## actionlint on .github/workflows (a workflow GitHub cannot parse fails here, not as a run with no jobs)
	@command -v actionlint >/dev/null || { echo "actionlint is not installed (brew install actionlint)"; exit 2; }
	actionlint -no-color

typecheck: ## tsc over src, tests and scripts (test files included)
	$(PNPM) exec tsc --noEmit -p tsconfig.json

# Files this branch adds or changes vs $(BASE): committed, staged, unstaged and untracked.
FORMAT_PATTERNS := '*.ts' '*.tsx' '*.mjs' '*.js' '*.json' '*.css'
define changed_files
{ git diff --name-only --diff-filter=ACMR $(BASE)...HEAD -- $(FORMAT_PATTERNS); \
  git diff --name-only --diff-filter=ACMR HEAD -- $(FORMAT_PATTERNS); \
  git ls-files --others --exclude-standard -- $(FORMAT_PATTERNS); } | sort -u | while read -r f; do [ -f "$$f" ] && echo "$$f"; done
endef

format: ## Prettier --write on files changed vs $(BASE) (whole-tree format is one dedicated PR after the audit verdict)
	@files=$$($(changed_files)); \
	if [ -z "$$files" ]; then echo "format: no changed files vs $(BASE)"; else $(PNPM) exec prettier --write $$files; fi

format-check: ## Prettier --check on files changed vs $(BASE)
	@files=$$($(changed_files)); \
	if [ -z "$$files" ]; then echo "format-check: no changed files vs $(BASE)"; else $(PNPM) exec prettier --check $$files; fi

format-all-check: ## Prettier --check on the whole tree (informational until the format PR lands)
	$(PNPM) exec prettier --check .

test: ## Vitest, once
	$(PNPM) exec vitest run

test-watch: ## Vitest, watch mode
	$(PNPM) exec vitest

build: ## Production build
	$(PNPM) run build

env-check: ## Every env var the app reads is documented by name in .env.example (secret-shaped names in scripts too)
	node scripts/dev/env-names-check.mjs

check: lint lint-shell lint-workflows typecheck env-check db-types-check test ## Everything CI runs, locally

backtest: ## Golden-file replay of the five deployed algorithms on the pinned XAU/USD 4h slice (fails on any changed trade)
	$(PNPM) exec tsx scripts/golden-replay.ts

backtest-update: ## Regenerate the golden file on purpose (commit it with an explanation)
	$(PNPM) exec tsx scripts/golden-replay.ts --update

validate: ## Validation harness (wired to review/scripts when the audit lands them on dev)
	@echo "make validate: not wired yet — the audit's scripts live on review/skeptical-audit-2026-10 (docs/DEBT.md D-20)."; exit 2

parity: ## Live-vs-backtest parity replay (wired to review/scripts/paper-replay.ts when it lands on dev)
	@echo "make parity: not wired yet — review/scripts/paper-replay.ts is on the audit branch (docs/DEBT.md D-02)."; exit 2

db-types: ## Regenerate src/lib/supabase/database.types.ts from the live schema (needs SUPABASE_ACCESS_TOKEN in the shell) and stamp the manifest
	node --env-file=.env.local scripts/dev/db-types.mjs generate

db-types-check: ## Fail if supabase/migrations/ changed since database.types.ts was generated (CI)
	node scripts/dev/db-types.mjs check

secrets-scan: ## gitleaks over the working tree and staged changes (history: make secrets-scan-history)
	gitleaks dir . --no-banner --redact=100
	gitleaks git --pre-commit --staged --no-banner --redact=100

secrets-scan-history: ## gitleaks over the full git history (slow: minutes)
	gitleaks git --no-banner --redact=100

python-env: ## Create scripts/python/.venv from uv.lock
	uv sync --project scripts/python

python-lock: ## Re-resolve the Python sidecar after editing scripts/python/pyproject.toml
	uv lock --project scripts/python
	cd scripts/python && uv export --format requirements-txt --no-hashes --no-emit-project -o requirements.txt
