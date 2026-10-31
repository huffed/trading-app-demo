#!/usr/bin/env bash
# ops/ufw.sh — the host firewall as applied on 2026-10-29. Idempotent; run as root.
# Default deny inbound; SSH rate-limited from anywhere; everything on the Tailscale
# interface; nothing else. The app port is not opened here on purpose: D.2 binds
# Next to loopback and serves the dashboard over Tailscale, and until then the
# absence of a 3000/tcp rule is what keeps the app off the internet.
set -euo pipefail
ufw --force default deny incoming
ufw --force default allow outgoing
ufw limit 22/tcp comment 'OpenSSH rate-limited'
ufw delete allow OpenSSH >/dev/null 2>&1 || true
ufw delete allow 22/tcp >/dev/null 2>&1 || true
ufw allow in on tailscale0 comment 'tailnet'
ufw --force enable
ufw status verbose
