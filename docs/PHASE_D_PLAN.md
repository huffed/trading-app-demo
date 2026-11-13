# Phase D — operations: plan from the read-only inventory of 2026-10-30

Status: **D.1 executed 2026-10-31 (decision 0005); D.2 executed 2026-10-31/11-01 (decision 0007); D.3 built, merged and paper-tested 2026-11-01 (decision 0008); D.4 built, merged and applied to the host 2026-11-01, and the CI half of D.5 live (decision 0009); all ledgered in `docs/decisions/deploys.md`. D.5's host-side parity job waits on the audit's `paper-replay.ts`, D.6 installs in the window of 7 and 8 November, D.7 after D.6.** Every step below changes the VPS only after the operator's check-in approval, gets a dated `docs/decisions/` entry saying what changed and when (so the audit can bracket paper-trading results), and is reversible by the step before it. Order is the operator's: reproducible deploy first, then the process user and the Node LTS move, then kill switch, alerts, nightly parity, backups. Hetzner firewall, the fate of `main` and the sudoers narrowing as they are reached.

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

## D.2 Process user and Node LTS — executed per decision 0007 (host steps 2026-10-31, deploy 2026-11-01; ledger rows in `docs/decisions/deploys.md`)

Approved 2026-10-31 (questions 2 and 3) and designed in `docs/decisions/0007-node-26-ops-user-loopback-tailscale.md`; the host procedure with its verification and rollback is `docs/runbooks/d2-node-26-ops-user-loopback.md`.

- **Node 26.13.0** (LTS "Lithium"), system-wide at `/usr/local` from the checksum-verified official tarball; `.nvmrc` 26.13.0, `engines` `>=26.0.0 <27`, CI reads `.nvmrc`; the deploy refuses a mismatch of the host's or the unit's Node and checks the service's own Node after the restart. Local validation on 26.13.0 before any host change: `make check` (2176 passed + 11 expected failures), `make backtest` MATCH, `make build` clean.
- **Process user:** `chown -R ops:ops /opt/quanttrader /var/log/quanttrader` (the env file chowned in place, never read or moved); unit `User=ops` with `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome`, `HOME=/var/lib/quanttrader`, running Next's entry point with node directly (pnpm would read `~/.config/pnpm` under `ProtectHome`); the unit is tested in its sandbox with `systemd-run` before anything restarts; the crontab moves to `ops` with a `PATH` line (the three `pnpm dlx` wrappers) and root's is removed in the same minute; `make deploy` runs as `ops` with `sudo -n systemctl restart quanttrader` as the only privileged step.
- **Loopback + the Tailscale address:** `quanttrader-tailnet.socket` + `systemd-socket-proxyd` listen on the tailnet addresses (100.77.24.89 and the IPv6 one, :3000) and forward to loopback; the proxy path and the device check (sign-in and a Server Action) are done on a test port **before** the deploy rebinds Next to `127.0.0.1:3000`, and the socket takes :3000 right after the restart; `tailscale serve` (HTTPS) is an optional layer once the operator enables Serve on the tailnet; ufw stays as the second layer; the SSH tunnel remains the fallback.
- **HTTPS git remote:** the repository is public, so the host keeps no deploy key for `ops`; revisit if the repository ever goes private (the deploy fails loudly at `git fetch`).
- **Sudoers narrowing:** moved to D.7, after the remaining root work (logrotate, backups, firewall) — `ops` keeps `NOPASSWD:ALL` until then (DEBT D-23).

## D.3 Kill switch — built per decision 0008 (2026-11-01); paper test PASSED 2026-11-01 15:18–15:45 UK (ledger rows KILL, KILL, RESUME, UNPAUSE)

- `make kill-switch REASON=<word>` → `scripts/ops/kill-switch.sh` on the host as `ops`, streamed from the local `origin/dev` (no GitHub dependency): (1) pause every active algorithm through Supabase REST with the host's service role, saving the ids; (2) flatten their open paper positions through `/api/admin/flatten-algo` on loopback; (3) stop the service, save and remove the crontab; (4) urgent ntfy push + `KILL` ledger line. Every step is attempted; with the database or the app unreachable the stop still happens (fail closed). Idempotent. The only host command allowed in market hours (the one other exception since 2026-11-02: appending the `HEARTBEAT_PING_URL` line, D.4).
- `make resume` reverses the stop (service, crontab, tick verification, push, `RESUME` line) and un-pauses nothing; `make unpause` re-activates exactly the saved ids (`UNPAUSE` line) — the operator's deliberate act.
- Paper test (checklist in `docs/runbooks/kill-switch.md`): expect no open positions; the sequence is the test. healthchecks.io should trip about 20 min after the last heartbeat ping; the dead-man's checks fail once ticks are 35–45 min stale, but they run only when GitHub starts the job, 2 to 5 times a day (DEBT D-30). Rows go to `docs/decisions/deploys.md` and the test log to decision 0008.

