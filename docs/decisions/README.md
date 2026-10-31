# Decisions log

One short file per choice that shapes the system: what was decided, why, when, and what the alternatives were. A decision is logged when it is made — in the same PR — or retroactively when it is discovered undocumented (marked `retro`). Reversed decisions are not deleted; a new entry supersedes the old one and both link.

Format: `NNNN-short-slug.md` with the fields **Date · Status (active / superseded by NNNN / proposed) · Decision · Why · Alternatives considered · Consequences · Evidence**. Keep each under a screen. Anything that changes `algorithms.rules` in the database, a deploy or cron script, a halt threshold, a provider, a hosting or billing choice, or a tooling rule gets an entry.

| # | Decision | Status |
|---|---|---|
| [0001](0001-remove-dead-llm-strategy-selector.md) | Remove the dead LLM strategy-template selector and 21 other unreachable files | active |
| [0002](0002-one-pr-at-a-time.md) | One PR at a time against `dev`; no stacked PRs | active |
| [0003](0003-paper-fills-from-twelve-data.md) | Paper fills come from Twelve Data quotes, not the OANDA bar feed (`retro`, reason not recorded) | active, under audit review |
| [0004](0004-live-path-guard-is-a-hook.md) | Live-runner paths are guarded by a hook with a session override; secrets, pinned data and the golden file by deny rules | active |
| [0005](0005-reproducible-deploy-and-production-pointer.md) | Deploys run one reviewed script on the host from `make deploy`; `main` is the production pointer that script moves; `ops/` captures the host | active |
| [0006](0006-fence-covers-trading-code-not-infrastructure.md) | The live-path fence covers trading code (exact list inside), not infrastructure; `ops/**` and `scripts/ops/**` are not fenced | active, amends 0004 |
| [deploys](deploys.md) | Ledger: one row per deploy and per host change | running |
