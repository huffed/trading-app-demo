# D.4 — alerts from the host, log rotation, nightly gate (decision 0009)

Host steps, as `ops` with `sudo -n`, outside market hours, after the D.4 PR is merged. None of them restarts the service. One ledger row for all of them.

```bash
make status                                                    # pre-flight: service active, ticks 200
scp ops/logrotate/quanttrader ops/systemd/quanttrader-failure.service ops/systemd/quanttrader.service ops/crontab qt:/tmp/
ssh qt 'sudo -n install -m 644 /tmp/quanttrader /etc/logrotate.d/quanttrader && sudo -n logrotate -d /etc/logrotate.d/quanttrader 2>&1 | grep -c "log needs rotating\|log does not need rotating"'   # dry run parses: a count of the log files
ssh qt 'sudo -n install -m 644 /tmp/quanttrader-failure.service /tmp/quanttrader.service /etc/systemd/system/ && sudo -n systemctl daemon-reload && systemctl show quanttrader -p OnFailure --value'   # quanttrader-failure.service; the running process is untouched
ssh qt 'crontab /tmp/crontab && crontab -l | grep -c "^[0-9*]"'   # 11 (right after a tick, as in the D.2 runbook step 5)
ssh qt 'bash /opt/quanttrader/scripts/ops/ops-health.sh'          # one summary push now, as a test; the next is 07:05 UTC
ssh qt 'sudo -n systemctl start quanttrader-failure.service; systemctl status quanttrader-failure.service --no-pager | head -3'   # one urgent test push ("FAILED") — tell the operator first
```

The nightly workflow needs nothing on the host; it runs on `dev` at 03:17 UTC from the next night. `HEARTBEAT_PING_URL` is the operator's step: create a check at healthchecks.io (or similar), put its URL in the host's `.env.local` under `HEARTBEAT_PING_URL`, and the next heartbeat tick pings it; the monitor then alerts when pings stop.

Verification: `make logs LOG=ops-health N=2` after 07:05 UTC the next day; `ls -la /var/log/quanttrader/` after the first weekly rotation (`.1` files owned by `ops`); the test pushes received on the phone.
