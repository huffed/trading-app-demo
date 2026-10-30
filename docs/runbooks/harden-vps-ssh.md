# Runbook — harden the VPS (SSH, firewall, process user) — **Critical**

**Why Critical (verified read-only, 2026-10-28, `sshd -T` + `ufw status` on `quanttrader-prod`):**

| Finding | Value today | Risk |
|---|---|---|
| `PasswordAuthentication` | **yes** | password guessing against any account; the only account is root (`prohibit-password` blocks root passwords, but the daemon still negotiates password auth) |
| `PermitRootLogin` | `prohibit-password` (root key login allowed) | the one key = full root; no audit trail of who did what |
| Non-root users | none | the app, the crons and every deploy run as root |
| `MaxAuthTries` / `X11Forwarding` | 6 / yes | defaults, not needed |
| fail2ban | inactive | no brute-force throttling on a world-reachable port 22 |
| ufw | active, default deny; `22/tcp` from anywhere; everything on `tailscale0` | correct shape; the app itself binds `*:3000` and relies on ufw alone to stay off the internet |
| unattended-upgrades | active | good |
| Hetzner Cloud firewall | not checked (console) | a second layer that survives a ufw mistake |

Do **Phase 1 today** (10 minutes, no service impact). **Phase 2** removes root entirely but changes how the app is deployed and run, so it belongs to Phase D with a maintenance window.

## 0. Before you start — a Host alias so the IP never lives in the repo

`~/.ssh/config` on your Mac (the IP comes from your private note, not from any document in this repository):

```
Host qt
  HostName <vps-ip>
  User root
  IdentityFile ~/.ssh/<your-vps-key>
  IdentitiesOnly yes
```

Keep **two** SSH sessions open for every step below: one to make the change, one to prove you can still log in. Never close the proving session until the new login works. Recovery if locked out: Hetzner Cloud console → server → Console (web TTY) → log in and revert the drop-in file.

## Phase 1 — today

### 1.1 Password authentication off, sane limits (sshd drop-in)

```bash
ssh qt
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
MaxAuthTries 3
X11Forwarding no
LoginGraceTime 30
CONF
sshd -t && echo "config OK"            # must print "config OK"; otherwise fix before reloading
systemctl reload ssh
sshd -T | grep -iE "^(passwordauthentication|kbdinteractiveauthentication|maxauthtries|x11forwarding) "
# expect: passwordauthentication no / kbdinteractiveauthentication no / maxauthtries 3 / x11forwarding no
```

From the **second** terminal: `ssh qt 'echo still-in'` → `still-in`. Only then close the first.

### 1.2 Brute-force throttling

```bash
apt-get install -y fail2ban
cat > /etc/fail2ban/jail.local <<'JAIL'
[sshd]
enabled = true
maxretry = 4
findtime = 10m
bantime  = 1h
JAIL
systemctl enable --now fail2ban
fail2ban-client status sshd        # expect: Status for the jail: sshd … Currently banned: 0
```

### 1.3 Rate-limit port 22 at the firewall (keeps SSH open, slows scanners)

```bash
ufw limit 22/tcp comment 'OpenSSH rate-limited'
ufw delete allow 22/tcp 2>/dev/null; ufw delete allow OpenSSH 2>/dev/null   # replace the plain allow with the limit rule
ufw status verbose                 # expect: 22/tcp LIMIT IN Anywhere; "Anywhere on tailscale0 ALLOW IN"; default deny incoming
```

Do **not** remove the port-22 rule in favour of Tailscale-only access today: a Tailscale outage would leave only the Hetzner console. Revisit in Phase D once the console recovery path has been rehearsed.

### 1.4 Hetzner Cloud firewall (console, 2 minutes)

Cloud Console → Firewalls → create `quanttrader-prod-fw`: inbound **22/tcp from your home/office IPs and 0.0.0.0/0 only if you need roaming access** (otherwise restrict), inbound **41641/udp** (Tailscale direct connections; optional), everything else denied; outbound allow all. Apply to the server. This layer survives a `ufw disable` by mistake.

### 1.5 Verify

```bash
ssh qt 'sshd -T | grep -iE "^(permitrootlogin|passwordauthentication) "; ufw status | head -8; fail2ban-client status sshd | tail -3; systemctl is-active quanttrader; tail -n1 /var/log/quanttrader/manage.log'
```

Expect: `permitrootlogin prohibit-password`, `passwordauthentication no`, the LIMIT rule, jail running, service `active`, a fresh `http=200`.

## Phase 2 — remove root (Phase D, maintenance window, ~45 minutes)

Not today: the deploy one-liner, the nvm install, the crontab and the systemd unit all assume root. The sequence, so it is on record:

1. `adduser --disabled-password ops && usermod -aG sudo ops`; copy `/root/.ssh/authorized_keys` to `/home/ops/.ssh/` (0700/0600, owner `ops`); allow `ops` passwordless `sudo systemctl restart quanttrader` and `sudo journalctl -u quanttrader` via `/etc/sudoers.d/ops`.
2. Install nvm + the pinned Node for `ops` (`.nvmrc` arrives in Phase B); `chown -R ops:ops /opt/quanttrader`; move the deploy key to `/home/ops/.ssh/`.
3. Systemd unit: `User=ops`, `Group=ops`, `ExecStart=/home/ops/.nvm/versions/node/<version>/bin/pnpm start -- -H 127.0.0.1` behind a Tailscale-bound reverse proxy **or** keep `-H 0.0.0.0` with the existing ufw rule (decide in Phase D); `ProtectSystem=strict`, `ReadWritePaths=/opt/quanttrader /var/log/quanttrader`.
4. Move the crontab to `ops` (`crontab -u ops -`); `chown ops /var/log/quanttrader`.
5. Prove a full deploy as `ops` (`make deploy` once Phase D lands), then add `PermitRootLogin no` and `AllowUsers ops` to the drop-in, `sshd -t`, reload, and verify from the second terminal.

## Rollback

Any step: `rm /etc/ssh/sshd_config.d/10-hardening.conf && sshd -t && systemctl reload ssh` restores the distribution defaults (root key login, password auth on). `ufw allow 22/tcp` restores the plain allow. `systemctl disable --now fail2ban` stops the jail.
