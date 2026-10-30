# 0004 — The live-runner paths are guarded by a hook with a session override, not by a permission deny rule

**Date:** 2026-10-30 · **Status:** active · **Phase:** C.

## Decision

Edits to the live-runner paths (`src/lib/scan/`, `src/lib/brokers/`, `src/app/api/cron/`, `scripts/*-cron.sh`, the deploy scripts, `scripts/emergency-stop.sh`) are blocked by the `guard-paths` PreToolUse hook, which a session lifts with `QT_ALLOW_LIVE_EDITS=1` when its PR is about the engine. Secrets (`.env*`), pinned data and the golden JSON are blocked by **permission deny rules**, which nothing in a session can lift.

## Why

The brief asked for "deny `.env*` and live paths". Claude Code evaluates deny rules first and lets neither hooks nor allow rules nor environment variables override them. That is exactly right for secrets, pinned corpora and the golden file: no session ever has a legitimate reason to touch them by hand. It is wrong for the engine: Phase E is a sequence of PRs that edit those files deliberately, and a hard deny would mean editing the committed `settings.json` at the start and end of every such PR. A hook gives the same protection by default, explains itself when it fires, and is lifted per session by an explicit variable that the PR description can quote.

## Alternatives considered

- Deny rules for the live paths too — rejected for the reason above; it would be toggled constantly and the toggling would itself become noise in the history.
- No guard, relying on CLAUDE.md — rejected: CLAUDE.md is context, not enforcement; the docs say so.
- A `.claude/rules/*.md` file scoped to the live paths — useful as context, not a block; may be added later.

## Consequences

- A session that needs to edit the engine starts with `QT_ALLOW_LIVE_EDITS=1`, and its PR title says it touches the engine, crons or deploy. **Not before the audit verdict** (operator, 2026-10-30): until then no session sets it.
- The variable is never set in a committed file or a default shell profile. `make fence-check` (in `make check` and CI) fails if `QT_ALLOW_LIVE_EDITS` or `QT_STOP_VALIDATE` is assigned anywhere tracked outside the docs and the hooks that read them.
- While the variable is set, `guard-paths` emits a one-line `FENCE DOWN` notice for every live-path edit, so a transcript shows when the fence was down.
- `guard-bash` applies the same fence to shell writes into the live paths (in-place `sed`/`perl`, redirects, `cp`/`mv`/`rm`, `git checkout`/`restore`, fixers), with the same override and the same notice. The one list of live paths both hooks read is `.claude/hooks/live-paths.txt`: the scan engine, the broker adapters, every API route, the cron wrappers, the scripts they invoke, the deploy scripts and the baseline harness library.
- `guard-bash` still blocks `.env*` reads, pinned-data and golden-input writes, `git commit --no-verify` and force/mirror/delete pushes touching `dev` or `main` regardless of the variable. These checks are pattern-based and best-effort (DEBT D-22); the permission deny rules are the hard stop for Claude's own file tools.
- `docs/DEV_SETUP.md` §16 documents both layers.

## Evidence

Claude Code permission and hook semantics as documented on 2026-10-30 (deny → ask → allow, first match wins; hooks cannot override deny; `Write(...)` path rules never match, `Edit(...)` covers all editing tools).
