# Decisions log

One short file per choice that shapes the system: what was decided, why, when, and what the alternatives were. A decision is logged when it is made — in the same PR — or retroactively when it is discovered undocumented (marked `retro`). Reversed decisions are not deleted; a new entry supersedes the old one and both link.

Format: `NNNN-short-slug.md` with the fields **Date · Status (active / superseded by NNNN / proposed) · Decision · Why · Alternatives considered · Consequences · Evidence**. Keep each under a screen. Anything that changes `algorithms.rules` in the database, a deploy or cron script, a halt threshold, a provider, a hosting or billing choice, or a tooling rule gets an entry.

| # | Decision | Status |
|---|---|---|
| [0001](0001-remove-dead-llm-strategy-selector.md) | Remove the dead LLM strategy-template selector and 21 other unreachable files | active |
| [0002](0002-one-pr-at-a-time.md) | One PR at a time against `dev`; no stacked PRs | active |