## D.4 Alerts and hygiene — built per decision 0009 (2026-11-01); applied to the host 2026-11-01 16:01–16:07Z per `docs/runbooks/d4-alerts-and-rotation.md` (ledger row `2026-11-01T16:07:33Z`); verified 2026-11-02 (both test pushes received, first daily summary ran; ledger row `2026-11-02T07:05:03Z`); `ping sent` logged by 2026-11-06 12:35Z (ledger row `2026-11-06T12:30Z`); still to verify: healthchecks.io receipt, the first weekly rotation, the next deploy's clean stop

- The host alerts on its own through the existing ntfy topic: `SuccessExitStatus=143` + an `ExecStopPost=` hook on the app unit (urgent push only on an unclean stop, rate-limited — `OnFailure=` would fire on every deliberate stop and never on a crash loop under `Restart=always`), `deploy.sh` posts every run's result, `ops-health.sh` posts a daily summary from the `ops` crontab (07:05 UTC) at high priority only when something needs a hand (disk, reboot pending, failed units, live ≠ verified or live not on dev, service down, algorithms held paused by the kill switch). The hook and the summary script are installed to `/usr/local/lib/quanttrader/`, outside the checkout.
- logrotate for the twelve cron and ops logs by name: weekly, eight rotations, compressed, owned by `ops`; the ledger `deploys.log` is never rotated and per-run deploy logs are pruned by age.
- `Unattended-Upgrade::Automatic-Reboot` stays **off**; the summary says when a reboot is pending.
- `HEARTBEAT_PING_URL`: the operator created the healthchecks.io check and appended the URL to the host's env file on 2026-11-06; the wrapper pings it. Appending that one line is the one host change besides the kill switch allowed in market hours (operator decision 2026-11-02, decision 0009 amendment: an append, never an edit; read on the next tick, no restart, failure mode a missing ping; ledger row when done; procedure in the runbook).

## D.5 Nightly parity job

- Depends on the audit's `paper-replay.ts` landing on `dev` (then `make parity` stops being a stub, DEBT D-02). The job: nightly, on the VPS or as a scheduled GitHub Actions workflow, runs the parity replay over the paper positions of the last N days against the pinned bars, posts the summary to ntfy, exits non-zero on divergence above the agreed band.
- **Done (CI half, decision 0009):** `.github/workflows/nightly.yml` runs `make check` + `make backtest` on `dev`, scheduled 03:17 UTC, started around 10:45 UTC so far, and pushes to the phone on failure.

## D.6 Backups with a tested restore — designed in decision 0011 and `docs/runbooks/d6-backups.md`; installed 2026-11-07, restore drilled 2026-11-07 to 11-10 (ledger row `2026-11-07T16:42Z`)

- **Recorded 2026-11-06:** Supabase Pro, daily backups, 7-day retention, backups listed 26 October to 2 November, read 2 November 2026. Storage Box `u708205`, Falkenstein, SSH only, external reachability off, daily snapshots on; sub-account `u708205-sub1`, base directory `quanttrader`.
- The list below is the original plan. Decision 0011 replaces its table list (whole `public` plus two `auth` tables) and its `tests/contracts/` check (row counts). Drill (b), the throwaway VPS, is not done; the operator scheduled it for the next window, if D.6 is clean.

