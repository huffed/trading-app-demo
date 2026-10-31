# Phase D — operations: plan from the read-only inventory of 2026-10-30

Status: **D.1 executed 2026-10-31 (decision 0005, ledger rows in `docs/decisions/deploys.md`); D.2 designed (decision 0007), its host step recorded in the ledger when run; D.3–D.7 planned.** Every step below changes the VPS only after the operator's check-in approval, gets a dated `docs/decisions/` entry saying what changed and when (so the audit can bracket paper-trading results), and is reversible by the step before it. Order is the operator's: reproducible deploy first, then the process user and the Node LTS move, then kill switch, alerts, nightly parity, backups. Hetzner firewall, the fate of `main` and the sudoers narrowing as they are reached.

## D.0 Inventory (read-only, 2026-10-30, `ssh qt` as `ops`)

| Item | Found | Consequence |
|---|---|---|
| Host | Hetzner Cloud `quanttrader-prod`, instance 163800159, eu-central / nbg1-dc3; Ubuntu 26.04 LTS, kernel 7.0.0-29; up 9 weeks | — |
| **Pending reboot** | `/var/run/reboot-required` present; unattended-upgrades active, `Automatic-Reboot` not configured | kernel/security updates are installed but not running; a reboot needs a maintenance window (service down ~1 min, one cron tick lost) |
| Resources | disk 22 % of 38 GB; RAM 829 MB of 3.8 GB used; swap 2 GB unused; app RSS 234 MB | ample |
| Service unit | `/etc/systemd/system/quanttrader.service`: `ExecStart=/root/.nvm/versions/node/v25.9.0/bin/pnpm start`, `PATH` pinned to that Node, `Restart=always`, `RestartSec=5`, **no `User=` (root)**, no `EnvironmentFile`, no hardening directives; active since 2026-10-29 09:21 (the secret rotation), 0 restarts since | the unit is not in the repo; it is the first thing D.1 captures |
| **Checkout lag** | `/opt/quanttrader` on `dev @ 3ee22e2` (2026-10-19), clean; last fetch 2026-10-19; `.next` built 2026-10-19 12:42; `node_modules` installed **2026-08-27** | production has none of Phases B/C (tooling only, golden MATCH, so no trade impact). The next deploy must run `pnpm install --frozen-lockfile` (lockfile changed: tsx, shadcn, removed deps) |
| Runtime | only Node v25.9.0 under `/root/.nvm`; no `.nvmrc` on the host yet | Node 25 is end-of-life (DEBT D-21) → D.2 |
| Secrets | `/opt/quanttrader/.env.local` 600 root 1,749 bytes (rotated 2026-10-29); `/root/.ssh/gh_deploy` read-only GitHub deploy key + `config` | D.2 moves the file and the key to `ops`; the deploy key stays read-only |
| Crontab | root, 10 entries as documented in `scripts/README.md`, each `>> /var/log/quanttrader/<name>.log 2>&1` | D.2 moves it to `ops` |
| **Logs** | `/var/log/quanttrader/*.log`: scan 8.1 MB, manage 4.7 MB, heartbeat 3.6 MB, oanda 3.6 MB …; **no logrotate rule** | unbounded growth; D.4 adds rotation |
| Network | sshd on 22 (v4+v6), `next-server` on `*:3000` (ufw keeps it off the internet), tailscaled; Tailscale node `quanttrader-prod` | D.2 decides whether 3000 binds to the Tailscale address only |
| Alerts today | GitHub Actions `dead-man.yml` every 30 min (heartbeat / scan tick / alpha-decay tick / broker API) → ntfy push (`NTFY_TOPIC`, `NTFY_TOKEN` secrets set) + email; `HEARTBEAT_PING_URL` **unset** on the VPS (no inverted uptime monitor) | D.4 |
| Backups | none on the host; Supabase Pro holds the data (daily backups per plan, to be confirmed in the dashboard) | D.6 |
| Kill switch | nothing named so; `/api/admin/flatten-algo` and the halts exist in the app | D.3 |

