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

The nightly workflow needs nothing on the host; it runs on `dev` at 03:17 UTC from the next night (`gh workflow run nightly.yml --ref dev` runs it now). `HEARTBEAT_PING_URL` is the operator's step and the one host edit allowed mid-week (operator decision 2026-11-02, a standing exception to "no host change in market hours": one line in the env file, read by `scripts/heartbeat-cron.sh` on the next tick, no restart, and its failure mode is a missing ping, not a trading change). Create a check at healthchecks.io (period 5 minutes, grace 15 minutes: the heartbeat ticks every 5 minutes and the dead-man workflow alarms after 35–45), copy its ping URL, then on the host as `ops`, pasting the URL yourself (never through chat):

```bash
ssh qt
grep -c '^HEARTBEAT_PING_URL=' /opt/quanttrader/.env.local                       # 0: not set yet
printf 'HEARTBEAT_PING_URL=%s\n' 'https://hc-ping.com/<uuid>' >> /opt/quanttrader/.env.local
grep -c '^HEARTBEAT_PING_URL=' /opt/quanttrader/.env.local                       # 1
exit
make logs LOG=heartbeat N=1   # after the next tick (every 5 min): the line says the ping was sent, not "HEARTBEAT_PING_URL not set"
```

Then one ledger row (`HEARTBEAT_PING_URL set on the host`, the time, the heartbeat line as the read-only check); the healthchecks.io dashboard shows the first ping within five minutes. If the heartbeat line still says the variable is not set, the line went to the wrong file or has a typo: `grep -n '^HEARTBEAT' /opt/quanttrader/.env.local` on the host (the value is the only secret on that line; it does not go into chat).

When `scripts/ops/notify-failure.sh` or `ops-health.sh` change in the repo, repeat the `install` line: the host runs the installed copies, not the checkout's.

Verification: `make logs LOG=ops-health N=2` after 07:05 UTC the next day (done 2026-11-02: logged and pushed); the two test pushes received on the phone (done 2026-11-02 after a resend a minute apart — of the first pair, sent 2 s apart, only one arrived, unexplained); `ls -la /var/log/quanttrader/` after the first weekly rotation (`.1` files owned by `ops`, `deploys.log` untouched; ~2026-11-09); after the next `make deploy`, its restart ends the unit `inactive` (not `failed`) and sends no failure push.
