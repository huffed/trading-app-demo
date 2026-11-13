# 0013 — Working with the operator: blocks visible on the phone, questions at the end, merges by the operator

**Date:** 2026-11-13 · **Status:** active · **Number:** 0012 is kept for the live-table decision the operator queued on 2026-11-07.

## Decision

- **Waits reach the phone.** A Notification hook pushes permission prompts, idle waits and requests for input to the operator's ntfy topic (`docs/DEV_SETUP.md` §16). Sessions start with `caffeinate -is claude`.
- **Questions only at the end of a turn,** under **BLOCKED ON YOU**, numbered, each with a recommended answer, together with what the session carries on with meanwhile. No turn ends with the session's own work outstanding unless its last line names the next action and who starts it.
- **Order.** The operator's queue order stands; the session's own findings go to the end as proposals. A claim about how a tool behaves says what was run to check it.
- **Merges.** The session no longer merges. A review-clean, green PR goes on the **READY TO MERGE** list, and the operator says "merge the queue". This replaces "then merge it yourself" (operator, 2026-10-30).
- **Review rounds.** A docs PR with no runnable command gets one review round. It is clean when that review reports no High, and Medium and Low findings are fixed in the same push. Runbooks, plans with host commands, code and tooling keep the review loop.

## Why

The retrospective of 2026-11-12 counted 179.5 of 364.7 tracked hours as waiting on the operator. Part of that wait the operator could not see:
- permission prompts left open for 46.2 h (stalls S1 and S3–S7);
- questions inside long reports;
- a fix promised at a hand-off that waited 75 h with nothing scheduled (E32).

Docs-only PRs took 20 review rounds, and their first reviews found no Critical and six Highs, all of them wording.

## Alternatives considered

- **A push from the Stop hook at every turn end:** rejected. It fires on turns that need nothing, whereas `idle_prompt` fires only when the session sits idle.
- **The session merging after review, the old rule:** rejected by the operator.
- **The session name from the status-line input, where Claude Code documents it:** hooks do not receive it, so the hook reads the transcript's title records and falls back to the folder name.

## Consequences

- A sleeping Mac sends nothing.
  - `caffeinate -s` holds only on AC power.
  - A closed lid on battery, or a flat battery, still sleeps the Mac.
- A prompt answered within about 6 s sends nothing, by Claude Code's design.
- The session name depends on Claude Code's internal transcript format.

## Evidence

- **A real permission prompt, logged by a temporary hook on 2026-11-12 at 23:57.**
  - Payload keys: `cwd`, `hook_event_name`, `message`, `notification_type`, `prompt_id`, `scratchpad_dir`, `session_id`, `transcript_path`.
  - Message: "Claude needs your permission". There is no session name.
- **The Claude Code hooks reference:** notification types and their timing, read 2026-11-13.
- **`pmset -g log`,** read 2026-11-13. Every sleep since 6 November was on battery. One was a "Low Power Sleep" at 1% charge on 6 November at 21:39, lasting 46,565 s.
- **Phone test:** pending; the operator confirms that a test prompt arrives within a minute.
