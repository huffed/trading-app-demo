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

From Hetzner's docs, read 2026-11-06: a sub-account has its own hostname `u708205-sub1.your-storagebox.de` and its own `authorized_keys`; port 23 serves rsync and a restricted shell that lists `rm`; `install-ssh-key` works in sub-accounts; without external reachability only hosts inside Hetzner's network connect. That last point is why the key install and the drill go through the VPS. The docs do not show `rm -r`, which the prune uses, so window step 5 proves it.

## Operator, before Sunday

**1. The read-only role, in the Supabase SQL editor, on production.** No password here: the role cannot log in until step 2. Any time; this touches the database, not the host.

```sql
create role backup_ro with login bypassrls noinherit connection limit 3;
alter role backup_ro set default_transaction_read_only = on;
grant pg_read_all_data to backup_ro with inherit true, set false;

-- check: one row, every column true
select rolbypassrls,
       has_schema_privilege('backup_ro', 'auth', 'usage') as auth_schema,
       has_table_privilege('backup_ro', 'auth.users', 'select') as auth_users,
       has_table_privilege('backup_ro', 'auth.identities', 'select') as auth_identities,
       has_table_privilege('backup_ro', 'public.paper_positions', 'select') as reads_public,
       not has_table_privilege('backup_ro', 'public.paper_positions', 'insert') as cannot_write
from pg_roles where rolname = 'backup_ro';
```

`pg_read_all_data` is Postgres's built-in read-only role, and it covers tables added later. It is needed because `postgres` here cannot grant usage on schema `auth` (read 2026-11-06), so a plain `grant usage on schema auth` would succeed with a warning and do nothing. `postgres` holds that role with admin rights, so it can grant it. `bypassrls` is there because `pg_dump` refuses to run where row-level security would hide rows, and every public table has it on. The role reads everything in the database, including `broker_connections` tokens and password hashes, and cannot write. It does not go in `supabase/migrations`: it is not schema the engine depends on.

**2. Its password, from your own terminal.** Do not set it in the SQL editor: `log_statement` is `ddl` here (read 2026-11-06), so a `create role … password` statement reaches the database log in the clear, and the editor can keep it. `\password` hashes it on your machine first. Generate it, keep it in your password manager, and paste it at the two prompts. In the dashboard open Connect, choose **Session pooler**, copy the URI and delete `:[YOUR-PASSWORD]` from it, so `psql` asks for the `postgres` password and it stays out of your shell history. If you do not have that password, stop and ask the session: resetting it in the dashboard is a production change.

```bash
openssl rand -hex 32     # no URL-encoding needed; into the password manager, not a file
brew install libpq       # also used by the drill
"$(brew --prefix libpq)/bin/psql" "<session pooler URI, without the password>"
```

```text
\password backup_ro
\q
```

**3. The connection line, on the host, after 22:00 UK on Friday.** This is a host change and the mid-week exception covers only the ping line, so it waits for the market to close. Take the same URI, change its user from `postgres.<ref>` to `backup_ro.<ref>`, and put the generated password in its place. Paste it only at the `read` prompt: nothing is echoed and nothing lands in the shell history.

```bash
ssh -t qt bash                                                 # bash explicitly, as in the ping block
grep -c '^BACKUP_DATABASE_URL=' /opt/quanttrader/.env.local   # 0 — if 1 or more: stop, the name exists; replacing it is not this append
read -rs -p 'BACKUP_DATABASE_URL: ' URL; echo                  # paste the URI
case "$URL" in *'['*) echo 'placeholder left in the URI; nothing written' ;; postgresql://backup_ro.*:5432/*) printf '\nBACKUP_DATABASE_URL=%s\n' "$URL" >> /opt/quanttrader/.env.local ;; *) echo 'no backup_ro URI on port 5432 read; nothing written' ;; esac; unset URL
# the guard writes nothing on an empty or wrong paste; the leading newline keeps the line whole
grep -c '^BACKUP_DATABASE_URL=postgresql://backup_ro' /opt/quanttrader/.env.local   # 1
exit
```

No restart: the app does not read this name. Tell the session the time; the ledger row goes in with the window's.

## Window steps, as `ops`, market closed

**Before step 1:** `make status` shows the service active and the crontab at 11, and `make logs LOG=ops-health N=2` shows `held-by-kill-switch=0` on its summary line. Step 7 replaces the crontab, which must not happen while a kill switch is engaged: it would bring the crons back with the saved copy still on disk.