- **Data:** Supabase Pro daily backups — confirm retention in the dashboard (operator). Add an independent nightly `pg_dump` of the operational tables (`algorithms`, `paper_positions`, `activity_log`, `llm_decisions`, `broker_connections` encrypted at rest with `age`) to a destination outside the VPS. Options: Hetzner Storage Box (~€3.5/month) or Hetzner Object Storage; budget within the £150 ceiling. `price_cache` is excluded (rebuildable from pins).
- **Host:** everything that is not data lives in the repo after D.1/D.2 (`ops/`), except `.env.local`, which the operator holds; the deploy key is regenerable.
- **Tested restore, twice a year and before any schema change:** (a) restore the latest dump into a Supabase branch or a local Postgres and run `tests/contracts/`; (b) provision a throwaway Hetzner VPS from `ops/`, `make deploy` against it, hit `/login`, destroy it (cost: cents). Entry: `0009-backups-and-restore-drill.md` with the first drill's log.

## D.7 As reached

- **Hetzner Cloud firewall** (console or `hcloud` with an API token the operator creates): inbound 22/tcp and Tailscale's 41641/udp only. Second layer under ufw.
- **`main`:** absent on the remote (verified 2026-10-31; the local `main` is an old ancestor of `dev`). Approved (question 5): the first `make deploy` creates it as the production pointer and every verified deploy moves it (decision 0005).
- **sudoers narrowing:** the next window, after D.6 (D-23, and the window section below).

## Window of 7 and 8 November 2026 (approved by the operator 2026-11-06)

Every host command runs only when the operator asks. Anything unfinished by Sunday 18:00 UK waits a week. Steps 4 to 6 and 8 drop out if their PRs are not reviewed by Saturday morning; steps 2, 9a, 3 and 3b still run. Saturday's order is 1, 2, 9a, 3, 3b, then as numbered (operator, 2026-11-06), and the table is in that order.

| # | When | Step | Changes on the host | Rollback |
|---|---|---|---|---|
| 1 | Sat | Pre-flight: `make status`, gate green | Nothing | None needed |
| 2 | Sat | `make deploy` of `dev` | Checkout, install, build, one restart, commit records, `main`. No file in `src`, `supabase` or the lockfile differs. First stop under the new unit. | `make deploy REF=2635d1f` |
| 9a | Sat, after step 2 verifies, before step 3 | The operator sets a root password at the prompt (`sudo passwd root`, value in their password manager, never printed or sent), then proves one console login through the Hetzner console. If the login fails, stop: step 3 waits for the operator's call. A ledger row with the time, never the value. | Root password set. Root SSH login stays off. | `sudo passwd -l root` |
| 3 | Sat, after 9a passes | Reboot, two ledger rows | New kernel (7.0.0-42); all processes restart; the pending flag clears | None for the app; if the kernel misbehaves, boot 7.0.0-38 from the Hetzner console |
| 3b | Sat, after step 3 verifies, on its own. If step 3 waits, this still runs on Saturday. | The operator resets the `postgres` database password in the Supabase dashboard, value in their password manager, never printed or sent, after the check below has run on both machines. Then the next heartbeat reads healthy (`make logs LOG=heartbeat N=1`) and `make status` is unchanged. That is a smoke check only, because the app does not hold this password. A ledger row with the time, never the value. | Nothing on the host | None back to the old value, which is exposed. If something does break, it was using the password: put the new value there. |
| 4 | Sat | Merge the scripts PR, `git fetch` | Nothing, but the three targets stream the new scripts from then on | Revert the PR, `git fetch` |
| 5 | Sat | Paper re-test with a synthetic position, including the D-27 path (`docs/runbooks/kill-switch.md`) | Crontab off and back; algorithms paused and back; service stopped and restarted; about an hour. Both reserved ids go in the ledger row. | The runbook's fallback, which starts from `make status`. Accepted by the operator, 2026-11-06: the switch flattens every active algorithm, so the algorithms holding real positions are paused first and checked by the gate query. Expect `open_untargeted=` the number of rows from the runbook's step 1 query (two positions on 6 November) and `KILL_RESULT=PARTIAL`. Nothing manages those positions while their algorithms are paused. |
| 6 | Sat or Sun | `make deploy` again | Same as step 2; the checkout gets the new scripts | `make deploy REF=<step 2 commit>` |
| 7 | Sun | Rotation check: the first weekly rotation is expected at 00:00 UTC | Read-only | None needed |
| 8 | Sun, if clean | Merge the D.6 PR, `git fetch`, then D.6 per `docs/runbooks/d6-backups.md` from a workstation checkout of `origin/dev`, no deploy needed, then the restore drill on a Supabase branch (Micro, $0.01344 per started hour, about $0.04 for 3 hours, quoted to the operator 2026-11-06) | `pg_dump` and `age`, `ops` key, backup script, reinstalled `ops-health.sh` and logrotate file, 12th crontab line, first backup. Prerequisite: the operator's role and password, then the database line on the host after 22:00 UK on Friday, which stays there if this step drops. | The runbook's Rollback, including `revoke` and `drop role backup_ro`. No trading path touches them. |
| 9b | Sun | D.7, the firewall: the operator adds the Hetzner firewall (22/tcp, 41641/udp) | Nothing on the host; the firewall sits outside it | Detach the firewall in the console |

