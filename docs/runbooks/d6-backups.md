# D.6 — nightly backups to the Storage Box, and the restore drill (decision 0011)

## Facts

| Item | Value |
|---|---|
| Storage Box | `u708205.your-storagebox.de`, user `u708205`, Falkenstein; SSH only, Samba/WebDAV/FTP off, external reachability off, automatic daily snapshots on |
| Sub-account for this job | `u708205-sub1`, base directory `quanttrader`, SSH on, Samba/WebDAV/FTP off, external reachability off, not read-only |
| Encryption | age, public key in `ops/backup/age-recipient.txt`; the private key is the operator's and is never on the host, the box or in a session |
| Supabase's own backups | Pro plan, daily, 7-day retention, backups listed 26 October to 2 November, read in the dashboard 2 November 2026; no point-in-time recovery |
| Database | PostgreSQL 17.6, 335 MB on 2026-11-06, of which `oanda_positioning_cache` 197 MB and `activity_log` 95 MB |
| Retention on the box | 30 nights, plus the box's own daily snapshots |

From memory, proved by step 3 below: a sub-account has its own hostname `u708205-sub1.your-storagebox.de`, port 23 serves rsync and a restricted shell, and external reachability off means only hosts inside Hetzner's network connect. That last point is why the drill fetches dumps through the VPS.

## Operator, before Sunday

**1. The read-only role, in the Supabase SQL editor.** Generate the password on your own machine (`openssl rand -hex 32`, so nothing needs URL-encoding), keep it in your password manager, paste it in place of the marker, and do not save this as a snippet. Any time; this touches the database, not the host.

```sql
create role backup_ro with login bypassrls noinherit connection limit 3 password '<paste the generated password>';
alter role backup_ro set default_transaction_read_only = on;

grant usage on schema public to backup_ro;
grant select on all tables in schema public to backup_ro;
grant select on all sequences in schema public to backup_ro;
alter default privileges for role postgres in schema public grant select on tables to backup_ro;
alter default privileges for role postgres in schema public grant select on sequences to backup_ro;

grant usage on schema auth to backup_ro;
grant select on auth.users, auth.identities to backup_ro;

-- check: one row, bypassrls true, read-only on
select rolname, rolbypassrls, rolconfig from pg_roles where rolname = 'backup_ro';
```

`bypassrls` is there because `pg_dump` refuses to run where row-level security would hide rows, and every public table has it on; `postgres` holds that attribute here, so it can grant it. The role can read and cannot write. It does not go in `supabase/migrations`: it holds a credential and is not schema the engine depends on.

**2. The connection line, on the host, after 22:00 UK on Friday.** This is a host change and the mid-week exception covers only the ping line, so it waits for the market to close. In the Supabase dashboard open Connect, choose **Session pooler**, copy the URI and change its user from `postgres.<ref>` to `backup_ro.<ref>` and its password to the generated one. Paste it only at the `read` prompt: nothing is echoed and nothing lands in the shell history.

```bash
ssh -t qt bash                                                 # bash explicitly, as in the ping block
grep -c '^BACKUP_DATABASE_URL=' /opt/quanttrader/.env.local   # 0 — if 1 or more: stop, the name exists; replacing it is not this append
read -rs -p 'BACKUP_DATABASE_URL: ' URL; echo                  # paste the URI
case "$URL" in postgresql://backup_ro.*) printf '\nBACKUP_DATABASE_URL=%s\n' "$URL" >> /opt/quanttrader/.env.local ;; *) echo 'no backup_ro URI read; nothing written' ;; esac; unset URL
# the guard writes nothing on an empty or wrong paste; the leading newline keeps the line whole
grep -c '^BACKUP_DATABASE_URL=postgresql://backup_ro' /opt/quanttrader/.env.local   # 1
exit
```

No restart: the app does not read this name. Tell the session the time; the ledger row goes in with step 8's.

## Window steps, as `ops`, market closed

Step 8 of the window plan, after the deploy, the reboot and the paper re-test. Open one control master first (`Host qt` does this) and go on only if the previous step printed what it says.