Window plan step 8 (`docs/PHASE_D_PLAN.md`). **First merge this PR and run `git fetch origin`, then run these from a workstation checkout of `origin/dev`** (`git switch --detach origin/dev`). As in D.4, nothing here depends on the commit the host's checkout holds, so no extra deploy is needed. The crontab and installed copies are ahead of the host's checkout until the next deploy, which is harmless.

`Host qt` in `~/.ssh/config` holds one control master (`ControlMaster auto`, added 2026-11-01), so these connections count as one against `ufw limit`. Go on only if the previous step printed what it says.

```bash
# 1. Tools: postgresql-client and age are not installed yet. pg_dump must be 17 or newer: the server is 17.6.
ssh qt 'sudo -n apt-get update -qq && sudo -n apt-get install -y postgresql-client age && pg_dump --version && age --version && rsync --version | head -n 1'

# 2. The job's key, on the host only.
ssh qt 'ssh-keygen -q -t ed25519 -N "" -C quanttrader-prod-backup -f ~/.ssh/quanttrader_backup && cat ~/.ssh/quanttrader_backup.pub'

# 3. Pin the box's host key, and compare it with the fingerprints Hetzner publishes.
ssh qt 'ssh-keyscan -p 23 u708205-sub1.your-storagebox.de > ~/.ssh/known_hosts_storagebox && ssh-keygen -lf ~/.ssh/known_hosts_storagebox'
```

**4. The operator installs that key on the sub-account,** from the VPS, because the box accepts only Hetzner hosts. The sub-account's password goes in at the prompt and nowhere else.

```bash
ssh -t qt bash
ssh -p 23 -o PubkeyAuthentication=no -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts_storagebox u708205-sub1@u708205-sub1.your-storagebox.de install-ssh-key < ~/.ssh/quanttrader_backup.pub
exit
```

If `install-ssh-key` is refused, stop and tell the session; Hetzner's key page has a manual route.

```bash
# 5. Prove the key, and the recursive delete the prune needs. Stop if rm -r is refused: the prune would fail from night 31.
ssh qt 'B="ssh -p 23 -i ~/.ssh/quanttrader_backup -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts_storagebox u708205-sub1@u708205-sub1.your-storagebox.de"; $B mkdir nightly pins probe && $B mkdir probe/inner && $B rm -r probe && $B ls'   # nightly pins

# 6. Install, root-owned, as D.4's scripts are. Dry run parses: 13, one per log. A rebuild after the verify-full
# section below also installs ops/backup/prod-ca-2021.crt, or every night fails with database-ca.
scp scripts/ops/backup.sh scripts/ops/ops-health.sh ops/backup/age-recipient.txt ops/logrotate/quanttrader ops/crontab qt:/tmp/
ssh qt 'sudo -n install -m 755 /tmp/backup.sh /tmp/ops-health.sh /usr/local/lib/quanttrader/ && sudo -n install -m 644 /tmp/age-recipient.txt /usr/local/lib/quanttrader/backup-age-recipient.txt && sudo -n install -m 644 /tmp/quanttrader /etc/logrotate.d/quanttrader && sudo -n logrotate -d /etc/logrotate.d/quanttrader 2>&1 | grep -c "considering log"'

# 7. The crontab, 12 entries, right after a tick.
ssh qt 'crontab /tmp/crontab && crontab -l | grep -c "^[0-9*]"'

# 8. The first run, by hand. Expect one "OK nightly/<date>" line and no push; the listing shows six files, OK among them.
ssh qt 'bash /usr/local/lib/quanttrader/backup.sh | tee -a /var/log/quanttrader/backup.log'
ssh qt 'ssh -p 23 -i ~/.ssh/quanttrader_backup -o IdentitiesOnly=yes -o UserKnownHostsFile=~/.ssh/known_hosts_storagebox u708205-sub1@u708205-sub1.your-storagebox.de ls -la nightly/$(date -u +%F)'
```

Then the restore drill below, then one ledger row for all of it. The nightly run is at 02:22 UTC, a minute no tick uses. The next daily summary shows `backup=<time>` and turns high priority if the last good night is older than 26 hours.

**Rollback**, in reverse: `crontab` from the previous `ops/crontab`; remove `backup.sh`, `backup-age-recipient.txt` and `~/.ssh/quanttrader_backup*`; remove the `BACKUP_DATABASE_URL` line by hand; `apt-get remove postgresql-client age`; and in the SQL editor:

