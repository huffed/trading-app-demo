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

**Executed 2026-10-29** (operator-approved; lock-out protocol: a multiplexed root session stayed open as the safety line until a brand-new `ops` login had been proven after every change, then it was closed last):

- `ops` created (`useradd -m`, locked password, `sudo` group, `/etc/sudoers.d/ops` with `NOPASSWD:ALL`, root's `authorized_keys` copied as 0600 `ops:ops`). A fresh key login plus `sudo -n true` was verified **before** sshd was touched.
- Drop-in `/etc/ssh/sshd_config.d/10-hardening.conf` installed with the §1.1 content **plus** `PermitRootLogin no` and `AllowUsers ops` (pulled forward from Phase 2 by operator decision). `sshd -t` → OK; `systemctl reload ssh`, then `systemctl restart ssh` (`KillMode=process`, existing sessions survive). Verified on new connections: `ops` login OK, root key login → `Permission denied (publickey)`, password auth not offered (`Authentications that can continue: publickey`).
- §1.2 fail2ban installed with the jail below → active (two scanner IPs banned within seconds). §1.3 `ufw limit 22/tcp` replaced the plain allow; the Tailscale interface rule is unchanged. §1.4 Hetzner Cloud firewall **not done** (console only, operator). `~/.ssh/config` `Host qt` now has `User ops` and `IdentitiesOnly yes`.
- Still root: the app (systemd unit), the crontab, `/opt/quanttrader` and the deploy (`make deploy` runs `scripts/ops/deploy.sh` as root since D.1). That is the remaining Phase 2 work, Phase D.2.

Phase 1 took 10 minutes with no service impact. **Phase 2** (process user) belongs to Phase D with a maintenance window.

## 0. Before you start — a Host alias so the IP never lives in the repo

`~/.ssh/config` on your Mac (the IP comes from your private note, not from any document in this repository):

```
Host qt
  HostName <vps-ip>
  User ops
  IdentityFile ~/.ssh/<your-vps-key>
  IdentitiesOnly yes
```

Keep **two** SSH sessions open for every step below: one to make the change, one to prove you can still log in. Never close the proving session until the new login works. Recovery if locked out: Hetzner Cloud console → server → Console (web TTY) → log in and revert the drop-in file.

## Phase 1 — today

### 1.1 Password authentication off, sane limits (sshd drop-in)

```bash
ssh qt
sudo -i                                 # lands as ops since 2026-10-29; the steps below are root's
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'CONF'
PermitRootLogin no
AllowUsers ops
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
sshd -T | grep -iE "^(permitrootlogin|allowusers|passwordauthentication|kbdinteractiveauthentication|maxauthtries|x11forwarding) "
# expect: permitrootlogin no / allowusers ops / passwordauthentication no / kbdinteractiveauthentication no / maxauthtries 3 / x11forwarding no
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
ssh qt 'sudo sshd -T | grep -iE "^(permitrootlogin|passwordauthentication|allowusers) "; sudo ufw status | head -8; sudo fail2ban-client status sshd | tail -3; systemctl is-active quanttrader; sudo tail -n1 /var/log/quanttrader/manage.log'
```

Expect: `permitrootlogin no`, `passwordauthentication no`, `allowusers ops`, the LIMIT rule, jail running, service `active`, a fresh `http=200`.

## Phase 2 — remove root (Phase D, maintenance window, ~45 minutes)

Not today: the deploy script, the nvm install, the crontab and the systemd unit all assume root. The sequence, so it is on record:

1. **Done 2026-10-29:** `ops` exists (`useradd -m`, key copied, `/etc/sudoers.d/ops` is `NOPASSWD:ALL`). Narrow the sudoers entry to the commands the deploy and the runbooks need once Phase D fixes the deploy path.
2. Install nvm + the pinned Node for `ops` (`.nvmrc` arrives in Phase B); `chown -R ops:ops /opt/quanttrader`; move the deploy key to `/home/ops/.ssh/`.
3. Systemd unit: `User=ops`, `Group=ops`, `ExecStart=/home/ops/.nvm/versions/node/<version>/bin/pnpm start -- -H 127.0.0.1` behind a Tailscale-bound reverse proxy **or** keep `-H 0.0.0.0` with the existing ufw rule (decide in Phase D); `ProtectSystem=strict`, `ReadWritePaths=/opt/quanttrader /var/log/quanttrader`.
4. Move the crontab to `ops` (`crontab -u ops -`); `chown ops /var/log/quanttrader`.
5. Prove a full deploy as `ops` (`make deploy` once Phase D lands). `PermitRootLogin no` and `AllowUsers ops` are **already in the drop-in since 2026-10-29**; root work goes through `sudo`.

## Rollback

Any step, as `ops`: `sudo rm /etc/ssh/sshd_config.d/10-hardening.conf && sudo sshd -t && sudo systemctl reload ssh` restores the distribution defaults (root key login, password auth on). If no login works at all: Hetzner Cloud console → server → Console, then the same command as root. `ufw allow 22/tcp` restores the plain allow. `systemctl disable --now fail2ban` stops the jail.
