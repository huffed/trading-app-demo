# 0011 — Nightly encrypted backups to the Storage Box, with a tested restore

**Date:** 2026-11-06 · **Status:** active since 2026-11-07 (installed in the window, ledger row 2026-11-07T16:42Z) · **Phase:** D.6.

**Tested:** 2026-11-07 to 2026-11-10, a restore drill of `nightly/2026-11-07` into a Supabase branch. Both dumps loaded with no error, and the branch's count for each of the five tables equals production's rows created before the dump (`evidence/d6-restore-drill-2026-11-07.md`). The branch's status was unhealthy, which the operator attributes to the migration replay D-34 expected (no failing migration was read); the drill does not use its schema. Not tested: a whole restore into a new project, and the throwaway-VPS drill.

## Decision

`scripts/ops/backup.sh` runs as `ops` at 02:22 UTC from `/usr/local/lib/quanttrader/`, so a rollback of the checkout cannot remove it. Each night it writes five files to `nightly/<date>/` on the Storage Box sub-account `u708205-sub1`, all encrypted with age to the public key in `ops/backup/age-recipient.txt`: a custom-format `pg_dump` of schema `public`; a second, data-only dump of `auth.users` and `auth.identities`; the host's `.env.local`; the host's unit, logrotate, sshd and fail2ban files, installed scripts and crontab; and `/var/log/quanttrader`. A sixth file, `OK`, goes up last and only on a whole night, and a restore uses the newest night that has it. The pinned corpora go to `pins/` unencrypted, because they are public and already in git. The private key is the operator's and is never on the host, the box or in a session. Retention is 30 nights plus the box's own daily snapshots. Supabase's own backups stay as the first line: Pro plan, daily, 7-day retention, read in the dashboard on 2 November 2026, no point-in-time recovery.

The database is read by a dedicated role, `backup_ro`: login, `bypassrls`, read-only by default, three connections at most, and member of Postgres's built-in `pg_read_all_data`. It can read the whole database and write nothing. Its password is set with `\password` from the operator's terminal, and its connection line is appended to the host's env file by the operator.

A night fails loudly and safely: every part is attempted, a failed part is not uploaded, a checksum dry run verifies the upload, nights are pruned only after a night that fully succeeded, a lock stops a second run overlapping a hung one, any failure pushes one urgent ntfy message and exits 1, and `backup.last-ok` is written only on success. The daily summary shows that stamp and turns high priority when it is older than 26 hours, which also catches a job that never ran.

## Why

The approval of 2026-10-31 asked for host config, env files encrypted at rest with the key off the box, pins and logs, a nightly `pg_dump`, 30-day retention and one tested restore. Supabase's 7 days do not cover a mistake noticed later, and they sit with the same provider as the data. `oanda_positioning_cache` is forward-only, so losing it cannot be undone by re-fetching.

## Alternatives considered

