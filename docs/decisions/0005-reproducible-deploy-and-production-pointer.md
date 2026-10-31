# 0005 — Deploys run one reviewed script on the host from one command on the workstation; `main` is the production pointer that script moves

**Date:** 2026-10-31 · **Status:** active · **Phase:** D.1.

## Decision

Production is deployed only by `make deploy [REF=…]`. The workstation driver (`scripts/ops/deploy-driver.sh`) refuses unless `scripts/ops/` equals `origin/dev`, resolves `REF` to a commit on `origin/dev`, streams `scripts/ops/deploy.sh` from `origin/dev` to the VPS and starts it detached as root (as `ops` after D.2), following its run log; both sides refuse to act in market hours unless the operator sets `QT_MARKET_HOURS_OK=1`. The host script takes a lock, refuses a dirty tree, fetches, requires the host's and the unit's Node to match the commit's `.nvmrc` before touching anything, checks out the exact commit detached, reinstalls from the lockfile and builds — restoring the running commit's tree and build if either step fails — waits up to 20 minutes for a gap between cron ticks with no wrapper running, restarts the service, records the live commit (`live.sha`), and passes only when the service is active on the pinned Node, `/login` answers 200 and the next scheduled manage, heartbeat (`stale_count` 0) and scan ticks log `http=200`; it reads no secret. Each run appends `OK` or `FAIL` (with the phase, and after a restart the restart time and the live commit) to `/var/log/quanttrader/deploys.log`; a verified run records the commit in `/var/log/quanttrader/running.sha`, and the next deploy takes `live.sha` as the running commit so a rollback restores what actually runs. The driver appends a row to `docs/decisions/deploys.md` for every run (OK, FAIL, unknown, interrupted), which the next PR commits, and only after a verified deploy moves the branch `main` to the deployed commit — fast-forward normally, a leased force-update when the deployed commit is an ancestor (a rollback), no move with a message when it is neither. The rollback is the same command with `REF=<previous sha>`. The host's unit, crontab, sshd drop-in and firewall are captured in `ops/` and change only through PRs; `ops/**` and `scripts/ops/**` are infrastructure, not fenced (decision 0006): shellcheck, CI, a fresh-context review on every PR and the operator's approval of every host command protect them.

## Why

Until today the host was deployed by hand as root (`git pull && pnpm build && systemctl restart`), with no record of when, no check that the service came back, and `main` absent from the remote. The audit has to bracket paper-trading results by what was running; the operator asked for a one-command rollback written down before the first deploy; and the brief's bar is "nothing fails silently".

## Alternatives considered

- **CI-driven deploy** (GitHub Actions ssh-ing into the VPS on merge): puts a host-writing key in GitHub secrets, deploys the moment a PR merges, which the standing rule (no VPS change in market hours) forbids, and removes the deliberate weekend step. Rejected for now; revisit if deploy frequency makes the manual step a cost.
- **Pull-based deploy** (a cron on the host polling `dev`): deploys with nobody watching. Rejected for the same reason.
- **Containers / a different host model:** a rewrite, and Phase E material at the earliest.
- **Deleting `main`** instead of using it: the operator chose the pointer. Alternatively protecting `main` with a ruleset would stop the driver's leased force-update on rollback; the pointer must be allowed to move backwards or it lies.

## Consequences

- The deploy runs as root from a per-run copy in `/tmp` until D.2 moves the checkout and the service to `ops` (recorded as DEBT D-23). A commit with `.nvmrc` refuses on a Node mismatch; a commit without one (such as `3ee22e2`) runs on the host's Node, and the ledger records which.
- A rollback moves `main` backwards with a leased force-update. Confirmed by the operator 2026-10-31: `main` equals the verified running commit, moved only by the deploy script after verification, forward on a deploy and back on a rollback; a pointer claiming a commit that is not running is worse than no pointer.
- A deploy takes 10–45 minutes: it waits for the real manage, heartbeat and scan ticks after the restart rather than calling the routes itself, and the driver refuses to start within the hour before the Sunday open so a run cannot cross it. The market-hours override is recorded in both ledgers.
- A run interrupted on the workstation that the host later verifies leaves `main` behind; redeploying the same commit moves it. A pointer-only step is a follow-up.
- A failed deploy starts the service if its restart left it down, and a successful one restarts it. Once the D.3 kill switch exists, `make deploy` must refuse while the switch is engaged, or it would undo a stop.
- `main` is unprotected on purpose and is never pushed by hand; the Claude Code Bash guard still refuses a typed force or `:ref` push to `main`, and the guard does not see inside the driver (DEBT D-22) — the driver's force-with-lease is confined to the rollback-to-ancestor case.
- The host script copies the workstation's procedure, so deploying an old commit (which may predate `scripts/ops/`) still uses today's procedure.
- Every host change that is not a deploy (reboot, package, config) gets its own ledger row and, when it changes behaviour, its own decision entry.

## Evidence

- Inventory 2026-10-30/31 (`docs/PHASE_D_PLAN.md` D.0): `dev @ 3ee22e2` since 2026-10-19, `node_modules` from 2026-08-27, reboot pending, root's unit and crontab, no `main` on the remote.
- Local Node 26 validation 2026-10-31 (plan, Approval §2).
- Fresh-context review of PR #309 (2026-10-31): 17 findings; the seven that affect correctness (an injectable pre-approved target, a restart that could kill an in-flight tick, a failed build leaving no build on disk and a wrong "previous" commit, failures exiting without a ledger line, an unverified heartbeat and scan path, the working-tree script running on the host, permissions contradicting `CLAUDE.md`) were closed before the first deploy; the rest were closed in the same PR or recorded in DEBT.
- Execution record: `docs/decisions/deploys.md` rows of 2026-10-31 and the **Execution** section below.

## Execution

_Filled in after the first run._
