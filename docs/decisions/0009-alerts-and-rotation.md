# 0009 — Alerts from the host itself, log rotation, and a nightly gate on dev

**Date:** 2026-11-01 · **Status:** active · **Phase:** D.4 (and the CI half of D.5).

## Decision

- **The host alerts on its own**, through the ntfy topic already used by the dead-man workflow and the M1 band check (`NTFY_TOPIC` read from `.env.local` on the host, never printed): `quanttrader.service` gets `SuccessExitStatus=143` (Next exits 143 on SIGTERM, so every deliberate stop ended the unit in `failed` — seen 2026-11-01 15:18Z) and `ExecStopPost=/usr/local/lib/quanttrader/notify-failure.sh`, a hook systemd runs after every stop that pushes one urgent message when `SERVICE_RESULT` is not `success`, at most one per 10 minutes; `scripts/ops/deploy.sh` posts a default-priority push on a verified deploy and an urgent one on a failed one (after the restore, saying whether the running commit's build came back, or that the failed commit is live and unverified); `scripts/ops/ops-health.sh` runs daily from the `ops` crontab (07:05 UTC) from `/usr/local/lib/quanttrader/` and posts one summary — service, crons, the live commit vs the last verified one and vs `origin/dev` (full SHAs; commits behind dev as information), Node, disk, memory, pending reboot, failed units, algorithms the kill switch still holds paused, last ledger line — at high priority only when something needs a hand; it also prunes per-run deploy logs older than 30 days.
- **Log rotation**: `ops/logrotate/quanttrader` → `/etc/logrotate.d/quanttrader`: the twelve cron and ops logs listed by name, weekly, eight rotations (seven compressed, the newest plain), rotated files owned by `ops` (`scan.log` passed 8 MB in October with no rotation). `deploys.log`, the host's deploy ledger, is never rotated; the per-run `deploy-<stamp>.log` files are pruned by age instead.
- **Nightly gate**: `.github/workflows/nightly.yml` runs `make check` and `make backtest` on `dev` at 03:17 UTC and pushes to the phone on failure — dependency, provider and environment drift that no PR touched is caught within a day. This is the CI half of D.5; the host-side parity job waits for the audit's `paper-replay.ts` (DEBT D-02).
- **Unattended reboots stay off** (`Unattended-Upgrade::Automatic-Reboot` unset); the daily summary says when a reboot is pending, and the operator takes it in a window.
- `HEARTBEAT_PING_URL` (an inverted uptime monitor such as healthchecks.io) is the operator's account to create; `scripts/heartbeat-cron.sh` already pings it when set. Until then the dead-man workflow and the host's own pushes are the two channels.

## Why

DEBT D-19: alerting covered liveness only, through GitHub Actions; a failed unit, a failed deploy or a full disk told nobody; logs grew without bound. The operator asked for alerts and hygiene after the kill switch.

## Alternatives considered

- A third-party monitoring agent: a paid or heavy dependency for one host; ntfy and systemd already exist.
- `OnFailure=` on the app unit (the first draft): fires on every deliberate stop (the unit ended in `failed` on exit 143) and never on a crash loop, because `Restart=always` with the default start limit (5 starts per 10 s against `RestartSec=5`) never reaches the `failed` state. Rejected for an `ExecStopPost=` hook that inspects `SERVICE_RESULT`.
- Reachable start limits (`StartLimitIntervalSec=300`, `StartLimitBurst=5`) so a crash loop ends `failed` and alerts: a behaviour change — the service would stay down until someone acts — for the operator to decide separately; not done here.
- Keeping the hook and the summary script in the checkout: a rollback to a commit that predates them would remove them under a unit and a crontab that reference them; they are installed to `/usr/local/lib/quanttrader/` instead and re-installed when they change.
- Automatic reboots: rejected — reboots are operator windows (standing rule), and the summary makes a pending one visible.
- Rotating daily: eight weekly archives keep two months of ticks for the audit at a few MB; daily would keep eight days.

## Consequences

- `ops/crontab` gains an 11th line; `make status` keeps showing the crontab sizes.
- The hook runs as the unit's user (`ops`) with systemd's `SERVICE_RESULT`/`EXIT_CODE`/`EXIT_STATUS`; it reads no journal, so it needs no journal group.
- The kill switch's stop now ends the unit `inactive` and sends no failure push; its KILL line reads `service=inactive`.
- Applying: `docs/runbooks/d4-alerts-and-rotation.md` (install the two host scripts to `/usr/local/lib/quanttrader/`, the logrotate file, the app unit with `SuccessExitStatus=143` and the `ExecStopPost=` hook — `daemon-reload`, no restart — and the 11-line crontab) — outside market hours, with a ledger row.
- **Applied 2026-11-01 16:01–16:07Z** (ledger row `2026-11-01T16:07:33Z` in `deploys.md`): scripts and logrotate file installed 16:01Z; unit installed and `daemon-reload` 16:07:28Z (`systemctl show` prints `143` and the `notify-failure.sh quanttrader` hook; the service was not restarted, so both apply from its next stop); crontab 11 entries 16:07:29Z; the daily-summary test push and the `result=test` hook push both sent (16:07:30Z, 16:07:32Z). The first nightly run (41324107958, dispatched 16:00:56Z) succeeded at 16:03:19Z. Steps 3–5 had to be re-run once: a burst of ssh connections hit the host's `ufw limit 22/tcp`; `make status`, `logs`, `kill-switch`, `resume` and `unpause` now share one multiplexed connection (`SSH` in the Makefile; the deploy driver keeps its own). Verified 2026-11-02 (ledger row `2026-11-02T07:05:03Z`): both test pushes received after a resend a minute apart (of the first pair, sent 2 s apart, only one arrived — unexplained, the host had a 2xx for both); the first 07:05 UTC summary logged and pushed. Still to verify: the first weekly rotation (~2026-11-09: `.1` files owned by `ops`, `deploys.log` untouched); the next `make deploy` ending the old process `inactive` with no failure push.
