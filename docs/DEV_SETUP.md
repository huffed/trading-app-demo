# DEV_SETUP — the tooling around the code

One short section per thing that was set up: **what it is, why it exists, the one command to use it.** Kept current in the same PR as the thing it describes. Sections are added as the Phase B PRs land; the command cheat-sheet in §1 is the only part you need day to day.

## 1. Cheat-sheet

| I want to… | Command | Added in |
|---|---|---|
| rotate the cron secret | `docs/runbooks/rotate-cron-secret.md` (manual, ~5 min) | PR B1 |
| harden the VPS (**Critical**: password auth is on) | `docs/runbooks/harden-vps-ssh.md` (manual, ~10 min today) | PR B1 |

(Make targets, pre-commit, CI, tests, golden file: added by the following PRs.)

## 2. Secrets — where they live and the rules

- **Local:** `.env.local` at the repo root (gitignored by `.env*`). Never committed, never read by tooling or by Claude Code sessions; only the cron wrappers grep single names out of it.
- **VPS:** `/opt/quanttrader/.env.local` (0600, root). The app loads it at start; a restart is required after any change.
- **GitHub Actions:** repo secrets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NTFY_TOPIC`, `NTFY_TOKEN` (dead-man workflow only; CI needs none).
- **`.env.example` is the index:** every variable the code reads appears there by name with a one-line purpose, values never. Adding a `process.env.X` read means adding `X` to `.env.example` in the same PR (a CI check for this arrives with the CI PR).
- **Rotation:** `docs/runbooks/rotate-cron-secret.md`. Rotate `CRON_SECRET` now — the 2026-10-28 inventory found its value in a local Claude Code allow-rule (deleted the same day; it was never committed: `git log --all -- .claude/settings.local.json` is empty).
- **Public repo = constraint.** Nothing host-identifying (IPs, user names, SSH lines) goes into the repo; use the `qt` SSH alias and a private ops note.

## 3. GitHub secret scanning and push protection (what to click)

The repo is public, so both are free. They catch a committed token at push time (push protection blocks the push) and in history (scanning alerts).

1. Repo → **Settings** → **Code security** (older UI: "Code security and analysis").
2. **Secret scanning** → **Enable**.
3. Under it, **Push protection** → **Enable**.
4. Optional: **Validity checks** → Enable (GitHub checks whether a found token is live).

Same thing from the CLI (you run it; it changes repo settings):

```bash
gh api -X PATCH repos/huffed/trading-app-demo \
  --input - <<'JSON'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
JSON
gh api repos/huffed/trading-app-demo --jq '.security_and_analysis'   # verify
```

Local equivalent (so a secret never reaches GitHub in the first place): `gitleaks` in pre-commit and CI — added by the pre-commit and CI PRs.

## 4. Runbooks

`docs/runbooks/` holds operator procedures with exact commands and a verification checklist each. Current: `rotate-cron-secret.md`, `harden-vps-ssh.md` (**Critical**). Phase D adds deploy, kill-switch, backup/restore.
