# Deploy and host-change ledger

One line per production deploy, appended by `make deploy` and committed in the next PR, and one line per host change that is not a deploy (reboot, package install, config change), pointing at its `docs/decisions/` entry. The audit brackets paper-trading results with these dates. The machine record on the host is `/var/log/quanttrader/deploys.log`.

| Date (UTC) | What | Commit / entry | Note |
|---|---|---|---|
| 2026-10-31T15:45:20Z | deploy `3ee22e2` → `499a8a0` | `499a8a02e39dfa87753eaca3059fd962fbd0ee98` | ref origin/dev; verified: service active on Node v25.9.0, /login 200, next manage + heartbeat (stale_count 0) + scan ticks 200; main created at 499a8a0 |
| 2026-10-31T15:47:55Z | host reboot for the pending kernel update (linux-image 7.0.0-38, libc6) | decision 0005, Execution | right after the 15:45 tick and the verified deploy; back at 15:48:20Z, service active (enabled), reboot flag cleared; 15:50:02Z manage + heartbeat ticks 200, stale_count 0 |
