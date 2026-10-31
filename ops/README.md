# ops/ — the production host as code

What runs on the VPS `quanttrader-prod`, captured from the host on 2026-10-31 (Phase D, step D.1) so the host can be rebuilt from this directory and every change to it goes through a PR and a dated `docs/decisions/` entry. Nothing here contains a secret; the only secret-bearing file on the host is `/opt/quanttrader/.env.local`, which the operator holds.

| File | Applied where | Applied how |
|---|---|---|
| `systemd/quanttrader.service` | `/etc/systemd/system/quanttrader.service` | copy, `systemctl daemon-reload`, `systemctl restart quanttrader` (D.2 changes `User=`, the Node path and the bind address) |
| `crontab` | the scheduler user's crontab (`root` today, `ops` after D.2) | `crontab -u <user> ops/crontab` |
| `sshd/10-hardening.conf` | `/etc/ssh/sshd_config.d/10-hardening.conf` | copy, `sshd -t`, `systemctl reload ssh` (installed 2026-10-29, `docs/runbooks/harden-vps-ssh.md`) |
| `ufw.sh` | the firewall | run once as root; idempotent |

The deploy itself is `scripts/ops/deploy.sh` (runs on the host) driven by `scripts/ops/deploy-driver.sh` (runs on the workstation) through `make deploy`; `make status` and `make logs` are read-only views. All of it is documented in `docs/DEV_SETUP.md` §17 and decided in `docs/decisions/0005`. `ops/**` and `scripts/ops/**` are live-runner paths for the Claude Code hooks (`.claude/hooks/live-paths.txt`): they change only in a PR about them.
