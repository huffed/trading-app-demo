# 0011 — Nightly encrypted backups to the Storage Box, with a tested restore

**Date:** 2026-11-06 · **Status:** active once installed (window of 2026-11-07/08, ledger row then) · **Phase:** D.6.

## Decision

`scripts/ops/backup.sh` runs as `ops` at 02:22 UTC from `/usr/local/lib/quanttrader/`, so a rollback of the checkout cannot remove it. Each night it writes five files to `nightly/<date>/` on the Storage Box sub-account `u708205-sub1`, all encrypted with age to the public key in `ops/backup/age-recipient.txt`: a custom-format `pg_dump` of schema `public`; a second, data-only dump of `auth.users` and `auth.identities`; the host's `.env.local`; the host's unit, logrotate and sshd files, installed scripts and crontab; and `/var/log/quanttrader`. The pinned corpora go to `pins/` unencrypted, because they are public and already in git. The private key is the operator's and is never on the host, the box or in a session. Retention is 30 nights plus the box's own daily snapshots. Supabase's own backups stay as the first line: Pro plan, daily, 7-day retention, read in the dashboard on 2 November 2026, no point-in-time recovery.

The database is read by a dedicated role, `backup_ro`: login, `bypassrls`, read-only by default, three connections at most, `select` on `public` and on the two `auth` tables and nothing else. Its connection line is appended to the host's env file by the operator.

A night fails loudly and safely: every part is attempted, a checksum dry run verifies the upload, nights are pruned only after a night that fully succeeded, any failure pushes one urgent ntfy message and exits 1, and `backup.last-ok` is written only on success. The daily summary shows that stamp and turns high priority when it is older than 26 hours, which also catches a job that never ran.

## Why

The approval of 2026-10-31 asked for host config, env files encrypted at rest with the key off the box, pins and logs, a nightly `pg_dump`, 30-day retention and one tested restore. Supabase's 7 days do not cover a mistake noticed later, and they sit with the same provider as the data. `oanda_positioning_cache` is forward-only, so losing it cannot be undone by re-fetching.

## Alternatives considered

- `pg_dump` of the five operational tables only, as the plan first said: rejected. The whole schema costs little, the forward-only table is the one that cannot be rebuilt, and 15 public tables reference `auth.users`, so a restore needs that too.
- `pg_dump --schema=public --table=auth.users` in one run: not possible, `--table` makes `pg_dump` ignore `--schema`.
- The database password on the `pg_dump` command line: rejected, it would be readable in the process list. The URL is read here and passed through libpq's environment.
- The direct connection string: Supabase recommends it for `pg_dump` but it is IPv6 unless the IPv4 add-on is bought. The session pooler works from any host, which is the safer default for a job nobody watches.
- `tests/contracts/` as the drill's proof, as the plan first said: rejected, it reads migrations and never touches a database. The drill compares row counts.
- A local Postgres for the drill: rejected by the operator in favour of a Supabase branch, which also proves the dump restores onto the real migrations.

## Consequences

- `ops/crontab` gains a 12th line and `ops/logrotate/quanttrader` a 13th log.
- `ops-health.sh` changes, so its installed copy is repeated in the same step.
- The job needs no sudo; its sudoers entry at D.7 needs nothing for backups beyond what the installation used once.
- `BACKUP_DATABASE_URL` joins `.env.example`. `.env.local` on the host now holds a second database credential, read-only, and it is inside `env.tar.age`.
- Dumps hold broker tokens and password hashes, so they are decrypted only on the operator's machine, and the drill's restore leaves `broker_connections` data out so a branch never holds a token.
- The private key is a single point of failure: without it the box holds nothing readable. The operator keeps it in the password manager and one offline copy.
- With external reachability off, a restore fetches through the VPS. If the VPS is gone, turn reachability on in the panel, fetch, turn it off.

## Evidence

Database facts read 2026-11-06: PostgreSQL 17.6, 335 MB, `postgres` holds `createrole` and `bypassrls`, `select` on `auth.users` is grantable. Cost of the drill's branch from Supabase's billing docs the same day. Tests: `tests/ops/backup-script.test.ts` runs the real script against stand-ins.
