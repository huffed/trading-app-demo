# Runbook — rotate `CRON_SECRET`

**When:** after any suspected exposure. **Last run 2026-10-29** (the 2026-10-28 inventory had found the value in plaintext in a local Claude Code allow-rule; the rule is deleted, the value is changed) — the non-interactive variant in §5 is what ran.
**Time:** ~5 minutes. **Risk:** one missed cron tick if the restart lands on a tick boundary — do it at minute 1–3 of a 5-minute window.
**Who holds it today (verified read-only on the VPS, 2026-10-28):** `/opt/quanttrader/.env.local` on the VPS (the app reads it at start; every cron wrapper greps it on each run — `scripts/scan-cron.sh:22`), and your local `.env.local` (only used when you run the wrappers against `pnpm dev`). GitHub Actions does **not** use it (the dead-man workflow uses the Supabase anon key).

## 1. Generate (on your Mac)

```bash
NEW_SECRET=$(openssl rand -hex 32)
echo "$NEW_SECRET"        # keep this terminal open; you will paste it once on the VPS
```

## 2. Install on the VPS, restart, verify

```bash
ssh qt                    # the Host alias from ~/.ssh/config (see harden-vps-ssh.md §0); lands as ops
sudo -i                   # root can edit the env file whatever its owner (ops since D.2; root before)
```

On the VPS, as root via `sudo -i` (`perl -pi` and `cp -p` keep the file's owner, so this works before and after D.2):

```bash
cd /opt/quanttrader
cp -p .env.local .env.local.rotating        # keeps 0600 root; holds the OLD value until step 3 passes
read -rs -p "New CRON_SECRET: " NEW; echo    # paste the value from step 1; nothing is echoed or logged
export NEW
perl -pi -e 's/^CRON_SECRET=.*/CRON_SECRET=$ENV{NEW}/' .env.local   # reads NEW from the environment, not argv
grep -c "^CRON_SECRET=${NEW}$" .env.local    # expect: 1

# Restart between ticks: wait until `date +%M` ends in 1, 2 or 3.
systemctl restart quanttrader && sleep 10 && systemctl is-active quanttrader   # expect: active

# The route must accept the new value and reject the old one:
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer ${NEW}"  http://localhost:3000/api/cron/heartbeat   # expect: 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer stale"   http://localhost:3000/api/cron/heartbeat   # expect: 401
```

## 3. Confirm one real cron call, then clean up

Wait for the next 5-minute tick, then:

```bash
tail -n 2 /var/log/quanttrader/manage.log     # expect: ... http=200 ...
tail -n 2 /var/log/quanttrader/heartbeat.log  # expect: http=200 (a stale_count line is normal)
rm /opt/quanttrader/.env.local.rotating       # it holds the OLD secret
unset NEW; history -c
exit
```

If `manage.log` shows `http=401`, the wrapper is reading a different file than the app: `grep -n "ENV_FILE=" /opt/quanttrader/scripts/manage-cron.sh` must point at `/opt/quanttrader/.env.local`.

## 4. Local `.env.local` (Mac)

```bash
cd ~/Documents/trading-app/demo-1
perl -pi -e 's/^CRON_SECRET=.*/CRON_SECRET=$ENV{NEW_SECRET}/' .env.local
grep -c "^CRON_SECRET=${NEW_SECRET}$" .env.local   # expect: 1
unset NEW_SECRET
```

Restart `pnpm dev` if it is running. Done — nothing else references the value.

## Verification checklist

- [ ] VPS `.env.local` has the new value (step 2 grep = 1)
- [ ] service active; heartbeat route 200 with new, 401 with stale
- [ ] one scheduled manage tick logged `http=200` after the restart
- [ ] `.env.local.rotating` removed
- [ ] local `.env.local` updated

## 5. Non-interactive variant (used 2026-10-29; the value never touches a terminal, a log or argv)

The script below runs as root on the VPS and reads the new value from **stdin**. Copy it to the VPS, pipe the secret in, let it wait for the between-ticks window itself:

```bash
# on your Mac
scp rotate.sh qt:/tmp/rotate.sh
NEW=$(openssl rand -hex 32); export NEW
printf '%s\n' "$NEW" | ssh qt 'sudo -n bash /tmp/rotate.sh; rc=$?; rm -f /tmp/rotate.sh; exit $rc'
perl -pi -e 's/^CRON_SECRET=.*/CRON_SECRET=$ENV{NEW}/' .env.local      # local copy, this key only
grep -c "^CRON_SECRET=${NEW}\$" .env.local                               # expect: 1
unset NEW
```

`rotate.sh` (no secret inside it):

```bash
#!/bin/bash
set -euo pipefail
IFS= read -r NEW; export NEW
cd /opt/quanttrader
cp -p .env.local .env.local.rotating
perl -pi -e 's/^CRON_SECRET=.*/CRON_SECRET=$ENV{NEW}/' .env.local
echo "new value present: $(grep -c "^CRON_SECRET=${NEW}\$" .env.local) (expect 1)"
while :; do m=$((10#$(date +%M) % 5)); [ "$m" -ge 1 ] && [ "$m" -le 3 ] && break; sleep 10; done   # between ticks
systemctl restart quanttrader; sleep 12; echo "service: $(systemctl is-active quanttrader)"
echo "new → $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${NEW}" http://localhost:3000/api/cron/heartbeat) (expect 200)"
echo "stale → $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer stale' http://localhost:3000/api/cron/heartbeat) (expect 401)"
```

Then step 3 as above (wait for the next tick, `sudo tail -n1 /var/log/quanttrader/manage.log` → `http=200`, `sudo rm /opt/quanttrader/.env.local.rotating`). On 2026-10-29 this ran at 09:21:04Z; the 09:25:01Z tick logged `http=200`.