```bash
# 1. Tools: neither is installed yet. pg_dump must be 17 or newer, because the server is 17.6.
ssh qt 'sudo -n apt-get install -y postgresql-client age && pg_dump --version && age --version'

# 2. The job's key, on the host only. The public line goes to the operator, who adds it to u708205-sub1.
ssh qt 'ssh-keygen -q -t ed25519 -N "" -C quanttrader-prod-backup -f ~/.ssh/quanttrader_backup && cat ~/.ssh/quanttrader_backup.pub'

# 3. Pin the box's host key, compare it with the fingerprints Hetzner publishes, then prove the login.
ssh qt 'ssh-keyscan -p 23 u708205-sub1.your-storagebox.de > ~/.ssh/known_hosts_storagebox && ssh-keygen -lf ~/.ssh/known_hosts_storagebox'
ssh qt 'ssh -p 23 -i ~/.ssh/quanttrader_backup -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts_storagebox u708205-sub1@u708205-sub1.your-storagebox.de mkdir nightly pins'

# 4. Install, from the merged dev, which the deploy has put in the checkout. Root-owned, as D.4's scripts are.
ssh qt 'cd /opt/quanttrader && sudo -n install -m 755 scripts/ops/backup.sh scripts/ops/ops-health.sh /usr/local/lib/quanttrader/ && sudo -n install -m 644 ops/backup/age-recipient.txt /usr/local/lib/quanttrader/backup-age-recipient.txt && sudo -n install -m 644 ops/logrotate/quanttrader /etc/logrotate.d/quanttrader'

# 5. The crontab, 12 entries, right after a tick.
ssh qt 'crontab /opt/quanttrader/ops/crontab && crontab -l | grep -c "^[0-9*]"'

# 6. The first run, by hand. Expect one "OK nightly/<date>" line and no push.
ssh qt 'bash /usr/local/lib/quanttrader/backup.sh | tee -a /var/log/quanttrader/backup.log'
ssh qt 'ssh -p 23 -i ~/.ssh/quanttrader_backup -o IdentitiesOnly=yes -o UserKnownHostsFile=~/.ssh/known_hosts_storagebox u708205-sub1@u708205-sub1.your-storagebox.de ls -la nightly/$(date -u +%F)'
```

Then the restore drill below, then one ledger row for all of it. The nightly run is at 02:22 UTC, a minute no tick uses. The next daily summary shows `backup=<time>` and turns high priority if the last good night is older than 26 hours.

**Rollback**, in reverse: `crontab` from the previous `ops/crontab`; remove `backup.sh`, `backup-age-recipient.txt` and `~/.ssh/quanttrader_backup*`; remove the `BACKUP_DATABASE_URL` line by hand; `drop role backup_ro` after `revoke`; `apt-get remove postgresql-client age`. Nothing on the trading path reads any of this.

## Restore drill

Twice a year and before any schema change; the first one is step 8 of the window. It proves that the newest dump can be decrypted and restored, not just that a file exists. `tests/contracts/` does not help here: it reads migrations, not a database, so the proof is row counts.

**Cost, quoted 2026-11-06:** a Micro preview branch is $0.01344 per started hour; Compute Credits do not cover it and the Spend Cap does not apply. Three hours is about $0.04, and egress on a 335 MB database stays within the plan. Delete the branch when done.

**The operator runs steps 2 to 5 in their own terminal.** A decrypted dump holds broker tokens and password hashes, and it does not enter a session. `broker_connections` data is left out of the restore so that the branch never holds a token.

```bash
# 1. Fetch through the VPS, because the box accepts only Hetzner hosts. The files are still encrypted.
NIGHT=$(date -u +%F)
ssh qt "mkdir -p /tmp/qt-drill && rsync -a -e 'ssh -p 23 -i ~/.ssh/quanttrader_backup -o IdentitiesOnly=yes -o UserKnownHostsFile=~/.ssh/known_hosts_storagebox' u708205-sub1@u708205-sub1.your-storagebox.de:nightly/$NIGHT/ /tmp/qt-drill/"
mkdir -p ~/qt-drill && scp 'qt:/tmp/qt-drill/db-*.age' ~/qt-drill/ && ssh qt 'rm -rf /tmp/qt-drill'

# 2. Decrypt, off the box, with the private key. libpq gives a pg_restore as new as the host's pg_dump.
brew install libpq; PGBIN=$(brew --prefix libpq)/bin; cd ~/qt-drill
age -d -i <your age key file> -o public.dump db-public.dump.age
age -d -i <your age key file> -o auth.dump db-auth.dump.age

# 3. Data only: the branch already has the schema from supabase/migrations. Leave out the tokens.
"$PGBIN/pg_restore" --list public.dump | grep -v 'TABLE DATA public broker_connections' > drill.list
"$PGBIN/pg_restore" --data-only --no-owner --no-privileges --use-list=drill.list --file=public.sql public.dump
"$PGBIN/pg_restore" --data-only --no-owner --no-privileges --file=auth.sql auth.dump

# 4. Into the branch, whose connection string comes from the dashboard after it is created.
"$PGBIN/psql" "<branch connection string>" --single-transaction --variable ON_ERROR_STOP=1 \
  --command 'SET session_replication_role = replica' --file=auth.sql --file=public.sql
```

```sql
-- 5. The same query on the branch and on production. Production may have moved on since 02:22 UTC, so
-- its counts may be higher by that day's rows; a branch count higher than production is a failure.
select 'algorithms' as t, count(*) from public.algorithms
union all select 'paper_positions', count(*) from public.paper_positions
union all select 'activity_log', count(*) from public.activity_log
union all select 'llm_decisions', count(*) from public.llm_decisions
union all select 'oanda_positioning_cache', count(*) from public.oanda_positioning_cache
union all select 'auth.users', count(*) from auth.users;
```

6. Delete the branch and `rm -rf ~/qt-drill`.
7. Send the session the two sets of counts and the cost shown on the usage page. It writes `docs/decisions/evidence/d6-restore-drill-<date>.md`, counts only, and the ledger row, and decision 0011 gets its Tested line.
