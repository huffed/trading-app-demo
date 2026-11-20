# 0015 — The live-path fence also runs on GitHub, from `dev`'s copy

**Date:** 2026-11-18 · **Status:** active, amends [0004](0004-live-path-guard-is-a-hook.md) (the title rule is now the exact marker below); the event policy is added once this is on `dev`, before 2 December 2026, and the required check only as "Making it required" says · **Phase:** C follow-up.

## Decision

A job, `live-path fence` (`.github/workflows/fence.yml`, which runs `scripts/ci/live-path-fence.sh`), runs on every pull request into `dev` when it is opened, pushed to (`synchronize`), reopened, edited (a title change re-runs it) or marked ready for review. It lists the files the PR changes against its base through the API (`pulls/N/files`, every page). A deletion counts under its path and a rename under both names, so a move out of a fenced path is fenced. The job fails when any path matches a glob in `.claude/hooks/live-paths.txt`, unless both of these hold:

1. `review/VERDICT.md` is already on `dev`, read from the job's checkout of `dev`, never from the PR;
2. the PR's title contains `[changes fenced live paths]`, exactly: those words, that case, the brackets.

The globs are the one list the hooks read, matched as `guard-paths.sh` matches them: a shell `case` pattern, where `*` (so `**` too) crosses `/`, after lower-casing ASCII, as the hook does on macOS. `tests/ci/live-path-fence-agreement.test.ts` runs the hook and the script over the same paths and fails if they disagree. The paths are one inside every glob and near misses beside it, plus hand-picked ones. The job fails closed on input it cannot read: a PR whose two reads, just before and just after the list, do not both show the event's head commit (the one the check is reported on; the list itself is not addressed by a sha, D-48), a list of 3,000 files (the API's cap), a list shorter than the PR's `changed_files` (the API stops at 3,000 files), a page that is not the API's shape, a path holding a control character, or a base with no list.

## Why it runs `dev`'s copy

Under `pull_request`, GitHub runs the PR's own copy of the workflow, the script and `live-paths.txt`, so a PR that edits them decides its own check. Under `pull_request_target`, it runs the default branch's copies. Since 2025-12-08 GitHub reads that trigger's workflow and checkout from the default branch, whatever the PR's base, and here the default branch is `dev`, the base of every PR this job checks. That trigger also runs with a token in the default branch's context, so the job never checks out, fetches or runs the PR's code: the API's file list and `dev`'s tree are all it reads. Its token has `contents: read` and `pull-requests: read` only, and the title reaches the script through `env`, never through `${{ }}` in `run:`. A `pull_request_target` run reports its check on the PR's head commit, so the check can be required (Evidence). So a PR cannot change this workflow's copy.

It can probably still answer the check itself. GitHub's troubleshooting page for rules says: "Required status checks do not take workflow, matrix, or event trigger types into account." A workflow job's check is named by its job name, and the `integration_id` pin is per app, so two GitHub Actions runs both pass it. A PR that adds or changes a workflow on `push` or `pull_request` (`ci.yml` runs on a push to every branch) with a job named `live-path fence`, or whose workflow posts a check run of that name with `checks: write`, would put a second check of that name on the same head commit. The docs are silent on which of two same-named check runs on one head commit decides: the latest, the earliest, or all. They document no rule that requires one workflow file and no way to pin a required check to one; the branch-protection page advises unique job names across workflows. Unless GitHub requires every check run of that name to pass (undocumented), a PR that adds or changes a workflow on `push` or `pull_request` can answer the check, and the required check is only advisory against it (D-48).

The fence's own files are not fenced: the workflow, the script and `live-paths.txt`. They are tooling, not trading code (decision 0006), and a PR that changes them still runs `dev`'s copies. Its change applies from the next PR. So a PR that narrows the list and a later PR that changes the path it opened would both pass. The job prints a warning on a PR that changes `.github/workflows/`, the script, the list or `review/VERDICT.md`, whose arrival on `dev` opens the gate; review is the stop (D-48).

## Allowing the trigger, before 2 December 2026

