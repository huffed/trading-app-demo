/**
 * .claude/hooks/notify-ntfy.sh on Stop, run against the stand-in curl in ./notify-ntfy-harness: a turn that
 * ends with BLOCKED ON YOU and numbered questions pushes once, with the number of questions and never their
 * text; a push that did not go out leaves a hook message and is tried again. And settings.json runs the hook
 * on both events.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRoots, run, TOPIC } from "./notify-ntfy-harness";

afterEach(cleanupRoots);

const BLOCKED = [
  "Two PRs are ready.",
  "",
  "**BLOCKED ON YOU**",
  "1. **The topic file.** Run the command in a terminal; the secret word is hunter2.",
  "2. **Start C.** Say it when you are at the keyboard.",
  "",
  "Next action: mine.",
].join("\n");
const STOP = { hook_event_name: "Stop", session_id: "16c30c82-8ba1-4fd3", cwd: "/work/demo-1" };
const pushes = (curl: string): number => curl.split("ARGV:").length - 1;

describe("notify-ntfy hook: a turn that ends with BLOCKED ON YOU", () => {
  it("pushes the number of questions, never their text", () => {
    const r = run({ ...STOP, last_assistant_message: BLOCKED });
    expect(r.status).toBe(0);
    expect(r.curl).toContain("[Title: Claude: questions for you]");
    expect(r.curl).toContain("[Priority: high]");
    expect(r.curl).toContain("[demo-1 16c30c82\nBLOCKED ON YOU: 2 question(s)]");
    expect(r.curl).not.toContain("hunter2");
    expect(r.log).toMatch(/blocked_on_you \[demo-1 16c30c82\] sent\n$/);
  });

  it("does nothing on a turn without the heading line, even one that names it", () => {
    const text = "The rule puts questions under BLOCKED ON YOU at the end.\n1. A list item.";
    for (const message of [text, ""]) {
      const r = run({ ...STOP, last_assistant_message: message });
      expect(r.curl).toBe("");
      expect(r.log).toBe("");
      expect(r.stdout).toBe("");
    }
  });

  it("counts bold-numbered questions, and skips the heading inside a code block", () => {
    const bold = [
      "**BLOCKED ON YOU**",
      "**1. Topic file.** Run it.",
      "### Detail",
      "**2) Start C.**",
    ];
    expect(run({ ...STOP, last_assistant_message: bold.join("\n") }).curl).toContain(
      "BLOCKED ON YOU: 1 question(s)]"
    );
    const fenced = ["Example:", "```", "**BLOCKED ON YOU**", "1. A question", "```"].join("\n");
    expect(run({ ...STOP, last_assistant_message: fenced }).curl).toBe("");
  });
});

describe("notify-ntfy hook: repeats, failures and questions it cannot read", () => {
  it("says so, and pushes nothing, for a heading with no numbered question it can read", () => {
    const heading = "**BLOCKED ON YOU**";
    for (const message of [
      `${heading}\nNone.`,
      `${heading}\n 1. Indented, which is not at the start of a line`,
      `${heading}\n- 1. A bullet`,
      "**BLOCKED ON YOU** (2)\n1. Text after the heading",
    ]) {
      const r = run({ ...STOP, last_assistant_message: message });
      expect(r.curl).toBe("");
      expect(r.log).toContain("not sent: a BLOCKED ON YOU line with no numbered question");
      expect(r.stdout).toContain('"systemMessage":"Phone push for BLOCKED ON YOU: not sent');
    }
  });

  it("keeps counting past a line that starts with #339, and skips ~~~ blocks", () => {
    const hashed = "**BLOCKED ON YOU**\n1. Merge order.\n#339 has to merge first.\n2. Start C.";
    expect(run({ ...STOP, last_assistant_message: hashed }).curl).toContain(
      "BLOCKED ON YOU: 2 question(s)]"
    );
    const tilde = "~~~\n**BLOCKED ON YOU**\n1. An example\n~~~";
    expect(run({ ...STOP, last_assistant_message: tilde }).curl).toBe("");
    const inline = "```x``` is inline code\n**BLOCKED ON YOU**\n1. A question";
    expect(run({ ...STOP, last_assistant_message: inline }).curl).toContain(
      "BLOCKED ON YOU: 1 question(s)]"
    );
  });

  it("without jq, sends nothing, and says so only on a turn with questions", () => {
    const r = run({ ...STOP, last_assistant_message: BLOCKED }, { withoutJq: true });
    expect(r.curl).toBe("");
    expect(r.stdout).toContain('{"systemMessage":"Phone push: not sent, jq not found"}');
    const quiet = run({ ...STOP, last_assistant_message: "Done." }, { withoutJq: true });
    expect(quiet.stdout).toBe("");
  });

  it("pushes the same questions once, and changed ones again", () => {
    const first = run({ ...STOP, last_assistant_message: BLOCKED });
    const again = run({ ...STOP, last_assistant_message: BLOCKED }, { root: first.root });
    expect(pushes(again.curl)).toBe(1);
    const nextAction = BLOCKED.replace("Next action: mine.", "Next: I start the rebase.");
    const moved = run({ ...STOP, last_assistant_message: nextAction }, { root: first.root });
    expect(pushes(moved.curl)).toBe(1);
    const meanwhile = BLOCKED.replace("Two PRs are ready.", "Three PRs are ready.");
    const around = run({ ...STOP, last_assistant_message: meanwhile }, { root: first.root });
    expect(pushes(around.curl)).toBe(1);
    const changed = `${BLOCKED}\n`.replace("Start C.", "Start C now.");
    const third = run({ ...STOP, last_assistant_message: changed }, { root: first.root });
    expect(pushes(third.curl)).toBe(2);
  });

  it("says in the session when the push did not go out, and tries again next turn", () => {
    const missing = run({ ...STOP, last_assistant_message: BLOCKED }, { topic: null });
    expect(missing.stdout).toContain(
      '"systemMessage":"Phone push for BLOCKED ON YOU: not sent: no topic'
    );
    const refused = run(
      { ...STOP, last_assistant_message: BLOCKED },
      { curlExit: 22, httpCode: 403 }
    );
    expect(refused.stdout).toContain("push FAILED (curl exit 22, HTTP 403)");
    expect(refused.stdout).not.toContain(TOPIC);
    const retry = run({ ...STOP, last_assistant_message: BLOCKED }, { root: refused.root });
    expect(pushes(retry.curl)).toBe(2);
  });
});

describe("notify-ntfy hook: settings.json runs it", () => {
  const settings = JSON.parse(
    readFileSync(resolve(process.cwd(), ".claude/settings.json"), "utf8")
  ) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
  const commands = (event: string): string[] =>
    settings.hooks[event].flatMap((group) => group.hooks.map((h) => h.command));

  it("on the five notification types that wait on the operator", () => {
    const group = settings.hooks.Notification.find((g) =>
      g.hooks.some((h) => h.command.includes("notify-ntfy.sh"))
    );
    expect(group?.matcher?.split("|").sort()).toEqual([
      "agent_needs_input",
      "elicitation_dialog",
      "elicitation_url_dialog",
      "idle_prompt",
      "permission_prompt",
    ]);
  });

  it("at every Stop, from the project's hook directory", () => {
    expect(commands("Stop")).toContain('"${CLAUDE_PROJECT_DIR}"/.claude/hooks/notify-ntfy.sh');
  });
});

const turn = (...records: object[]): string[] => records.map((r) => JSON.stringify(r));
const prompt = { type: "user", message: { role: "user", content: "Carry on" } };
const said = (text: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolCall = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
  },
};
const toolResult = {
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
};

describe("notify-ntfy hook: questions written before the turn's last tool call", () => {
  it("pushes them from the turn's earlier text in the transcript", () => {
    const transcript = turn(prompt, said(BLOCKED), toolCall, toolResult);
    const r = run({ ...STOP, last_assistant_message: "Started the review." }, { transcript });
    expect(r.curl).toContain("BLOCKED ON YOU: 2 question(s)]");
    expect(r.log).toContain("sent (written before the turn's last tool call)");
  });

  it("never takes an earlier turn's questions for this one's", () => {
    const transcript = turn(prompt, said(BLOCKED), toolCall, toolResult, prompt, said("Done."));
    expect(run({ ...STOP, last_assistant_message: "Done." }, { transcript }).curl).toBe("");
  });
});

describe("notify-ntfy hook: heading forms and fences it reads with care", () => {
  it("says so for a heading in another form, rather than dropping it", () => {
    for (const heading of ["> **BLOCKED ON YOU**", "- **BLOCKED ON YOU**", "**Blocked on you**"]) {
      const r = run({ ...STOP, last_assistant_message: `${heading}\n1. A question` });
      expect(r.curl).toBe("");
      expect(r.stdout).toContain("not sent: a BLOCKED ON YOU line with no numbered question");
    }
  });

  it("skips a longer fence and one with an info string, and closes only on its own kind", () => {
    const inner = ["````", "```", "**BLOCKED ON YOU**", "1. Example", "```", "````"].join("\n");
    expect(run({ ...STOP, last_assistant_message: inner }).curl).toBe("");
    const info = ["```ts {1,3}", "**BLOCKED ON YOU**", "1. Example", "```"].join("\n");
    expect(run({ ...STOP, last_assistant_message: info }).curl).toBe("");
    const tildes = ["~~~", "```", "~~~", "**BLOCKED ON YOU**", "1. Real"].join("\n");
    expect(run({ ...STOP, last_assistant_message: tildes }).curl).toContain(
      "BLOCKED ON YOU: 1 question(s)]"
    );
  });
});
