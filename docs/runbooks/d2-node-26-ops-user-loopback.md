# D.2 — Node 26 LTS, the `ops` process user, loopback + Tailscale (decision 0007)

Host procedure for `quanttrader-prod`, run from the workstation as `ops` with `sudo -n`, **outside market hours** (standing rule: Sunday 22:00 to Friday 22:00 UK is off limits, and nothing starts within the hour before the Sunday open), after D.1 is verified and the D.2 PR is merged. **Merging the D.2 PR opens the host window:** from the merge until step 2 below, `make deploy` fails fast (the host run cannot write the log as `ops`) and the D.1 rollback path no longer applies; do the steps in order and in one sitting (about 45 minutes), or roll back as described at the end. Every step prints what it did; stop at the first step that does not, and use the rollback. Each `ssh qt` prompts for approval in a Claude session — that is the intended control.

Facts the procedure relies on (verified read-only 2026-10-31): x86_64; Node 26.13.0 is the "Lithium" LTS line since 2026-10-28; the host runs root's nvm Node 25.9.0 and pnpm 11.24.0; `/opt/quanttrader` and `/var/log/quanttrader` are root-owned; the git remote is `git@github.com:…` over root's read-only deploy key; `ops` has `NOPASSWD:ALL` sudo and a locked password; Serve is not enabled on the tailnet (so `tailscale serve` is not used); the tailnet addresses are 100.77.24.89 and fd7a:115c:a1e0::ce01:18a8, the DNS name `quanttrader-prod.tail5612ed.ts.net`; systemd 259 with `/usr/lib/systemd/systemd-socket-proxyd`; cron's default PATH is `/usr/bin:/bin`.

## 0. Pre-flight (read-only)

```bash
make status                                   # the D.1 commit verified running; ticks 200; reboot not required
ssh qt 'uname -m; ls /usr/local/bin; busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses; ls -la /tmp/quanttrader-m1-band.state 2>/dev/null'
```

Expected: `x86_64`; no `node`/`pnpm` in `/usr/local/bin`; `b false` (the detached deploy run as `ops` relies on it; `b true` would need `loginctl enable-linger ops` first); the M1 state file, if present, is root-owned (step 5 removes it after the crontab swap).

## 1. Node 26.13.0 system-wide, from the official tarball, checksum-verified

No third-party apt repository and no `curl | bash`: the tarball and `SHASUMS256.txt` come from nodejs.org and the sum is checked before anything is unpacked. `--no-same-owner` keeps `/usr/local/*` root-owned whatever uid the archive recorded. pnpm is pinned to the version root's nvm had (11.24.0); it is only used by the deploy and the three `pnpm dlx` wrappers, never by the service.

```bash
ssh qt 'set -e; cd /tmp
  curl -fsSLO https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.xz
  curl -fsSLO https://nodejs.org/dist/v26.13.0/SHASUMS256.txt
  grep " node-v26.13.0-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c -
  sudo -n tar -C /usr/local --strip-components=1 --no-same-owner --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md -xJf node-v26.13.0-linux-x64.tar.xz
  rm -f node-v26.13.0-linux-x64.tar.xz SHASUMS256.txt
  sudo -n /usr/local/bin/npm install -g pnpm@11.24.0 > /dev/null
  stat -c "%U:%G %n" /usr/local/bin /usr/local/bin/node /usr/local/bin/pnpm
  echo "node $(/usr/local/bin/node -v) pnpm $(/usr/local/bin/pnpm -v)"'
```

Expected: `node-v26.13.0-linux-x64.tar.xz: OK`, three `root:root` lines, then `node v26.13.0 pnpm 11.24.0`. Node updates later: repeat this step with the new version and bump `.nvmrc` in the same PR as the deploy (there are no automatic patches for a tarball install; `make status` shows the host Node).

## 2. Ownership to `ops`, a HOME for the service, the stale state file

The checkout, the build, the logs and the deploy state become `ops`'s. The env file is chowned **in place**; it is never read, copied or moved. `/var/lib/quanttrader` is the service's HOME (the unit sets it) so nothing Node writes lands in the checkout or in `/home`.

```bash
ssh qt 'sudo -n chown -R ops:ops /opt/quanttrader /var/log/quanttrader && sudo -n install -d -o ops -g ops -m 750 /var/lib/quanttrader && stat -c "%U:%G %a %n" /opt/quanttrader /opt/quanttrader/.env.local /var/log/quanttrader /var/lib/quanttrader'
```

Expected: four lines owned `ops:ops`; `.env.local` stays mode `600`.

## 3. Git remote to HTTPS

