# D.4 — alerts from the host, log rotation, nightly gate (decision 0009)

Host steps, as `ops` with `sudo -n`, outside market hours, after the D.4 PR is merged. **None of them restarts the service**, and none depends on the commit the checkout holds: the two scripts the host runs on its own are installed to `/usr/local/lib/quanttrader/` (root-owned), so a rollback to a commit that predates them changes nothing. One ledger row for all of them.

```bash
make status                                                    # pre-flight: service active, ticks 200, crontab 10
scp scripts/ops/notify-failure.sh scripts/ops/ops-health.sh ops/logrotate/quanttrader ops/systemd/quanttrader.service ops/crontab qt:/tmp/
ssh qt 'sudo -n install -d -m 755 /usr/local/lib/quanttrader && sudo -n install -m 755 /tmp/notify-failure.sh /tmp/ops-health.sh /usr/local/lib/quanttrader/ && ls -la /usr/local/lib/quanttrader/'
ssh qt 'sudo -n install -m 644 /tmp/quanttrader /etc/logrotate.d/quanttrader && sudo -n logrotate -d /etc/logrotate.d/quanttrader 2>&1 | grep -c "considering log"'   # dry run parses: 12 (one per listed log)
ssh qt 'sudo -n install -m 644 /tmp/quanttrader.service /etc/systemd/system/quanttrader.service && sudo -n systemctl daemon-reload && systemctl show quanttrader -p SuccessExitStatus -p ExecStopPost --value | cut -c1-120 && systemctl is-active quanttrader'   # 143 … notify-failure.sh …; active (the running process is untouched)
ssh qt 'crontab /tmp/crontab && crontab -l | grep -c "^[0-9*]"'   # 11 — right after a tick, as in the D.2 runbook step 5
ssh qt 'bash /usr/local/lib/quanttrader/ops-health.sh'            # one summary push now, as a test; the next is 07:05 UTC
ssh qt 'SERVICE_RESULT=test EXIT_CODE=exited EXIT_STATUS=1 bash /usr/local/lib/quanttrader/notify-failure.sh quanttrader'   # one urgent test push ("result=test") — tell the operator first
```

The nightly workflow needs nothing on the host; it runs on `dev` at 03:17 UTC from the next night (`gh workflow run nightly.yml --ref dev` runs it now). `HEARTBEAT_PING_URL` is the operator's step (done 2026-11-06, ledger row `2026-11-06T12:30Z`; kept here for a rotated URL, which is a new decision because this block only appends) and the one host change besides the kill switch allowed in market hours (operator decision 2026-11-02, a standing exception: **appending** that one line to the env file — never editing a line — read by `scripts/heartbeat-cron.sh` on the next tick, no restart, and its failure mode is a missing ping, not a trading change). Create a check at healthchecks.io (period 5 minutes, grace 15 minutes: the heartbeat ticks every 5 minutes), copy its ping URL, then on the host as `ops`, pasting the URL only into the `read` prompt (never through chat; nothing is echoed and nothing lands in the shell history):

```bash
ssh -t qt bash                                                # bash explicitly: ops's login shell may be dash, which has no `read -s`
grep -c '^HEARTBEAT_PING_URL=' /opt/quanttrader/.env.local   # 0 — if 1 or more: stop, the name exists; replacing it is not this append
read -rs -p 'HEARTBEAT_PING_URL: ' URL; echo                  # paste the URL
case "$URL" in https://?*) printf '\nHEARTBEAT_PING_URL=%s\n' "$URL" >> /opt/quanttrader/.env.local ;; *) echo 'no https URL read; nothing written' ;; esac; unset URL
# the guard writes nothing on an empty or wrong paste; the leading newline keeps the line whole even if the file did not end with one (a blank line is harmless to every reader)
grep -c '^HEARTBEAT_PING_URL=https://' /opt/quanttrader/.env.local   # 1
exit
make logs LOG=heartbeat N=1   # after the next tick (every 5 min): "healthy — dead-man ping sent"
```

What "down" means on that check: the wrapper pings only on a 200 with `stale_count` 0, so healthchecks.io calls the host down (period 5 + grace 15, about 20 minutes after the last ping) on any non-200; when any active algorithm has gone unscanned for 90 minutes — including a halt day, because a daily-loss or portfolio halt leaves the algorithm active and unscanned until 00:00 UTC, so the check goes down about 110 minutes after the last completed scan (about 95 after the halt tick) and stays down until the first scan after midnight while the GitHub dead-man stays green by design; while the kill switch is engaged (the crontab is gone, so down after about 20 minutes, before the dead-man's 35–45); or on a failed ping. While the crons run, `make logs LOG=heartbeat N=1` then shows `unhealthy (stale_count=…) — withholding dead-man ping`, `unhealthy (server/auth failure) — withholding dead-man ping`, or `healthy locally but dead-man ping FAILED (network?)` (a leftover placeholder, a wrong URL, or egress); during a kill switch no new line is written, so the last line is from before the stop.

Then one ledger row (`HEARTBEAT_PING_URL appended on the host`, the time, the heartbeat line as the read-only check); the healthchecks.io dashboard shows the first ping within five minutes. If the heartbeat line still says the variable is not set, the line went to the wrong file or the name is misspelt: `grep -n '^HEARTBEAT' /opt/quanttrader/.env.local | cut -d= -f1` shows the line number and name only, and `grep '^HEARTBEAT_PING_URL=' /opt/quanttrader/.env.local | cut -d= -f2- | cut -c1-20` shows the value's shape without printing it (the value is a secret; it never goes into chat).

When `scripts/ops/notify-failure.sh` or `ops-health.sh` change in the repo, repeat the `install` line: the host runs the installed copies, not the checkout's.

Verification: `make logs LOG=ops-health N=2` after 07:05 UTC the next day (done 2026-11-02: logged and pushed); the two test pushes received on the phone (done 2026-11-02 after a resend about 6½ minutes apart, 17:40:20Z and 17:46:58Z — of the first pair, sent 2 s apart, only one arrived, unexplained); `ls -la /var/log/quanttrader/` after the first weekly rotation (`.1` files owned by `ops`, `deploys.log` untouched; the weekly run falls on Sunday, so probably 2026-11-08 00:00 UTC, checked on 2026-11-09); after the next `make deploy`, its restart ends the unit `inactive` (not `failed`) and sends no failure push; the healthchecks.io dashboard shows the pings (operator; not yet recorded).
