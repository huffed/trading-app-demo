/**
 * .claude/hooks/notify-ntfy.sh on Stop, where its fallback starts the turn in the transcript: at the last user record
 * that is not a tool result, other than an injected one (isMeta) or a compaction summary that follows a tool result.
 * An agent's report starts a turn though Claude Code marks it isMeta; a compaction summary written in a tool loop
 * does not, and one written between turns does. A turn that
 * starts before the transcript's last 8 MB is read not at all, and logged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLOCKED,
  cleanupRoots,
  output,
  prompt,
  run,
  said,
  STOP,
  toolCall,
  toolResult,
  turn,
} from "./notify-ntfy-harness";

// Each case runs the real hook; under a loaded machine 5 s is too short.
vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanupRoots);

const report = {
  type: "user",
  isMeta: true,
  message: {
    role: "user",
    content: "Another Claude session sent a message: the review found nothing.",
  },
};
const summary = {
  type: "user",
  isCompactSummary: true,
  message: {
    role: "user",
    content: "This session is being continued from a previous conversation.",
  },
};

describe("notify-ntfy hook: where the fallback starts the turn", () => {
  it("at an agent's report, so the turn before it is not read", () => {
    const transcript = turn(prompt, said(BLOCKED), report, said("Done."));
    expect(run({ ...STOP, last_assistant_message: "Done." }, { transcript }).curl).toBe("");
  });

  it("at an agent's report, reading the questions that turn wrote before its last tool call", () => {
    const transcript = turn(prompt, said("Earlier."), report, said(BLOCKED), toolCall, toolResult);
    const r = run({ ...STOP, last_assistant_message: "Review started." }, { transcript });
    expect(r.curl).toContain("BLOCKED ON YOU: 2 question(s)]");
  });

  it("not at a compaction summary written in a tool loop", () => {
    const transcript = turn(prompt, said(BLOCKED), toolCall, toolResult, summary, said("Started."));
    const r = run({ ...STOP, last_assistant_message: "Started." }, { transcript });
    expect(r.curl).toContain("BLOCKED ON YOU: 2 question(s)]");
  });

  it("at a compaction summary written between turns", () => {
    const transcript = turn(prompt, said(BLOCKED), summary, said("Done."));
    expect(run({ ...STOP, last_assistant_message: "Done." }, { transcript }).curl).toBe("");
  });
});

describe("notify-ntfy hook: a transcript over 8 MB", () => {
  it("reads the turn when it starts in the last 8 MB", () => {
    const transcript = turn(
      prompt,
      said("Earlier."),
      toolCall,
      output(8_500_000),
      prompt,
      said(BLOCKED),
      toolCall,
      toolResult,
      said("Review started.")
    );
    const r = run({ ...STOP, last_assistant_message: "Review started." }, { transcript });
    expect(r.curl).toContain("BLOCKED ON YOU: 2 question(s)]");
  });

  it("reads nothing of a turn that starts before them, and says so", () => {
    const transcript = turn(
      prompt,
      toolCall,
      output(8_500_000),
      said(BLOCKED),
      toolCall,
      toolResult,
      said("Review started.")
    );
    const r = run({ ...STOP, last_assistant_message: "Review started." }, { transcript });
    expect(r.curl).toBe("");
    expect(r.log).toContain("found no start of this turn in the transcript's last 8 MB");
  });
});