## D.1 Reproducible deploy — first, because it makes every later change reversible

**Deliverables**
- `ops/` in the repo (infrastructure as code, no secrets): `ops/systemd/quanttrader.service` (captured from the host, then edited in D.2), `ops/crontab` (the 10 lines), `ops/sshd/10-hardening.conf`, `ops/ufw.sh`, `ops/logrotate/quanttrader` (D.4). The host is rebuilt from these, never by hand.
- `scripts/ops/deploy.sh` — runs **on the VPS**, detached, one at a time, fails loudly: refuse a dirty tree, fetch, the commit's `.nvmrc` must equal the host's and the unit's Node, detached checkout, `pnpm install --frozen-lockfile`, `pnpm build` (the running commit's tree and build are restored if either fails), no restart in market hours, wait (≤ 20 min) for a tick gap with no cron wrapper running, `systemctl restart`, `live.sha`, service active on the pinned Node, `/login` 200, the next manage, heartbeat (`stale_count` 0) and scan ticks log `http=200` (≤ 25 min), `running.sha`, an `OK`/`FAIL` line in `/var/log/quanttrader/deploys.log`. Reads no secret. Rollback = `REF=<previous sha>` and the same script (as reviewed 2026-10-31).
- `make deploy [REF=…]` (`scripts/ops/deploy-driver.sh` on the workstation: copies the host script over, runs it as root, and only after the host reports a verified deploy moves the production pointer `main` and appends the ledger row), `make status` (service state, deployed sha, last tick per log, pending reboot, `origin/dev` for comparison), `make logs [LOG=scan] [N=40]` — all over `ssh qt`, read-only except `deploy`.
- A deploy ledger the audit can read: `docs/decisions/deploys.md`, one row per deploy appended by `make deploy` and committed in the next PR, plus one row per host change that is not a deploy (reboot, package, config), each pointing at its full `docs/decisions/` entry.

**Rollback (one command, confirmed 2026-10-31):** `make deploy REF=3ee22e2` returns the host to the commit it ran from 2026-10-19 to 2026-10-31. It is the same script on the same path — fetch, detached checkout of `3ee22e2`, `pnpm install --frozen-lockfile` from that commit's lockfile, `pnpm build`, restart between ticks, the same `/login` + heartbeat + next-tick checks — and it moves `main` back with a leased force-update, so after every verified deploy `main` is what runs; between a failed post-restart verification and the rollback it tells you to run, `live.sha` on the host and the ledger row name the unverified live commit. `3ee22e2` has no `.nvmrc` (and no `engines`), so it runs on whatever Node the host has and the ledger records which — 25.9.0 today, 26 after D.2; a commit **with** `.nvmrc` refuses on a mismatch, which is the fail-closed behaviour D.2 relies on.

**First execution (approved 2026-10-31, deadline 20:00 UK):** deploy current `dev` (Phases B + C + D.1, golden MATCH) to replace `3ee22e2`; the host reinstalls `node_modules` from the lockfile. Verify: service active, the next scheduled cron tick logs 200, heartbeat healthy — the script checks `systemctl is-active`, `/login`, and the next manage, heartbeat (`stale_count` 0) and scan ticks. Then take the pending **reboot**, verify again (`make status`: service active, ticks 200). Two ledger rows — deploy, then reboot — and entry `0005-reproducible-deploy-and-production-pointer.md`.

## D.2 Process user and Node LTS — designed per decision 0007 (2026-10-31); execution recorded in the deploy ledger

Approved 2026-10-31 (questions 2 and 3) and designed in `docs/decisions/0007-node-26-ops-user-loopback-tailscale.md`; the host procedure with its verification and rollback is `docs/runbooks/d2-node-26-ops-user-loopback.md`.

