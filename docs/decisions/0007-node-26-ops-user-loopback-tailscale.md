# 0007 — Production runs Node 26 LTS as `ops`, listens on loopback, and is reached over Tailscale; the git remote is HTTPS

**Date:** 2026-10-31 · **Status:** active · **Phase:** D.2.

## Decision

- **Node 26.13.0** ("Lithium" LTS since 2026-10-28), installed system-wide at `/usr/local` from the official tarball with the published checksum verified (`--no-same-owner`); pnpm 11.24.0 pinned globally for the deploy and the three `pnpm dlx` wrappers only. A tarball install gets no automatic patches: a Node update is runbook step 1 again plus the `.nvmrc` bump in the same PR. `.nvmrc` = 26.13.0, `engines.node` `>=26.0.0 <27`; CI reads `.nvmrc`; the deploy refuses a host whose Node differs from the commit's `.nvmrc` and checks the service's own Node after the restart.
- **The `ops` user** owns `/opt/quanttrader` (including `.env.local`, chowned in place), `/var/log/quanttrader` and the crontab; the unit runs as `ops` with `NoNewPrivileges`, `ProtectSystem=full` (/usr, /boot and /etc read-only), `ProtectHome` and `HOME=/var/lib/quanttrader`, and its `ExecStart` runs Next's entry point with node directly — pnpm reads `~/.config/pnpm` at start, which `ProtectHome` turns into EACCES, and `pnpm exec` would run a dependency check at every restart; `/tmp` stays shared because the quarterly-cycle route writes `/tmp/quanttrader-cycles` for the operator; the unit is tested in its sandbox with `systemd-run` before anything restarts; `ops/crontab` sets `PATH` so the `pnpm dlx` wrappers survive the move (the E2.29 pattern); `make deploy` runs as `ops` with `sudo -n systemctl restart quanttrader` as its only privileged step. Sudoers narrowing is D.7, after the remaining root work (logrotate, backups, firewall).
- **Loopback and the Tailscale address only:** `next start -H 127.0.0.1 -p 3000`; the cron wrappers already call `localhost`; `quanttrader-tailnet.socket` listens on the host's tailnet address (100.77.24.89:3000) and `systemd-socket-proxyd` (part of systemd, unprivileged, `DynamicUser`) forwards to loopback, so the dashboard keeps `http://quanttrader-prod:3000` (plain HTTP inside WireGuard); the proxy path is proven on a test port against the running server before the bind changes, and the `:3000` socket takes over the moment the restart releases the port (Linux refuses a specific-address bind against a listening wildcard socket), then the device check — sign-in and a Server Action — runs on the real URL; ufw stays as the second layer and the SSH tunnel as the fallback. **Addendum 2026-10-31:** `tailscale serve` was the first choice, but Serve is not enabled on this tailnet (the CLI printed the admin-console link and waited); the listener meets the operator's words as written, and `tailscale serve --bg --https=443 http://127.0.0.1:3000` can be layered on for HTTPS once the operator enables Serve.
- **HTTPS git remote** (`https://github.com/huffed/trading-app-demo.git`): the repository is public, so the read-only clone needs no credential and the host holds no deploy key for `ops`. **Revisit if the repository ever goes private** — `make deploy` would fail loudly at `git fetch`, and a read-only deploy key or token for `ops` would be the fix.

## Why

Node 25 reached end of life on 2026-06-01 (DEBT D-21, High). The service ran as root with the app port on every interface behind ufw alone (D-23, D-18). The operator chose: Node 26 if the full suite, the golden file and the build were clean on it locally — they were (2026-10-31 on dev @ 396d710, 26.13.0: 140 test files, 2176 passed + 11 expected failures, golden MATCH, production build; this PR's commit: 2216 + 11); loopback and the Tailscale address only, with ufw kept; the HTTPS remote.

## Alternatives considered

- NodeSource apt repository: a third-party repository and `curl | bash` as root; rejected for the checksum-verified official tarball.
- nvm for `ops`: a per-user toolchain in a service path, which is what the host is leaving.
- Node 24 (also LTS): allowed by the operator as the fallback if 26 had failed; 26 was clean.
- Keeping `*:3000` behind ufw: one layer, and the operator asked for two.
- SSH tunnel only: works, but the operator asked for direct Tailscale access from their devices.
- `tailscale serve` as the only tailnet path: needs Serve enabled in the Tailscale admin console, which only the operator can do; kept as the HTTPS layer to add later.
- Binding Next to the Tailscale address (`-H 100.77.24.89`): the cron wrappers would then have to leave loopback, which the operator ruled out.
- A deploy key for `ops`: unnecessary while the repository is public; one fewer secret on the host.
- pnpm in the service path (`pnpm exec next start`): rejected — it reads the user's config directory under `ProtectHome` and re-checks dependencies at every restart; node runs Next's entry point directly.
- `PrivateTmp`: rejected — it would hide the quarterly-cycle output the operator collects from `/tmp`.

## Consequences

- A rollback to a commit whose `.nvmrc` pins 25.9.0 refuses by design on this host; the full return path is in `docs/runbooks/d2-node-26-ops-user-loopback.md`.
- D-21 closes; D-23 narrows to the sudoers entry (D.7).
- `make status` reports the host Node, the unit's user, both crontab sizes, what listens on :3000 and the Tailscale serve state.
- The dead-man incident runbook in `scripts/README.md` changes with it: crontab checks as `ops`, root's must be empty, rebuilds only through `make deploy`.
- Merging the D.2 PR opens the host window: between the merge and runbook step 2, `make deploy` fails fast and the D.1 rollback path is replaced by the runbook's. `@types/node` stays `^20` (DEBT D-17).

## Evidence

`docs/PHASE_D_PLAN.md` (Approval 2026-10-31, items 2 and 3); the runbook's recorded output and the `docs/decisions/deploys.md` rows of the execution (filled when run).