```sql
revoke pg_read_all_data from backup_ro;
drop role backup_ro;
```

Nothing on the trading path reads any of this.

## `verify-full`, in the 14–15 November window

The job connected with `PGSSLMODE=require` from 2026-11-07: encrypted, but nothing checked that the server was Supabase. The operator tested `verify-full` with Supabase's root CA (`prod-ca-2021.crt`, the Supabase Root 2021 CA, valid to 2031-04-26) through the session pooler as `backup_ro` on 2026-11-10. The certificate is `ops/backup/prod-ca-2021.crt`, and its SHA-256 fingerprint is:

`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`

The session copied it from the operator's `~/Downloads/prod-ca-2021.crt` (byte-identical, checked with `cmp`). `backup.sh` reads its installed copy and refuses to dump without it. This comes before the sudoers narrowing (D-23) in the same window, which may refuse step 2's `sudo -n install`. After the PR merges, from a workstation checkout of `origin/dev`, as `ops`:

```bash
# 1. Both files to the host.
scp scripts/ops/backup.sh ops/backup/prod-ca-2021.crt qt:/tmp/
# 2. Install only if the copy on the host has the fingerprint above; the last line prints 1 for the new backup.sh.
ssh qt 'openssl x509 -in /tmp/prod-ca-2021.crt -noout -fingerprint -sha256 | grep -qi "=80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA$" && sudo -n install -m 644 /tmp/prod-ca-2021.crt /usr/local/lib/quanttrader/supabase-prod-ca-2021.crt && sudo -n install -m 755 /tmp/backup.sh /usr/local/lib/quanttrader/ && grep -c "PGSSLMODE=verify-full" /usr/local/lib/quanttrader/backup.sh'
# 3. One run by hand, as in step 8: "db-public ok" and "db-auth ok", one "OK nightly/<date>" line, no push.
ssh qt 'bash /usr/local/lib/quanttrader/backup.sh | tee -a /var/log/quanttrader/backup.log'
```

If step 2 prints nothing, the fingerprint did not match and nothing was installed: stop and tell the session. After step 3, a ledger row that says `verify-full` is installed and that the nights from 2026-11-07 to this one ran with `require`.

**Rollback,** if step 3 fails on the certificate (the night has pushed and nothing was pruned): put back the `require` script from the commit before this PR's merge, and run one night by hand.

```bash
git show <merge-commit>^:scripts/ops/backup.sh > /tmp/backup.sh
scp /tmp/backup.sh qt:/tmp/
ssh qt 'sudo -n install -m 755 /tmp/backup.sh /usr/local/lib/quanttrader/ && grep -c "PGSSLMODE=require" /usr/local/lib/quanttrader/backup.sh'
ssh qt 'bash /usr/local/lib/quanttrader/backup.sh | tee -a /var/log/quanttrader/backup.log'
```

The certificate can stay installed. Add a ledger row for the rollback with what step 3 printed. `dev` still holds `verify-full`, so the next install of `backup.sh` from it would bring it back: revert this PR on `dev`, or record the rollback in D-35 before the next install.

## Restore drill

Twice a year and before any schema change; the first one is step 8 of the window. It proves that the newest whole night can be decrypted and restored, not just that a file exists. `tests/contracts/` does not help here: it reads migrations, not a database, so the proof is row counts.

**It does not rely on the branch's schema.** A branch is built by replaying production's recorded migrations, not `supabase/migrations`, and Supabase's troubleshooting page says a failed replay leaves it "either empty or partly complete". Production records 55 migrations against 52 files, and recorded `00051` revokes on `public.rls_auto_enable()`, which belongs to the dashboard's `ensure_rls` event trigger and is in no migration, so the replay may stop there (DEBT D-34). So step 5 clears `public` on the branch and loads schema and data from the dump. That proves the dump loads. A real restore differs: see the end of this section.

**Cost, quoted 2026-11-06:** a Micro preview branch is $0.01344 per started hour; Compute Credits do not cover it and the Spend Cap does not apply. Three hours is about $0.04, and egress on a 335 MB database stays within the plan. Delete the branch when done.

**The operator runs steps 3 to 5 and step 6a in their own terminal.** A decrypted dump holds broker tokens and password hashes, and it does not enter a session. `broker_connections` data is left out of the restore so that the branch never holds a token, and with it the two foreign keys that point at that table.