- **Node 26.13.0** (LTS "Lithium"), system-wide at `/usr/local` from the checksum-verified official tarball; `.nvmrc` 26.13.0, `engines` `>=26.0.0 <27`, CI reads `.nvmrc`; the deploy refuses a mismatch of the host's or the unit's Node and checks the service's own Node after the restart. Local validation on 26.13.0 before any host change: `make check` (2176 passed + 11 expected failures), `make backtest` MATCH, `make build` clean.
- **Process user:** `chown -R ops:ops /opt/quanttrader /var/log/quanttrader` (the env file chowned in place, never read or moved); unit `User=ops` with `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome`, `HOME=/var/lib/quanttrader`, running Next's entry point with node directly (pnpm would read `~/.config/pnpm` under `ProtectHome`); the unit is tested in its sandbox with `systemd-run` before anything restarts; the crontab moves to `ops` with a `PATH` line (the three `pnpm dlx` wrappers) and root's is removed in the same minute; `make deploy` runs as `ops` with `sudo -n systemctl restart quanttrader` as the only privileged step.
- **Loopback + Tailscale:** `tailscale serve --bg --https=443 http://127.0.0.1:3000` is set up and confirmed from a tailnet device (sign-in included) **before** the deploy rebinds Next to `127.0.0.1:3000`; ufw stays as the second layer; the SSH tunnel remains the fallback.
- **HTTPS git remote:** the repository is public, so the host keeps no deploy key for `ops`; revisit if the repository ever goes private (the deploy fails loudly at `git fetch`).
- **Sudoers narrowing:** moved to D.7, after the remaining root work (logrotate, backups, firewall) — `ops` keeps `NOPASSWD:ALL` until then (DEBT D-23).

## D.3 Kill switch (paper only, during a window the operator confirms)