9a runs before the reboot because step 3 is the first reboot since D.2 and the console is the way back. On 2026-11-06 the login screen appeared but no root password was known. Step 3's rollback also needs the GRUB menu, which should take no login but has not been reached. Detaching the firewall is the Cloud panel and needs no root password.

**The `postgres` password (step 3b).** It was exposed in chat and shell history on 2026-11-06. Nothing automated uses it. Read that day: no direct database client or connection string in the code, scripts, crons or workflows; the four GitHub secrets are ntfy and the public Supabase URL and anon key; the database has no foreign server, subscription, vault secret, `dblink` call or edge function, and no client was connected as `postgres`. The app and the crons use the Supabase URL and API keys, `make db-types` the access token, the Supabase MCP its own login, and the backup job `backup_ro`, whose password is separate.

The operator is what uses it:

- **A saved JetBrains connection,** `postgres@db.<ref>.supabase.co` in `.idea/dataSources*.xml`. It is gitignored and last changed in May, so it looks dormant. Update or delete it.
- **`psql` as `postgres`,** as in step 2 of `docs/runbooks/d6-backups.md`, which is done, and in any real restore. Keep the new value for these.
- **Drill step 6's production count,** if run from `psql`. The SQL editor needs no password, so use that.

A session cannot read the two `.env.local` files or the operator's own tools, so run this check from the repo root first. It prints counts, never values. An error line above a count means that check did not run.

```bash
grep -Ei 'postgres(ql)?://|^[[:space:]]*(export[[:space:]]+)?[A-Z0-9_]*(DB|DATABASE|PG|POSTGRES|SUPABASE_PASS)[A-Z0-9_]*=' .env.local | grep -vc backup_ro
ssh qt "grep -Ei 'postgres(ql)?://|^[[:space:]]*(export[[:space:]]+)?[A-Z0-9_]*(DB|DATABASE|PG|POSTGRES|SUPABASE_PASS)[A-Z0-9_]*=' /opt/quanttrader/.env.local | grep -vc backup_ro"
```

A count above 0 means reading those lines in your own terminal, deciding whether they hold this password, and updating them after the reset. Check `~/.pgpass` and any other saved `psql` or GUI connection too. The drill's branch has its own credentials, so the reset does not touch drill steps 1 to 5.

**Moved to the next window, 14 and 15 November (operator, 2026-11-06):**