**1. Create the branch in the dashboard:** user menu, enable **Branching via dashboard**, then **Create branch** in the branch selector. Do not connect GitHub: changes pushed to a connected branch deploy to the project, and draft PR #291's migration is unapplied. A `MIGRATIONS_FAILED` status is expected and is not a drill failure. Supabase's page does not say whether such a branch accepts connections, so if it refuses them at step 5, stop and tell the session rather than retrying. A DNS or routing error is your network, not the branch's state. Copy the branch's **Session pooler** connection string, not the direct one, which may be IPv6 only.

The branch has its own credentials, not production's (Supabase: each branch has unique credentials), so this drill does not need the `postgres` password from step 3b. If the string shows `[YOUR-PASSWORD]`, take only the password from `supabase --experimental branches get <branch> -o env`, run in your own terminal and never in a session, since it prints the branch's credentials (its `POSTGRES_URL_NON_POOLING` is the direct string, so keep the Session pooler host above), or reset the password in the dashboard's Database Settings **with the branch selector on the branch, not production**. Neither has been tried here. A wrong password at step 5 prints the STOP line too.

```bash
# 2. Fetch through the VPS, because the box accepts only Hetzner hosts. The files are still encrypted.
# The night must have an OK file, or it was not whole: use the newest night that has one (for another night,
# put its date in place of $(date -u +%F)). Everything inside the single quotes runs on the host, so a
# session's Bash guard sees one plain ssh qt (docs/DEV_SETUP.md §17).
ssh qt 'B="ssh -p 23 -i ~/.ssh/quanttrader_backup -o IdentitiesOnly=yes -o UserKnownHostsFile=~/.ssh/known_hosts_storagebox"; $B u708205-sub1@u708205-sub1.your-storagebox.de ls nightly/$(date -u +%F)/OK'
ssh qt 'B="ssh -p 23 -i ~/.ssh/quanttrader_backup -o IdentitiesOnly=yes -o UserKnownHostsFile=~/.ssh/known_hosts_storagebox"; mkdir -p /tmp/qt-drill && rsync -a -e "$B" u708205-sub1@u708205-sub1.your-storagebox.de:nightly/$(date -u +%F)/ /tmp/qt-drill/'
mkdir -p ~/qt-drill && scp 'qt:/tmp/qt-drill/*.age' ~/qt-drill/ && ssh qt 'rm -rf /tmp/qt-drill'

# 3. Decrypt the dumps, off the box, with the private key. The archives open too: names only, never contents.
# First check that the disk is encrypted, because a deleted file is not overwritten on macOS 27: rm -P has no
# effect there (man rm), so FileVault is what protects the freed blocks.
fdesetup status                                          # must say: FileVault is On
# Save the private key from your password manager as ~/qt-drill/key.txt, mode 600, for these lines only.
PGBIN=$(brew --prefix libpq)/bin; cd ~/qt-drill
age -d -i ~/qt-drill/key.txt -o public.dump db-public.dump.age
age -d -i ~/qt-drill/key.txt -o auth.dump db-auth.dump.age
age -d -i ~/qt-drill/key.txt env.tar.age | tar -tf -      # .env.local
age -d -i ~/qt-drill/key.txt host.tar.age | tar -tf -     # unit files, scripts, crontab.txt
age -d -i ~/qt-drill/key.txt logs.tar.age | tar -tzf - | wc -l
rm ~/qt-drill/key.txt                                    # the temporary copy goes now, not at step 7

# 4. Build the two restore scripts. Left out: the tokens, the two foreign keys that would then fail,
# and the schema's own entry, which already exists.
"$PGBIN/pg_restore" --list public.dump | grep -v -E 'TABLE DATA public broker_connections|FK CONSTRAINT public (algorithms|portfolios) [a-z_]*broker_connection_id_fkey|SCHEMA - public ' > drill.list
"$PGBIN/pg_restore" --no-owner --no-privileges --use-list=drill.list --file=public.sql public.dump
"$PGBIN/pg_restore" --data-only --no-owner --no-privileges --file=auth.sql auth.dump

# 5. Into the branch. The check is what keeps the drop away from production: production has users, a fresh
# branch has none, and no answer stops it too. Paste the branch's URI at the prompt.
printf 'Branch URI: '; stty -echo; IFS= read -r U; stty echo; echo
if [ "$("$PGBIN/psql" -X "$U" -Atc 'select count(*) from auth.users')" = 0 ]; then
  "$PGBIN/psql" -X "$U" --variable ON_ERROR_STOP=1 --command 'drop schema if exists public cascade' --command 'create schema public' &&
  "$PGBIN/psql" -X "$U" --single-transaction --variable ON_ERROR_STOP=1 \
    --command 'SET session_replication_role = replica' --file=auth.sql --file=public.sql
else
  echo 'STOP: this database has users or did not answer, so it is not an empty branch.'
fi
unset U
# Whatever step 5 printed: delete the decrypted dumps and SQL now. They hold the broker tokens and the password
# hashes, the biggest exposure in the drill. A retry repeats steps 3 to 5, with the key file saved again; the
# .age files stay until step 7.
rm -f ~/qt-drill/public.dump ~/qt-drill/auth.dump ~/qt-drill/public.sql ~/qt-drill/auth.sql
```

