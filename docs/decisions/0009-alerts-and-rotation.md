# 0009 — Alerts from the host itself, log rotation, and a nightly gate on dev

**Date:** 2026-11-01 · **Status:** active · **Phase:** D.4 (and the CI half of D.5).

## Decision

- **The host alerts on its own**, through the ntfy topic already used by the dead-man workflow and the M1 band check (`NTFY_TOPIC` read from `.env.local` on the host, never printed): `quanttrader.service` gets `OnFailure=quanttrader-failure.service`, a one-shot unit that posts an urgent push with the unit's last journal lines when systemd gives up restarting the app; `scripts/ops/deploy.sh` posts a default-priority push on a verified deploy and an urgent one on a failed one; `scripts/ops/ops-health.sh` runs daily from the `ops` crontab (07:05 UTC) and posts one summary — service, crons, running commit vs `origin/dev`, Node, disk, memory, pending reboot, failed units, kill-switch state, last ledger line — at high priority only when something needs a hand.
- **Log rotation**: `ops/logrotate/quanttrader` → `/etc/logrotate.d/quanttrader`: weekly, eight rotations, compressed, rotated files owned by `ops` (`scan.log` passed 8 MB in October with no rotation).
- **Nightly gate**: `.github/workflows/nightly.yml` runs `make check` and `make backtest` on `dev` at 03:17 UTC and pushes to the phone on failure — dependency, provider and environment drift that no PR touched is caught within a day. This is the CI half of D.5; the host-side parity job waits for the audit's `paper-replay.ts` (DEBT D-02).
- **Unattended reboots stay off** (`Unattended-Upgrade::Automatic-Reboot` unset); the daily summary says when a reboot is pending, and the operator takes it in a window.
- `HEARTBEAT_PING_URL` (an inverted uptime monitor such as healthchecks.io) is the operator's account to create; `scripts/heartbeat-cron.sh` already pings it when set. Until then the dead-man workflow and the host's own pushes are the two channels.

## Why

DEBT D-19: alerting covered liveness only, through GitHub Actions; a failed unit, a failed deploy or a full disk told nobody; logs grew without bound. The operator asked for alerts and hygiene after the kill switch.

## Alternatives considered

- A third-party monitoring agent: a paid or heavy dependency for one host; ntfy and systemd already exist.
- Automatic reboots: rejected — reboots are operator windows (standing rule), and the summary makes a pending one visible.
- Rotating daily: eight weekly archives keep two months of ticks for the audit at a few MB; daily would keep eight days.

## Consequences

- `ops/crontab` gains an 11th line; `make status` keeps showing the crontab sizes.
- The failure unit runs as `ops` and reads the env file like the wrappers do.
- Applying: `docs/runbooks/d4-alerts-and-rotation.md` (install the logrotate file, the failure unit, the app unit's `OnFailure=` with a `daemon-reload` and no restart, the crontab) — outside market hours, with a ledger row.