The repository is public, so a read-only clone needs no credential; the host keeps no deploy key for `ops` (root's key stays in `/root/.ssh` until the operator deletes it). **Revisit if the repository ever goes private:** `git fetch` would then fail loudly at the first step of `make deploy`, and a read-only deploy key or token for `ops` would be needed.

```bash
ssh qt 'git -C /opt/quanttrader remote set-url origin https://github.com/huffed/trading-app-demo.git && git -C /opt/quanttrader fetch --quiet origin && echo fetch-ok'
```

## 4. The unit, reloaded now and tested in its sandbox before anything restarts

```bash
scp ops/systemd/quanttrader.service qt:/tmp/quanttrader.service
ssh qt 'sudo -n install -m 644 /tmp/quanttrader.service /etc/systemd/system/quanttrader.service && sudo -n systemctl daemon-reload && systemctl cat quanttrader | grep -E "^(User|ExecStart|ProtectSystem|ProtectHome)="'
ssh qt 'sudo -n systemd-run --quiet --wait --pipe --collect --uid=ops --gid=ops -p WorkingDirectory=/opt/quanttrader -p ProtectSystem=full -p ProtectHome=yes -p NoNewPrivileges=yes -E PATH=/usr/local/bin:/usr/bin:/bin -E HOME=/var/lib/quanttrader -E NEXT_TELEMETRY_DISABLED=1 /usr/local/bin/node /opt/quanttrader/node_modules/next/dist/bin/next --version'
```

Expected: the four unit lines, then `Next.js v16.2.4` printed from inside the same sandbox the unit uses. The running process is still root's old one; step 7's deploy restarts it under the new unit. If the sandbox test fails, stop: fix the unit in a PR, nothing has changed for the running service.

## 5. Crontab to `ops`, root's removed, in the same minute — with the PATH check first

The new crontab's first line sets `PATH=/usr/local/bin:/usr/bin:/bin`; without it the three `pnpm dlx` wrappers (broker-health, m1-band-check, cohort-report) die silently as `ops` — the E2.29 pattern. Check the resolution the way cron will see it, then swap right after a tick (seconds 20–50 of a minute divisible by 5), so no minute has two schedulers:

```bash
ssh qt 'env -i HOME=/home/ops PATH=/usr/local/bin:/usr/bin:/bin bash -c "command -v pnpm; command -v node"'
scp ops/crontab qt:/tmp/qt-crontab
ssh qt 'crontab /tmp/qt-crontab && sudo -n crontab -u root -r && sudo -n rm -f /tmp/quanttrader-m1-band.state && echo "ops: $(crontab -l | grep -c "^[0-9*]") entries; root: $(sudo -n crontab -u root -l 2>&1 | head -1)"'
```

Expected: `/usr/local/bin/pnpm`, `/usr/local/bin/node`; then `ops: 10 entries; root: no crontab for root`. The next tick runs as `ops` from the `ops`-owned checkout against the still-root old server and logs into the `ops`-owned log files. The M1 band state file in `/tmp` was root-owned from the root crontab era; as `ops` the 21:30 wrapper could not rewrite it (it would fail under `set -e`), so it is removed here, after root's last possible run, and the next 21:30 run recreates it (one band-state notification may repeat).

## 6. The Tailscale-address listener: proven on a test port, with the full device check, BEFORE the bind changes

The operator's requirement is "loopback and the Tailscale address only". Next itself binds loopback; `quanttrader-tailnet.socket` listens on the host's tailnet addresses (100.77.24.89:3000 and the IPv6 one) and `systemd-socket-proxyd` forwards each connection to `127.0.0.1:3000`, so the dashboard keeps its pre-D.2 URL `http://quanttrader-prod:3000` (plain HTTP inside WireGuard; ufw allows `tailscale0` only, and keeps doing real work: a bind to the tailnet IP does not by itself exclude other interfaces). `tailscale serve` was the first choice and is **not enabled on this tailnet** (2026-10-31: the CLI printed "Serve is not enabled on your tailnet" with an admin-console link and waited); once the operator enables it, `sudo tailscale serve --bg --https=443 http://127.0.0.1:3000` adds HTTPS on the MagicDNS name on top of this listener.

The socket cannot take port 3000 while root's old server still holds `[::]:3000` (Linux refuses a specific-address bind against a listening wildcard socket, SO_REUSEADDR or not), so the proof and the device check run on a test port, with systemd owning the test socket exactly as it will own the real one; the real socket takes :3000 in step 7, the moment the restart releases it.

```bash
scp ops/systemd/quanttrader-tailnet.socket ops/systemd/quanttrader-tailnet.service qt:/tmp/
ssh qt 'sudo -n install -m 644 /tmp/quanttrader-tailnet.socket /tmp/quanttrader-tailnet.service /etc/systemd/system/ && sudo -n systemctl daemon-reload && systemctl cat quanttrader-tailnet.socket | grep ListenStream'
ssh qt 'sudo -n systemd-run --quiet --unit=qt-tailnet-test --collect --socket-property=ListenStream=100.77.24.89:3001 -p DynamicUser=yes /usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:3000 && systemctl is-active qt-tailnet-test.socket'
curl -s -o /dev/null -w "tailnet test port: %{http_code}\n" --max-time 20 http://quanttrader-prod.tail5612ed.ts.net:3001/login     # from the workstation (on the tailnet): 200
```

Expected: two `ListenStream` lines, `active`, then `200`. Now the device check, on the test port while the old server is still reachable: open `http://quanttrader-prod:3001/login` in a browser on a tailnet device, **sign in** (client-side Supabase auth; cookies are not port-scoped), open an algorithm and press **Run** on its readiness card — that calls the Server Action `runAlgorithmReadinessCheck` (read-only), and Next compares the Origin with the Host, both `quanttrader-prod:3001` through the raw TCP proxy. **Step 7 waits for this check.** Whoever runs the procedure without the operator's credentials does the page-render check, leaves the test unit up, and holds step 7 until the operator has signed in and pressed Run on `http://quanttrader-prod:3001` from one of their devices (the interim state — root's old server on nvm Node 25, the crontab already `ops`'s, the new unit installed but not started — is stable and verified by the ticks). Then stop the test unit:

```bash
ssh qt 'sudo -n systemctl stop qt-tailnet-test.socket qt-tailnet-test.service; systemctl is-active qt-tailnet-test.socket || echo test-unit-stopped'
```

If the proof fails, stop; nothing has changed for the running service, and the SSH tunnel (`ssh -L 3000:localhost:3000 qt`) keeps working as the fallback.

## 7. Deploy the D.2 commit as `ops`, and hand the port to the tailnet socket

If `ops/systemd/quanttrader.service` changed in the repo since step 4 (comments count: the repo is the source of truth), repeat step 4's `install` + `daemon-reload` first — it does not restart anything.

```bash
make deploy          # .nvmrc 26.13.0 must equal the host's and the unit's Node; the restart applies User=ops and -H 127.0.0.1
```

The first install as `ops` rebuilds `node_modules` from `ops`'s own pnpm store (two to three minutes; the old root process keeps serving from memory meanwhile, as every deploy's build does). The deploy's run log prints `service active on Node v26.13.0; /login 200` right after the restart and then waits up to 25 minutes for the next manage, heartbeat and scan ticks before it reports OK. **As soon as that line appears** (a second terminal, or `make logs LOG=deploy-<stamp> N=5`), `[::]:3000` is free and the tailnet socket takes it:

