# 0005 — Deploys run one reviewed script on the host from one command on the workstation; `main` is the production pointer that script moves

**Date:** 2026-10-31 · **Status:** active · **Phase:** D.1.

## Decision

Production is deployed only by `make deploy [REF=…]`. The workstation driver (`scripts/ops/deploy-driver.sh`) copies `scripts/ops/deploy.sh` to the VPS and runs it as root; the host script refuses a dirty tree, fetches, checks out the exact commit detached, requires the host's Node to match the commit's `.nvmrc`, reinstalls from the lockfile, builds, restarts the service between cron ticks, and passes only when `/login` answers 200, the heartbeat route answers 200 with the host's `CRON_SECRET` (read on the host, never printed) and the next scheduled manage and heartbeat ticks log `http=200`. Each run appends to `/var/log/quanttrader/deploys.log`. Only after that verification does the driver move the branch `main` to the deployed commit — fast-forward normally, a leased force-update when the deployed commit is an ancestor (a rollback), no move with a message when it is neither — and append a row to `docs/decisions/deploys.md`, which the next PR commits. The rollback is the same command with `REF=<previous sha>`. The host's unit, crontab, sshd drop-in and firewall are captured in `ops/` and change only through PRs; `ops/**` and `scripts/ops/**` are live-runner paths for the Claude Code hooks.

## Why

Until today the host was deployed by hand as root (`git pull && pnpm build && systemctl restart`), with no record of when, no check that the service came back, and `main` absent from the remote. The audit has to bracket paper-trading results by what was running; the operator asked for a one-command rollback written down before the first deploy; and the brief's bar is "nothing fails silently".

## Alternatives considered

- **CI-driven deploy** (GitHub Actions ssh-ing into the VPS on merge): puts a host-writing key in GitHub secrets, deploys the moment a PR merges, which the standing rule (no VPS change in market hours) forbids, and removes the deliberate weekend step. Rejected for now; revisit if deploy frequency makes the manual step a cost.
- **Pull-based deploy** (a cron on the host polling `dev`): deploys with nobody watching. Rejected for the same reason.
- **Containers / a different host model:** a rewrite, and Phase E material at the earliest.
- **Deleting `main`** instead of using it: the operator chose the pointer. Alternatively protecting `main` with a ruleset would stop the driver's leased force-update on rollback; the pointer must be allowed to move backwards or it lies.

## Consequences

- The deploy runs as root from a copy in `/tmp` until D.2 moves the checkout, the deploy key and the service to `ops` (recorded as DEBT D-23). D.2 also makes `.nvmrc` the Node gate it is designed to be: a rollback to a commit pinning a Node the host no longer has refuses, by design.
- `main` is unprotected on purpose and is never pushed by hand; the Claude Code Bash guard still refuses a typed force or `:ref` push to `main`, and the guard does not see inside the driver (DEBT D-22) — the driver's force-with-lease is confined to the rollback-to-ancestor case.
- The host script copies the workstation's procedure, so deploying an old commit (which may predate `scripts/ops/`) still uses today's procedure.
- Every host change that is not a deploy (reboot, package, config) gets its own ledger row and, when it changes behaviour, its own decision entry.

## Evidence

- Inventory 2026-10-30/31 (`docs/PHASE_D_PLAN.md` D.0): `dev @ 3ee22e2` since 2026-10-19, `node_modules` from 2026-08-27, reboot pending, root's unit and crontab, no `main` on the remote.
- Local Node 26 validation 2026-10-31 (plan, Approval §2).
- Execution record: `docs/decisions/deploys.md` rows of 2026-10-31 and the **Execution** section below.

## Execution

_Filled in after the first run._