- `make kill-switch` → `scripts/ops/kill-switch.sh` on the VPS, in this order: (1) pause every active algorithm (admin route or SQL through the app's admin client — to be chosen after reading `src/app/api/admin/`), so no new entries; (2) flatten open **paper** positions through `/api/admin/flatten-algo`; (3) stop the service and the crontab (`systemctl stop quanttrader`; crontab disabled by renaming); (4) print what it did. `make resume` reverses (3) and un-pauses nothing — un-pausing is a deliberate operator act.
- Test on paper only, in the confirmed window: run, verify in the database that positions are closed with the right `exit_reason` (D-01: the halt reasons are rejected by the CHECK today, so the test may surface that), verify the dead-man alert fires (it should: the stop is real), then `make resume`. Entry: `0008-kill-switch.md` with the test log.

## D.4 Alerts and hygiene

- `HEARTBEAT_PING_URL` → a free inverted uptime monitor (healthchecks.io), so a dead host alerts without GitHub Actions; keep the dead-man workflow as the second channel.
- systemd `OnFailure=` → a one-shot unit that posts to ntfy; a daily `ops-health` cron (disk, memory, `reboot-required`, failed units, deploy sha vs `origin/dev`) → ntfy summary.
- `deploy.sh` posts success/failure to ntfy.
- logrotate for `/var/log/quanttrader/*.log` (weekly, 8 rotations, compressed); `Unattended-Upgrade::Automatic-Reboot` stays **off** (reboots are operator windows), but the daily summary says when one is pending.
- Entry: `0009-alerts-and-rotation.md`.

## D.5 Nightly parity job

- Depends on the audit's `paper-replay.ts` landing on `dev` (then `make parity` stops being a stub, DEBT D-02). The job: nightly, on the VPS or as a scheduled GitHub Actions workflow, runs the parity replay over the paper positions of the last N days against the pinned bars, posts the summary to ntfy, exits non-zero on divergence above the agreed band.
- Available now, independent of the audit: a **nightly scheduled CI run** of `make check` + `make backtest` on `dev` (catches dependency, provider and environment drift that PR runs cannot). Cheap; proposed for D.4's PR.

## D.6 Backups with a tested restore

- **Data:** Supabase Pro daily backups — confirm retention in the dashboard (operator). Add an independent nightly `pg_dump` of the operational tables (`algorithms`, `paper_positions`, `activity_log`, `llm_decisions`, `broker_connections` encrypted at rest with `age`) to a destination outside the VPS. Options: Hetzner Storage Box (~€3.5/month) or Hetzner Object Storage; budget within the £150 ceiling. `price_cache` is excluded (rebuildable from pins).
- **Host:** everything that is not data lives in the repo after D.1/D.2 (`ops/`), except `.env.local`, which the operator holds; the deploy key is regenerable.
- **Tested restore, twice a year and before any schema change:** (a) restore the latest dump into a Supabase branch or a local Postgres and run `tests/contracts/`; (b) provision a throwaway Hetzner VPS from `ops/`, `make deploy` against it, hit `/login`, destroy it (cost: cents). Entry: `0009-backups-and-restore-drill.md` with the first drill's log.

## D.7 As reached

- **Hetzner Cloud firewall** (console or `hcloud` with an API token the operator creates): inbound 22/tcp and Tailscale's 41641/udp only. Second layer under ufw.
- **`main`:** absent on the remote (verified 2026-10-31; the local `main` is an old ancestor of `dev`). Approved (question 5): the first `make deploy` creates it as the production pointer and every verified deploy moves it (decision 0005).
- **sudoers narrowing:** D.2.

## Check-in questions before any VPS change

1. D.1 as designed, including the first deploy of current `dev` and the pending reboot in the same window — which window?
2. Node 24 or 26 (recommendation: 26 if the local run on it is clean).
3. Port 3000: keep `*:3000` behind ufw, or bind to the Tailscale address only.
4. Backups destination and budget (Storage Box vs Object Storage), and whether Supabase PITR is wanted.
5. `main`: production pointer or delete.
6. Kill-switch semantics as in D.3 (pause → flatten paper → stop service and crons), and the paper test window.
7. Deploy ledger as `docs/decisions/deploys.md` (one line per deploy) plus full entries for infrastructure changes.

## Approval (2026-10-31)

Answers to the seven questions, verbatim in substance:

1. **D.1** as designed, today, finished before 20:00 UK and well clear of the Sunday 22:00 open. Rollback written into the plan first (above). First deploy reinstalls `node_modules` from the lockfile; verify service active, next cron tick 200, heartbeat healthy; reboot after that verification, verify again; deploy and reboot are two ledger rows.
2. **Node 26**, provided the full suite and the golden file are clean on 26 locally and Next.js and every native dependency support it; otherwise Node 24. Local result 2026-10-31 on Node 26.13.0 (`pnpm install --frozen-lockfile`, `make check`, `make backtest`, `make build`): 140 test files, 2176 passed + 11 expected failures, golden MATCH, build compiled; Next.js 16.2.4 declares `node >=20.9.0`.
3. **Bind to loopback and the Tailscale address only**; nothing on the public interface. The crons call via loopback. Confirm the dashboard opens over Tailscale from the operator's devices before the public port closes; keep the ufw rule as a second layer.
4. **Hetzner Storage Box** (~€3.50/month) for host config, the env files (encrypted at rest with age or gpg, key kept off the box), pins and logs, plus a nightly `pg_dump` of Supabase to the same box, 30-day retention, one tested restore. Supabase Pro: confirm the daily-backup retention in the dashboard and record it; no point-in-time recovery for now.
5. **`main` is the production pointer**, fast-forwarded by the deploy script only after a successful, verified deploy. `dev` stays the integration branch and the protected one.
6. **Kill switch** as in D.3, plus: one idempotent command; it still stops the service and the crons if the database is unreachable (fail closed); it sends an alert and writes a ledger row; the resume procedure is documented next to it. Paper test this weekend only if D.1 and D.2 are both clean, before Sunday 18:00; otherwise next weekend.
7. **Ledger** as proposed.

**Standing rules for D from here:** no VPS change during market hours (Sunday 22:00 to Friday 22:00 UK) except the kill switch; D.2 proceeds today only if D.1 is clean; anything not finished by Sunday 18:00 waits for next weekend.