```bash
ssh qt 'sudo -n systemctl enable --now quanttrader-tailnet.socket && systemctl is-active quanttrader-tailnet.socket && ss -ltn | grep -E ":3000 "'
curl -s -o /dev/null -w "tailnet login: %{http_code}\n" --max-time 20 http://quanttrader-prod.tail5612ed.ts.net:3000/login     # 200
```

Expected: `active`, three `:3000` listeners (`127.0.0.1:3000` Next, the IPv4 and IPv6 tailnet sockets), `200`; then one page load of `http://quanttrader-prod:3000/login` in the browser. The dashboard is unreachable over the tailnet only between the restart and this `enable --now` — the time it takes to type it — with the SSH tunnel as the fallback throughout. When the deploy reports OK: `make status` shows `unit user ops`, `listening: 127.0.0.1:3000 100.77.24.89:3000 …`, root crontab 0 entries, the tailnet socket active on the host's current addresses.

## 8. Nothing on the public interface

```bash
ssh qt 'ss -ltn | grep -E ":3000 "'     # exactly three: 127.0.0.1:3000 (Next), 100.77.24.89:3000 and [fd7a:115c:a1e0::ce01:18a8]:3000 (the tailnet socket)
ssh qt 'sudo -n ufw status | head -5'  # unchanged: default deny, 22 limited, tailscale0 allowed — the second layer
```

## 9. Record

`make deploy` appended the deploy row; add one row for the host changes (steps 1–6, including the tailnet listener) to `docs/decisions/deploys.md` pointing at decision 0007, flip the "planned" wording in `docs/DEBT.md` D-21/D-23, `docs/STACK.md` §4, `docs/PHASE_D_PLAN.md` D.2 and `scripts/README.md` to "done", and commit it all in the next PR.

## Rollback

**Since 2026-11-01 13:35Z (root's nvm removed after D.2 was verified) there is one rollback path:** `make deploy REF=<sha>` to a commit whose `.nvmrc` is 26.13.0 (every commit from 77eeb01 on; first verified in production at 2635d1f), under the D.2 unit and with the tailnet socket **kept** — the deploy script restarts Next on loopback and the socket keeps forwarding. The "prev" of the last `OK` line in `make logs LOG=deploys N=3` is the usual target — not yet: today that prev is 499a8a0 (`.nvmrc` 25.9.0), which the deploy refuses before touching anything, and the older Node-26 commits 77eeb01 and 688e35a never ran in production; a real rollback target appears once a second Node-26 deploy has been verified.

The two paths below are **retired** and kept only as history: both reinstall the D.1 unit, whose `ExecStart` and `PATH` point into `/root/.nvm`, so on today's host that unit cannot start (systemd `203/EXEC`). Do not run them.

- _Retired fast path_ (needed the D.1 unit): release the tailnet socket (`systemctl disable --now quanttrader-tailnet.socket`, because the D.1 unit bound `[::]:3000`), reinstall `git show 499a8a0:ops/systemd/quanttrader.service`, `daemon-reload`, restart.
- _Retired full return_ (needed root's nvm): the fast path, then root's crontab from `git show 499a8a0:ops/crontab`, `chown -R root:root` of the checkout and the logs, the SSH remote, and the D.1 host script streamed from `499a8a0` and run as root through nvm, then `main` moved back by hand.