From 2026-12-02 GitHub blocks `pull_request_target` by default in public repositories, unless an Actions event policy allows it. This repository is public and has no repository policy (`gh api repos/huffed/trading-app-demo/actions/policies` returned `{"total_count":0,"policies":[]}` on 2026-11-18). Without one, from that date the job does not run. Once it is a required check, every PR into `dev` is then blocked: the job fails closed, but it stops all merges. The operator allows the trigger for this one workflow, in Settings → Actions → Policies or with this call (from GitHub's REST docs, read 2026-11-18; not run; that a repository policy lifts GitHub's default is the changelog's wording, not tested):

```bash
gh api -X POST repos/huffed/trading-app-demo/actions/policies --input - <<'JSON'
{ "name": "fence: allow pull_request_target", "enforcement": "active",
  "conditions": { "workflow_path": { "include": [".github/workflows/fence.yml"], "exclude": [] } },
  "rules": [ { "type": "restrict_action_events", "parameters": { "allowed_events": ["pull_request_target"] } } ] }
JSON
```

If the operator would rather not allow the trigger, the fallback is `pull_request`, which runs the PR's own copy (Alternatives).

## Emergency override

These are options for the operator; none was tested. `protect-dev` has no bypass actors (`bypass_actors: []`, `current_user_can_bypass: never`, read 2026-11-18), so a required check cannot be skipped without changing the ruleset. In an emergency the operator can:

1. remove `live-path fence` from the ruleset's required checks, merge the one PR, and add it back with the call in "Making it required". The removal is the same three commands with this filter in place of the `+=`: `.parameters.required_status_checks |= map(select(.context != "live-path fence"))`. While the check is removed, any open PR can merge, not only the one meant; or
2. add the repository admin role as a bypass actor (`{"actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "pull_request"}`), merge that one PR with "bypass rules", and remove the actor. The rulesets docs say bypass-list actors can only be added when the repository belongs to an organization. This one belongs to a personal account, so this option may not exist here (untested; the role id is from GitHub's REST docs).

Either gets a ledger row in `docs/decisions/deploys.md`: what was done, for which PR, and when the check came back. GitHub keeps the ruleset's history too. Disabling the workflow, or the event policy, is not an override, because a required check that never reports blocks every PR.

## Making it required

The ruleset allows it: `protect-dev` (id 26211551) already has a `required_status_checks` rule with three contexts. The `PUT` waits until the same-name behaviour above is tested and recorded; the operator decides whether to test it and where (a throwaway repository, or a draft PR here that adds a job of the same name). When it runs, this adds a fourth context and keeps every other field as read; the files go to the temporary directory, not the checkout:

```bash
gh api repos/huffed/trading-app-demo/rulesets/26211551 > "${TMPDIR:-/tmp}/protect-dev.json"
jq '{name, target, enforcement, conditions, bypass_actors, rules: [.rules[] | if .type == "required_status_checks" then .parameters.required_status_checks += [{"context": "live-path fence", "integration_id": 15368}] else . end]}' "${TMPDIR:-/tmp}/protect-dev.json" > "${TMPDIR:-/tmp}/protect-dev-new.json"
gh api -X PUT repos/huffed/trading-app-demo/rulesets/26211551 --input "${TMPDIR:-/tmp}/protect-dev-new.json"
```

`integration_id` 15368 is the GitHub Actions app, so a commit status posted by hand with that name does not count; a run of another GitHub Actions workflow does. Run it only after this PR is on `dev` and the event policy above is in place: before that, no PR gets the check, and a required check that never reports blocks every merge. PRs already open get the check on their next event: a push, an edit of the title or body, or a reopen.

## Alternatives considered

- **`pull_request`:** rejected, because it runs the PR's own copy, so a PR could edit its own check. It is the fallback if the operator does not allow `pull_request_target`.
- **`pull_request_target` with a fetch of the PR's head for `git diff`:** rejected. It brings the PR's objects into a job that holds a token; the API gives the list without them.
- **A matcher in TypeScript or jq:** rejected. It would be a second implementation of `case` matching; the bash loop is the hook's own.
- **Fencing the fence's files in `live-paths.txt`:** not taken. It would also freeze them in every session until the verdict, and decision 0006 keeps the list to trading code. It is the operator's call, and one line per file.

## Consequences

- On the open PRs, run on their API file lists on 2026-11-18: #291 fails. It changes 13 files, 8 of them fenced (7 under `src/lib/scan/` and the migration `00053`); `dev` has no verdict and the title has no marker. #352 passes: it changes `tests/` and `docs/` only (8 files).
- If the default branch stops being `dev` (Phase D sorts out `main`), the job reads that branch's list and `review/VERDICT.md`; this decision is then revisited.
- A re-run reads the original event again, with its title and its `dev`. After the verdict lands, a fenced PR is decided again by its next push or title edit; `protect-dev`'s up-to-date rule forces a rebase in any case.
- `CLAUDE.md`'s "Paper/live boundary" bullet quotes the marker. `docs/DEV_SETUP.md` §11 lists the job and §12 the two calls. `make lint-shell` and lint-staged cover `scripts/ci/*.sh`.

## Evidence

- `protect-dev`, read 2026-11-18 (`gh api repos/huffed/trading-app-demo/rulesets/26211551`): enforcement active; deletion, non_fast_forward, required_linear_history, pull_request and required_status_checks (strict; `lint · typecheck · test · build`, `target rules on files added in this PR`, `gitleaks`); no bypass actors. The `jq` step above was run on that read; it changes only the checks list. The `PUT` was not run.
- Where a `pull_request_target` check is reported, read 2026-11-18 on a public repository: amannn/action-semantic-pull-request's run 43045918373 (event `pull_request_target`) has check suite 116569928990, whose check run `main` is on `cbdb089`, the head of that repository's PR #325.
- GitHub's changelogs, read 2026-11-18: "Actions pull_request_target and environment branch protections changes" (2025-11-07; the workflow file and checkout commit come from the default branch from 2025-12-08) and "pull_request_target blocked by default December 2" (2026-11-02; public repositories only). `actions/checkout`'s v7 refusals (changelog 2026-06-18) cover fork heads only, not the default checkout used here.
- App id 15368 (`github-actions`) on `dev`'s three check runs at `ea75c40`, read 2026-11-18.
- GitHub's docs, read by the coordinator on 2026-11-18: the rulesets troubleshooting page ("Required status checks do not take workflow, matrix, or event trigger types into account"); the available-rules page (no rule that requires a workflow to pass); the branch-protection page (unique job names across workflows); the rulesets page (bypass-list actors only in organization repositories).
- Not checked: which of two same-named check runs on one head commit decides a required check; the docs are silent (D-48).
