# ops/ — the production host as code

What runs on the VPS `quanttrader-prod`, captured from the host on 2026-10-31 (Phase D, step D.1) so the host can be rebuilt from this directory and every change to it goes through a PR and a dated `docs/decisions/` entry. Nothing here contains a secret; the only secret-bearing file on the host is `/opt/quanttrader/.env.local`, which the operator holds.

| File | Applied where | Applied how |
|---|---|---|
| `systemd/quanttrader.service` | `/etc/systemd/system/quanttrader.service` | `install -m 644`, `systemctl daemon-reload`; the next `make deploy` restarts it (runs as `ops`, loopback only — decision 0007; its `ExecStopPost=` hook must be installed first, see the row below) |
| `crontab` | the `ops` user's crontab | as `ops`: `crontab ops/crontab` |
| `systemd/quanttrader-tailnet.socket` + `.service` | `/etc/systemd/system/` | `install -m 644`, `systemctl daemon-reload`, `systemctl enable --now quanttrader-tailnet.socket` — the listener on the Tailscale addresses (IPv4 and IPv6) that forwards to loopback (runbook `docs/runbooks/d2-node-26-ops-user-loopback.md` §6) |
| Tailscale serve (optional HTTPS layer; `tailscaled` keeps the config) | `tailscale serve status` | once Serve is enabled for the tailnet: `sudo tailscale serve --bg --https=443 http://127.0.0.1:3000` |
| `sshd/10-hardening.conf` | `/etc/ssh/sshd_config.d/10-hardening.conf` | copy, `sshd -t`, `systemctl reload ssh` (installed 2026-10-29, `docs/runbooks/harden-vps-ssh.md`) |
| `ufw.sh` | the firewall | run once as root; idempotent |
| `logrotate/quanttrader` | `/etc/logrotate.d/quanttrader` | `install -m 644`; logrotate runs daily from systemd (D.4, decision 0009) |
| `backup/age-recipient.txt` | `/usr/local/lib/quanttrader/backup-age-recipient.txt` | `install -m 644`; the public key every backup is encrypted to; the private key is the operator's (D.6, decision 0011) |
| `scripts/ops/notify-failure.sh`, `scripts/ops/ops-health.sh`, `scripts/ops/backup.sh` (in `scripts/ops/`, not here) | `/usr/local/lib/quanttrader/` | `install -m 755`; the app unit's `ExecStopPost=` hook and the daily summary run the installed copies, so a rollback of the checkout cannot remove them (D.4, decision 0009) |

The deploy itself is `scripts/ops/deploy.sh` (runs on the host) driven by `scripts/ops/deploy-driver.sh` (runs on the workstation) through `make deploy`; `make status` and `make logs` are read-only views. All of it is documented in `docs/DEV_SETUP.md` §17 and decided in `docs/decisions/0005`. `ops/**` and `scripts/ops/**` are infrastructure, not fenced by the Claude Code hooks (decision 0006): every change is a PR reviewed in a fresh context, shellchecked at `-S warning`, and every command that runs on the host prompts for the operator's approval.