- **`PGSSLMODE=verify-full` for the backup job (D-35's first item),** before the sudoers narrowing, which may refuse its `sudo -n install`: `docs/runbooks/d6-backups.md`, `verify-full`.
- **Sudoers (D-23).** The PR is written after D.6 shows what the backup job needs, with a decision entry. It keeps `systemctl disable --now` and `enable --now quanttrader`, which the switch and resume use, checks `sudo -n -l` for them, and runs with a second root shell open and `visudo -c`.
- **Drill (b), the throwaway VPS,** if D.6 is clean. It is the real disaster-recovery proof, and it costs cents.

## Window of 14 and 15 November 2026 (operator, 2026-11-13)

This replaces the list above.
- Every host command prompts (#333) and runs only when the operator asks. Each step gets a ledger row in `docs/decisions/deploys.md` in the next PR.
- Nothing starts before Friday 22:00 UK. Anything unfinished by Sunday 18:00 UK waits a week.
- Sudoers (D-23) and the D-35 scripts run only if their PRs are reviewed by Saturday 09:00 UK. Neither PR existed when this plan was written, so both are planned for the next window.
- Drill (b) is not in this window.

| # | When | Step | Changes on the host | Rollback |
|---|---|---|---|---|
| 1 | Sat | Pre-flight: `make status`, the nights since 10 November (`make logs LOG=backup N=40`) and the daily summaries (`make logs LOG=ops-health N=6`) | Nothing | None needed |
| 2 | Sat | `make deploy` of `dev`, after the check below | Checkout, install, build, one restart, commit records, `main`. The installed backup script does not change here. | `make deploy REF=2a7d7f7210de` |
| 3 | Sat | 9b, the firewall: the operator adds the Hetzner firewall (22/tcp, 41641/udp) in the Cloud console | Nothing on the host; the firewall sits outside it | Detach the firewall in the console |
| 4 | Sat | `PGSSLMODE=verify-full` for the backup job: `docs/runbooks/d6-backups.md`, section "`verify-full`", run from a workstation checkout of `origin/dev` | The installed `backup.sh` and the CA file under `/usr/local/lib/quanttrader/`; one night run by hand | The runbook's rollback |
| 5 | Sat or Sun | Clean-ups: the copies the D.6 install and step 4 left in `/tmp`, and the kill switch's saved crontab from the 7 November re-test | Up to seven files in `/tmp` and one in `/var/lib/quanttrader/` removed | None needed: each is a copy of a file in the repo or of the live crontab |
| 6 | Sun, after the logrotate timer's run | Rotation check: `backup.log`'s first weekly rotation | Read-only | None needed |

**Step 2, before the deploy, on the workstation.** An empty result means no app file changes; on 2026-11-13 it was empty for `dev` at `a6ba8de`. If it is not empty, stop: the deploy then changes the app, and that is a different step.

```bash
git fetch origin && git diff --stat 2a7d7f7210de origin/dev -- src supabase package.json pnpm-lock.yaml
```

**Step 5, read first, then remove only what the read shows.**
- `/tmp/backup.sh` and `/tmp/prod-ca-2021.crt` are step 4's copies. The other five are from the D.6 install of 7 November (`/tmp/quanttrader` is the logrotate file).
- A file the read shows as owned by root needs `sudo -n rm -f`.
- Leave `/tmp/quanttrader-m1-band.state`: it is the M1 band check's live state (D-38).

```bash
ssh qt 'ls -l /tmp/age-recipient.txt /tmp/backup.sh /tmp/crontab /tmp/d6-apt.log /tmp/ops-health.sh /tmp/quanttrader /tmp/prod-ca-2021.crt'
ssh qt 'rm -f /tmp/age-recipient.txt /tmp/backup.sh /tmp/crontab /tmp/d6-apt.log /tmp/ops-health.sh /tmp/quanttrader /tmp/prod-ca-2021.crt'
```

**The saved crontab.** `/var/lib/quanttrader/crontab.disabled` is the kill switch's copy from the 7 November re-test. Today it changes nothing:
- the switch overwrites it whenever the live crontab is non-empty (`scripts/ops/kill-switch.sh:97-100`);
- `deploy.sh` reads the switch as engaged only when the copy exists and the crontab is empty (`scripts/ops/deploy.sh:95`).

But `make resume` restores from it (`scripts/ops/resume.sh:71`). If the crontab were ever emptied by anything but the switch, a resume would install the 7 November copy. Remove it only if the first command prints `12` and `SAME`; otherwise stop and tell the session.

```bash
ssh qt 'crontab -l | grep -c "^[0-9*]"; crontab -l | diff - /opt/quanttrader/ops/crontab && echo SAME'
ssh qt 'rm -f /var/lib/quanttrader/crontab.disabled'
```

**Step 6.** Run it after the logrotate timer has run on Sunday; the 10 November read showed that timer at 00:42 to 00:46 UTC.
- Expect `backup.log.1` dated 15 November.
- If it is not there, the status line shows when logrotate first saw the file. Report it and change nothing.

```bash
ssh qt 'systemctl list-timers logrotate.timer --no-pager | sed -n 2p; ls -l --time-style=+%FT%T /var/log/quanttrader/backup.log*; grep backup.log /var/lib/logrotate/status'
```

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

**Standing rules for D from here:** no VPS change during market hours (Sunday 22:00 to Friday 22:00 UK) except the kill switch; D.2 proceeds today only if D.1 is clean; anything not finished by Sunday 18:00 waits for next weekend. **Amended 2026-11-02 (operator):** appending the one `HEARTBEAT_PING_URL` line to the host's env file is the second exception (decision 0009 amendment; procedure in `docs/runbooks/d4-alerts-and-rotation.md`).
