# 0002 — One PR at a time against `dev`; no stacked PRs

**Date:** 2026-10-30 · **Status:** active · **Phase:** B close-out, operator decision 2026-10-30.

## Decision

Every PR targets `dev`. A PR whose base is another PR's branch is not allowed. Work that depends on an open PR waits for it to merge, then rebases onto `dev` and opens its own PR. Merges are squash merges; the `protect-dev` ruleset requires linear history. Independent PRs may run in parallel.

## Why

Phase B shipped as twelve stacked PRs (#293–#304) on top of #292. Squash-merging #292 produced a commit none of the other branches descended from. GitHub then reported add/add conflicts on #293 for the files both sides had "added" (the Phase A docs), and every later PR would have done the same in turn. Recovery was a tree-preserving rebuild of each remaining branch as a single commit on `dev` (`git commit-tree`, tree hash verified identical to what CI had tested), pushed with `--force-with-lease` to the `tooling/*` branch only, CI re-run where the branch carried the workflow, then squash-merged one at a time. A one-PR-at-a-time rule costs nothing and cannot produce that state.

## Alternatives considered

- Merge commits instead of squash — rejected: the ruleset requires linear history, and a merge commit would not have undone the add/add state the first squash created.
- Keep stacking and rebase every child after each merge — rejected: that is the same per-branch rebuild, every time, without the rule that prevents it.
- Fresh branches and new PR numbers after each squash — rejected as noisier than the rebuild, which keeps the PR numbers and descriptions.

## Consequences

- Large efforts are split into sequential PRs; each merges before the next opens. A change that is started early is rebased onto `dev` before its PR is opened.
- The rule lives in `docs/DEV_SETUP.md` §15 and in CLAUDE.md "Git Workflow".

## Evidence

#293 reported `CONFLICTING` on 2026-10-29 after #292 merged as 6a07649; `git merge-tree` showed add/add on `docs/DEBT.md` and `docs/STACK.md` with merge base 3ee22e2 (the old `dev`). The rebuilt #293 (28510f1, parent 6a07649, identical tree) fast-forwarded and merged as 74ca4e5.
