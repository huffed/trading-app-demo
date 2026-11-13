/**
 * .claude/hooks/notify-ntfy.sh on Notification, run against the stand-in curl in ./notify-ntfy-harness. Pins
 * what DEV_SETUP §16 promises: the topic and the optional access token come from files outside the repo and
 * travel on curl's stdin, never in argv, the log or the hook's output; only a permission prompt sends Claude
 * Code's own message; the session name comes from the transcript's titles; every path exits 0, so a missing
 * topic or a failed push never blocks a session; and the log says why a push did not go out.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRoots, PROMPT, run, TOKEN, TOPIC } from "./notify-ntfy-harness";

afterEach(cleanupRoots);

describe("notify-ntfy hook: the topic and token stay secret", () => {
  it("pushes a permission prompt with the topic on curl's stdin only", () => {
    const r = run(PROMPT, {
      transcript: ['{"type":"ai-title","aiTitle":"Repository tooling","sessionId":"x"}'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const [argv, stdin] = r.curl.split("\nSTDIN:");
    expect(argv).toMatch(/^ARGV: \[-q\]/);
    expect(stdin).toContain(`url = "https://ntfy.sh/${TOPIC}"`);
    expect(stdin).not.toContain("Authorization");
    expect(argv).not.toContain(TOPIC);
    expect(argv).toContain("[Title: Claude: permission needed]");
    expect(argv).toContain("[Priority: high]");
    expect(argv).toContain("[--max-time] [10]");
    expect(argv).toContain("[--data-raw] [Repository tooling\nClaude needs your permission]");
    expect(r.log).toMatch(/permission_prompt \[Repository tooling\] sent\n$/);
    expect(r.log).not.toContain(TOPIC);
  });

  it("trims spaces and a CR around the topic", () => {
    const r = run(PROMPT, { topic: `  ${TOPIC} \r` });
    expect(r.curl).toContain(`url = "https://ntfy.sh/${TOPIC}"`);
  });

  it("sends the access token in curl's stdin config, never in argv, the log or the output", () => {
    const r = run(PROMPT, { token: `  ${TOKEN}\r` });
    const [argv, stdin] = r.curl.split("\nSTDIN:");
    expect(stdin).toContain(`header = "Authorization: Bearer ${TOKEN}"`);
    for (const text of [argv, r.log, r.stdout]) expect(text).not.toContain(TOKEN);
    expect(r.log).toContain("sent");
  });

  it("sends nothing when the token file holds anything but an access token", () => {
    for (const token of ["Bearer tk_abc", "tk_a b", 'tk_x"', "notatoken1"]) {
      const r = run(PROMPT, { token });
      expect(r.status).toBe(0);
      expect(r.curl).toBe("");
      expect(r.stdout).toBe("");
      expect(r.log).toContain("not an ntfy access token");
      expect(r.log).not.toContain(token);
    }
  });
});

describe("notify-ntfy hook: what the push says", () => {
  it("sends an idle wait at default priority", () => {
    const r = run({ ...PROMPT, notification_type: "idle_prompt", message: "Claude is waiting" });
    expect(r.curl).toContain("[Title: Claude: waiting for you]");
    expect(r.curl).toContain("[Priority: default]");
  });

  it("sends a background session's request for input at high priority", () => {
    const r = run({ ...PROMPT, notification_type: "agent_needs_input", message: "Waiting" });
    expect(r.curl).toContain("[Title: Claude: a background session needs you]");
    expect(r.curl).toContain("[Priority: high]");
  });

  it("sends both kinds of question dialog at high priority, with fixed text, not the dialog's", () => {
    for (const type of ["elicitation_dialog", "elicitation_url_dialog"]) {
      const r = run({
        ...PROMPT,
        notification_type: type,
        message: "Open https://x.test/?state=abc",
      });
      expect(r.curl).toContain("[Title: Claude: question for you]");
      expect(r.curl).toContain("[Priority: high]");
      expect(r.curl).toContain("A dialog in the session asks you something]");
      expect(r.curl).not.toContain("state=abc");
    }
  });

  it("sends Claude Code's own message only for a permission prompt", () => {
    const idle = run({ ...PROMPT, notification_type: "idle_prompt", message: "Anything at all" });
    expect(idle.curl).toContain("The session is waiting for your input]");
    expect(idle.curl).not.toContain("Anything at all");
    const agent = run({ ...PROMPT, notification_type: "agent_needs_input", message: "Anything" });
    expect(agent.curl).toContain("A background session is waiting for your input]");
  });

  it("sends nothing for a notification type it does not know", () => {
    const r = run({ ...PROMPT, notification_type: "auth_success", message: "Signed in" });
    expect(r.curl).toBe("");
    expect(r.log).toContain("not sent: notification type auth_success is not one this hook sends");
  });

  it("names the session by its latest custom title, then its latest ai title, then the folder", () => {
    const titled = run(PROMPT, {
      transcript: [
        '{"type":"custom-title","customTitle":"Window prep","sessionId":"x"}',
        '{"type":"ai-title","aiTitle":"Old guess","sessionId":"x"}',
        '{"type":"ai-title","aiTitle":"Newer guess","sessionId":"x"}',
      ],
    });
    expect(titled.curl).toContain("[Window prep\nClaude needs your permission]");
    const ai = run(PROMPT, {
      transcript: [
        '{"type":"ai-title","aiTitle":"Old guess","sessionId":"x"}',
        '{"type":"ai-title","aiTitle":"Newer guess","sessionId":"x"}',
      ],
    });
    expect(ai.curl).toContain("[Newer guess\n");
    const bare = run(PROMPT);
    expect(bare.curl).toContain("[demo-1 16c30c82\n");
  });

  it("passes a session name that starts with @ as text, not as a file for curl to read", () => {
    const r = run(PROMPT, {
      transcript: ['{"type":"ai-title","aiTitle":"@jack review","sessionId":"x"}'],
    });
    expect(r.curl).toContain("[--data-raw] [@jack review\nClaude needs your permission]");
    expect(r.curl).not.toContain("--data-binary");
  });
});

describe("notify-ntfy hook: a push that does not go out never blocks", () => {
  it("sends nothing and exits 0 when the topic file is missing", () => {
    const r = run(PROMPT, { topic: null });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.curl).toBe("");
    expect(r.log).toContain("not sent: no topic in");
  });

  it("sends nothing when the topic file holds anything but a plain topic, and never repeats it", () => {
    for (const topic of ["https://ntfy.sh/qtsecret1", "a b", "x;touch y", "a".repeat(65)]) {
      const r = run(PROMPT, { topic });
      expect(r.status).toBe(0);
      expect(r.curl).toBe("");
      expect(r.stdout).toBe("");
      expect(r.log).toContain("not a plain ntfy topic");
      expect(r.log).not.toContain(topic);
    }
  });

  it("logs a refused push with its status, and a hint when no token was sent", () => {
    const r = run(PROMPT, { curlExit: 22, httpCode: 403 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.log).toContain(
      "push FAILED (curl exit 22, HTTP 403); a reserved topic needs the token file"
    );
    expect(r.log).not.toContain(TOPIC);
    const withToken = run(PROMPT, { token: TOKEN, curlExit: 22, httpCode: 403 });
    expect(withToken.log).toMatch(/push FAILED \(curl exit 22, HTTP 403\)\n$/);
  });

  it("survives malformed input without blocking, and sends nothing", () => {
    const r = run({}, { rawInput: "not json" });
    expect(r.status).toBe(0);
    expect(r.curl).toBe("");
  });
});
