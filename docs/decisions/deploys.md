# Deploy and host-change ledger

One line per production deploy, appended by `make deploy` and committed in the next PR, and one line per host change that is not a deploy (reboot, package install, config change), pointing at its `docs/decisions/` entry. The audit brackets paper-trading results with these dates. The machine record on the host is `/var/log/quanttrader/deploys.log`.

| Date (UTC) | What | Commit / entry | Note |
|---|---|---|---|