- `pg_dump` of the five operational tables only, as the plan first said: rejected. The whole schema costs little, the forward-only table is the one that cannot be rebuilt, and 15 public tables reference `auth.users`, so a restore needs that too.
- `pg_dump --schema=public --table=auth.users` in one run: not possible, `--table` makes `pg_dump` ignore `--schema`.
- Grants on `public` and on the two `auth` tables instead of `pg_read_all_data`: narrower, but it cannot work. `postgres` holds `usage` on schema `auth` without the grant option, so the grant succeeds with a warning and does nothing. The broader read is accepted: the role writes nothing, and the same host already holds the service-role key.
- The database password on the `pg_dump` command line: rejected, it would be readable in the process list. The URL is read here and passed through libpq's environment.
- The password in the role's `create role` statement: rejected, `log_statement` is `ddl`, so it would reach the database log in the clear.
- The direct connection string: IPv6 unless the IPv4 add-on is bought (from memory). Supabase's restore docs say to use the session pooler by default, and it works from any host.
- `PGSSLMODE=verify-full`: not at first. The job used `require`, which encrypts but does not verify the server, so someone able to intercept the path between Hetzner and Supabase could present another certificate. **Amended 2026-11-12:** adopted after the operator's test on 2026-11-10, where `verify-full` with Supabase's root CA (`prod-ca-2021.crt`, the Supabase Root 2021 CA) connected through the session pooler as `backup_ro` and returned 1. The certificate is `ops/backup/prod-ca-2021.crt` (SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`, copied from the operator's download), installed beside the age recipient after a fingerprint check; without it the night fails and pushes rather than connecting unverified. It goes on the host in the 14–15 November window (`docs/runbooks/d6-backups.md`, `verify-full`), and the nights from 2026-11-07 until then ran with `require`.
- Replaying `supabase/migrations`, or a branch's own schema, as the drill's starting point: rejected. A branch replays production's recorded history, which does not match the files and may fail (DEBT D-34). The drill clears `public`, guarded by an empty `auth.users`, and loads the dump's schema, so it proves the dump loads. It does not prove a whole restore: the runbook lists what a real one adds.
- `tests/contracts/` as the drill's proof, as the plan first said: rejected, it reads migrations and never touches a database. The drill compares row counts.
- A local Postgres for the drill: rejected by the operator in favour of a Supabase branch.

## Consequences

- The dumps keep owners out but keep access rules, so a restore can recover the grants and revokes; `pg_restore` leaves them out only in the drill.
- `ops/crontab` gains a 12th line and `ops/logrotate/quanttrader` a 13th log.
- `ops-health.sh` changes, so its installed copy is repeated in the same step.
- The job needs no sudo; its sudoers entry at D.7 needs nothing for backups beyond what the installation used once.
- Since `verify-full` (amended 2026-11-12) the dumps depend on Supabase's root CA: if Supabase changes the pooler's certificate chain, or when the root expires on 2031-04-26, every dump stops, fails closed and pushes, and the daily summary turns high after 26 hours, until a new certificate is installed.
- `BACKUP_DATABASE_URL` joins `.env.example`. `.env.local` on the host now holds a second database credential, read-only, and it is inside `env.tar.age`.
- Dumps hold broker tokens and password hashes, so they are decrypted only on the operator's machine, and the drill's restore leaves `broker_connections` data out so a branch never holds a token.
- The private key is a single point of failure: without it the box holds nothing readable. It needs more than one copy, off the host and off the box, and where they live is the operator's to choose.
- With external reachability off, a restore fetches through the VPS. If the VPS is gone, the job's key is gone with it: turn reachability on in the panel, log in from the workstation with the sub-account's password (reset it in the panel if it is lost), fetch, turn reachability off.
- Egress: the dump goes through the pooler, which counts as egress. At the database's 335 MB, 31 nights is at most about 10 GB a month against Pro's 250 GB, so about 4%, with overage at $0.09 per GB (Supabase's docs, read 2026-11-06). This is recorded because the project hit an egress quota on the free tier in October.
- A 30-day silent outage followed by one good night would prune the older nights. The daily summary alarms on the second day and the box keeps its own snapshots, so that is accepted.
- This repo is public, and `DEV_SETUP.md` says nothing host-identifying goes in it. The Storage Box name and sub-account are written in on the operator's instruction of 2026-11-06, as a recorded exception: the box accepts only Hetzner hosts and only this key.
- The plan's second drill, a throwaway VPS provisioned from `ops/`, is not part of this decision and has not been run. It proves the host can be rebuilt, not that a backup restores. The operator scheduled it for the next window, 14 and 15 November, if D.6 is clean (2026-11-06).

## Evidence

Database facts read 2026-11-06: PostgreSQL 17.6, 335 MB; `postgres` holds `createrole`, `bypassrls` and `pg_read_all_data` with admin rights; `usage` on schema `auth` is not grantable; `select` on the two `auth` tables is; `log_statement` is `ddl`; `SET session_replication_role` is allowed. Branching and restore from Supabase's docs and billing docs the same day. Storage Box commands from Hetzner's docs the same day. Tests: `tests/ops/backup-script.test.ts` runs the real script against stand-ins, including a fake age that writes a header on empty input, so removing `pipefail` fails two tests (checked 2026-11-06).