```bash
# 6a. The counts on the branch, in your terminal. Paste the branch's URI again.
printf 'Branch URI: '; stty -echo; IFS= read -r U; stty echo; echo
"$PGBIN/psql" -X "$U" -At -F ' ' <<'SQL'
select 'algorithms' as t, count(*) from public.algorithms
union all select 'paper_positions', count(*) from public.paper_positions
union all select 'activity_log', count(*) from public.activity_log
union all select 'llm_decisions', count(*) from public.llm_decisions
union all select 'oanda_positioning_cache', count(*) from public.oanda_positioning_cache
union all select 'broker_connections', count(*) from public.broker_connections
union all select 'auth.users', count(*) from auth.users;
SQL
unset U
```

```sql
-- 6b. The same query on production, in the SQL editor, with the branch selector back on production.
-- broker_connections tells them apart: production has rows (7 on 2026-11-06), the branch reads 0 by design.
-- If this reads 0, the editor is on the branch: switch the selector and run it again.
-- Production may have moved on since 02:22 UTC, so its counts may be higher by that day's rows;
-- a branch count higher than production is a failure.
select 'algorithms' as t, count(*) from public.algorithms
union all select 'paper_positions', count(*) from public.paper_positions
union all select 'activity_log', count(*) from public.activity_log
union all select 'llm_decisions', count(*) from public.llm_decisions
union all select 'oanda_positioning_cache', count(*) from public.oanda_positioning_cache
union all select 'broker_connections', count(*) from public.broker_connections
union all select 'auth.users', count(*) from auth.users;
```

7. Delete the branch, then `ls ~/qt-drill`: only the five `.age` files and `drill.list` should be left, because the key copy went after step 3 and the dumps after step 5. Then `rm -rf ~/qt-drill`. The first drill left both on the workstation for three days (`docs/decisions/evidence/d6-restore-drill-2026-11-07.md`).
8. Send the session the two sets of counts, the branch's status after step 1 and the cost shown on the usage page. It writes `docs/decisions/evidence/d6-restore-drill-<date>.md`, the counts and the branch status only, and the ledger row, and decision 0011 gets its Tested line.

Step 5's `SET session_replication_role = replica` should be allowed for `postgres`: `set local session_replication_role = origin` worked on production in a rolled-back transaction on 2026-11-06, while the `set_config` function is refused. If the drill refuses it, the transaction rolls back and nothing is left half-loaded.

**A real restore is not the drill.** The drill proves the schema and data load, as `postgres`, on a throwaway database. This outline for a new project has never been run:

1. Keep `public`, because dropping it loses the schema's grants and default privileges. Leave out only the `SCHEMA - public` entry.
2. Restore `auth` first, then `public`, with the same `SET`, and with `broker_connections` data and its two foreign keys this time.
3. Drop `--no-privileges` from `pg_restore`: the dump keeps the access rules, including `revoke execute` on `prune_sentiment_cache` and the anon grants the dead-man uses.
4. Afterwards, recreate what neither dump holds: the trigger `on_auth_user_created` (`supabase/migrations/00001_create_profiles.sql:30-32`), which needs the restored `public.handle_new_user()`, and the `ensure_rls` event trigger.

From memory, two things may stop it in one transaction: `alter default privileges` entries for `supabase_admin`, which `postgres` may be refused, and a `public.rls_auto_enable` a new project may already have. Filter those entries out of the list if so.
