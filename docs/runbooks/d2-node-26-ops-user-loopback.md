# D.2 — Node 26 LTS, the `ops` process user, loopback + Tailscale (decision 0007)

Host procedure for `quanttrader-prod`, run from the workstation as `ops` with `sudo -n`, **outside market hours** (standing rule: Sunday 22:00 to Friday 22:00 UK is off limits), after D.1 is verified and the D.2 PR is merged. Every step prints what it did; stop at the first step that does not, and use the rollback at the end. Each `ssh qt` prompts for approval in a Claude session — that is the intended control.

Facts the procedure relies on (verified read-only 2026-10-31): x86_64; Node 26.13.0 is the "Lithium" LTS line since 2026-10-28; the host runs root's nvm Node 25.9.0; `/opt/quanttrader` and `/var/log/quanttrader` are root-owned; the git remote is `git@github.com:…` over root's read-only deploy key; `ops` has `NOPASSWD:ALL` sudo and a locked password; `tailscale serve` has no config; ports 80/443 are free; the tailnet DNS name is `quanttrader-prod.tail5612ed.ts.net`.

## 0. Pre-flight (read-only)

```bash
make status                       # D.1 commit verified running; ticks 200; reboot not required
ssh qt 'uname -m; ls /usr/local/bin'   # x86_64; no node/pnpm yet
```

## 1. Node 26.13.0 system-wide, from the official tarball, checksum-verified

No third-party apt repository and no `curl | bash`: the tarball and `SHASUMS256.txt` come from nodejs.org and the sum is checked before anything is unpacked into `/usr/local`. pnpm is pinned to the version root's nvm had (11.24.0).

```bash
ssh qt 'set -e; cd /tmp
  curl -fsSLO https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz
  curl -fsSLO https://nodejs.org/dist/v26.13.0/SHASUMS256.txt
  grep " node-v26.13.0-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -
  sudo -n tar -C /usr/local --strip-components=1 --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md -xJf node-v26.13.0-linux-x64.tar.xz
  rm -f node-v26.13.0-linux-x64.tar.xz SHASUMS256.txt
  sudo -n /usr/local/bin/npm install -g pnpm@11.24.0 > /dev/null
  echo "node $(/usr/local/bin/node -v) pnpm $(/usr/local/bin/pnpm -v)"'
```

Expected: `node-v26.13.0-linux-x64.tar.xz: OK`, then `node v26.13.0 pnpm 11.24.0`.

## 2. Ownership to `ops`

The checkout, the build, the logs and the deploy state become `ops`'s. The env file is chowned **in place**; it is never read, copied or moved.

```bash
ssh qt 'sudo -n chown -R ops:ops /opt/quanttrader /var/log/quanttrader && stat -c "%U:%G %a %n" /opt/quanttrader /opt/quanttrader/.env.local /var/log/quanttrader'
```

Expected: three lines owned `ops:ops`; `.env.local` stays mode `600`.

## 3. Git remote to HTTPS

The repository is public, so a read-only clone needs no credential; the host keeps no deploy key from here on (root's key stays in `/root/.ssh` until the operator deletes it). **Revisit if the repository ever goes private:** `git fetch` would then fail loudly at the first step of `make deploy`, and a deploy key or token for `ops` would be needed.

```bash
ssh qt 'git -C /opt/quanttrader remote set-url origin https://github.com/huffed/trading-app-demo.git && git -C /opt/quanttrader fetch --quiet origin && echo fetch-ok'
```

## 4. The unit (reloaded now, applied by the deploy's restart)

```bash
scp ops/systemd/quanttrader.service qt:/tmp/quanttrader.service
ssh qt 'sudo -n install -m 644 /tmp/quanttrader.service /etc/systemd/system/quanttrader.service && sudo -n systemctl daemon-reload && systemctl cat quanttrader | grep -E "^(User|ExecStart|ProtectSystem)="'
```

The running process is still root's old one; the next step's deploy restarts it under the new unit.

## 5. Crontab to `ops`, root's removed, in the same minute

Right after a tick (seconds 20–50 of a minute divisible by 5), so no minute has two schedulers:

```bash
scp ops/crontab qt:/tmp/qt-crontab
ssh qt 'crontab /tmp/qt-crontab && sudo -n crontab -u root -r && echo "ops: $(crontab -l | grep -c "^[0-9*]") entries; root: $(sudo -n crontab -u root -l 2>&1 | head -1)"'
```

Expected: `ops: 10 entries; root: no crontab for root`. The next tick runs as `ops` from the `ops`-owned checkout and logs into the `ops`-owned log files.

## 6. Deploy the D.2 commit as `ops`

```bash
make deploy          # .nvmrc 26.13.0 must equal the host's node; the restart applies User=ops and -H 127.0.0.1
```

The script verifies, among the usual checks, that the service's own Node is 26.13.0 and that the next manage, heartbeat and scan ticks log 200 under the new user.

## 7. Tailscale access, then confirm from a device before anything else closes

```bash
ssh qt 'sudo -n tailscale serve --bg --https=443 http://127.0.0.1:3000 && tailscale serve status'
curl -sI https://quanttrader-prod.tail5612ed.ts.net/login | head -1      # from the workstation: HTTP/2 200
```

Then open `https://quanttrader-prod.tail5612ed.ts.net/login` in a browser on a tailnet device and sign in. If the tailnet does not issue HTTPS certificates (`tailscale serve` says so), use `--http=80` instead and the URL becomes `http://quanttrader-prod.tail5612ed.ts.net/`; traffic is still inside WireGuard. The SSH tunnel (`ssh -L 3000:localhost:3000 qt`) keeps working as a fallback.

## 8. Nothing on the public interface

```bash
ssh qt 'ss -ltn | grep -E ":3000 "'     # 127.0.0.1:3000 only
ssh qt 'sudo -n ufw status | head -5'  # unchanged: default deny, 22 limited, tailscale0 allowed — the second layer
```

## 9. Record

`make deploy` appended the deploy row; add one row for the host changes (steps 1–5 and 7) to `docs/decisions/deploys.md` pointing at decision 0007, and commit both rows in the next PR.

## Rollback (if any step after 4 fails)

1. `make deploy REF=<D.2 sha>` after fixing the cause is the normal path; D.2's commit is validated on Node 26 locally and by CI.
2. Full return to the D.1 state, in order: `git show <D.1 sha>:ops/systemd/quanttrader.service` → install, `daemon-reload`; `sudo -n crontab -u root /tmp/qt-crontab` then `crontab -r` as `ops` in the same minute; `sudo -n chown -R root:root /opt/quanttrader /var/log/quanttrader`; `git -C /opt/quanttrader remote set-url origin git@github.com:huffed/trading-app-demo.git`; then run the **D.1** driver, which deploys as root through nvm: `git show <D.1 sha>:scripts/ops/deploy-driver.sh > /tmp/d1-driver.sh && bash /tmp/d1-driver.sh <D.1 sha>`. The D.2 driver cannot roll back to D.1 by itself because `.nvmrc` 25.9.0 does not match the system Node — that refusal is the gate working.
