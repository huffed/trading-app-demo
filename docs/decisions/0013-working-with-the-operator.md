# 0013 — Working with the operator: blocks visible on the phone, questions at the end, merges by the operator

**Date:** 2026-11-13 · **Status:** active · **Number:** 0012 is kept for the live-table decision the operator queued on 2026-11-07.

## Decision

- **Waits reach the phone.** One hook script pushes to the operator's ntfy topic, with the access token if the topic is reserved (`docs/DEV_SETUP.md` §16). On Notification it pushes permission prompts, idle waits and requests for input. On Stop it pushes a turn whose last message has the **BLOCKED ON YOU** line, at once and once per set of questions, because Claude Code holds the idle push back while a background agent runs. Sessions start with `caffeinate -is claude`.
- **Questions only at the end of a turn,** under a line that reads **BLOCKED ON YOU**, numbered, each with a recommended answer, together with what the session carries on with meanwhile; later turns repeat them while they are open. A turn ends with READY TO MERGE, then BLOCKED ON YOU, then a last line that names the next action and who starts it.
- **Order.** The operator's queue order stands; the session's own findings go to the end as proposals. A claim about how a tool behaves says what was run to check it.
- **Merges.** The session no longer merges on its own. A review-clean, green PR goes on the **READY TO MERGE** list, and the operator says "merge the queue". The session then merges each listed PR in order. Because `protect-dev` requires an up-to-date branch, a PR behind `dev` is first rebased with `gh pr update-branch <n> --rebase` and merged once CI is green at the new head; a PR whose rebase conflicts leaves the list until it is resolved and reviewed again. This replaces "then merge it yourself" (operator, 2026-10-30).
- **Review rounds.** A docs PR with no runnable command gets one review round. It is clean when that review reports no Critical or High, and Medium and Low findings are fixed in the same push; a Critical or High is fixed and gets one more review under the same rule. Runbooks, plans with host commands, code and tooling keep the review loop, which ends at a review of the whole PR with no Critical, High or Medium. Reviews label every finding.

## Why

The session's retrospective of Parts A and B (2026-11-12; a private document outside this repo) counted 179.5 of 364.7 tracked hours as waiting on the operator. Part of that wait the operator could not see:
- permission prompts left open for 46.2 h (stalls S1 and S3–S7);
- questions inside long reports;
- a fix promised at a hand-off that waited 75 h with nothing scheduled (E32).

Docs-only PRs took 20 review rounds, and their first reviews found no Critical and six Highs, all of them wording.

## Alternatives considered

- **A `systemMessage` from the hook when a push fails, so the session shows it:** not possible. The hooks reference says a Notification hook's `systemMessage` is discarded, and its exit code ignored.
- **A push from the Stop hook at every turn end:** rejected; most turns need nothing. The Stop hook pushes only a turn with the BLOCKED ON YOU line.
- **The session reading the hook's log before a BLOCKED ON YOU turn ends** (this PR's first fix): replaced. A turn's idle push fires after the turn, so the read saw an earlier push, and the idle push never comes while a background agent runs (review of 2026-11-13).
- **The session merging after review, the old rule:** rejected by the operator.
- **The session name from the status-line input, where Claude Code documents it:** hooks do not receive it, so the hook reads the transcript's title records and falls back to the folder name.

## Consequences

- A sleeping Mac sends nothing.
  - `caffeinate -s` holds only on AC power.
  - A closed lid on battery, or a flat battery, still sleeps the Mac.
- A prompt answered within about 6 s sends nothing, by Claude Code's design. The idle push waits for background agents; the Stop push does not.
- Nothing is sent until the topic file exists. A reserved topic also needs the token file, and without it ntfy refuses the push; the log line then names the token file.
- The session name depends on Claude Code's internal transcript format.

## Evidence

- **A real permission prompt, logged by a temporary hook on 2026-11-12 at 23:57.**
  - Payload keys: `cwd`, `hook_event_name`, `message`, `notification_type`, `prompt_id`, `scratchpad_dir`, `session_id`, `transcript_path`.
  - Message: "Claude needs your permission". There is no session name.
- **The Claude Code hooks reference,** read 2026-11-13: the notification types and their timing; a Notification hook's exit code and stderr are ignored and its `systemMessage` is discarded; Stop runs when the main agent has finished responding, its input carries `last_assistant_message` and `background_tasks`, and the page does not say whether a Stop hook's `systemMessage` is shown.
- **The Stop push, run for real on 2026-11-13 at 09:51Z** at the end of a turn with a BLOCKED ON YOU line and no topic file: the log has `blocked_on_you … not sent: no topic`, and the transcript has the hook's notice as a `hook_system_message` attachment.
- **curl 8.7.1 on the workstation, checked offline with `--libcurl` on 2026-11-13.** `--data-binary` with a body starting with `@` exits 26 and sends nothing, `--data-raw` sends the same body as text, and a `header =` line in the stdin config is sent.
- **`protect-dev`,** read with `gh api` on 2026-11-13: its required-checks rule has `strict_required_status_checks_policy: true`, so a PR must be up to date with `dev` to merge.
- **`pmset -g log`,** read 2026-11-13. Every sleep since 6 November was on battery. One was a "Low Power Sleep" at 1% charge on 6 November at 21:39, lasting 46,565 s.
- **Phone test:** pending; the operator confirms that a test prompt arrives within a minute.
