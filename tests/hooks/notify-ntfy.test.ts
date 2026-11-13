/**
 * .claude/hooks/notify-ntfy.sh, run for real against a stand-in curl that records its arguments and
 * stdin and answers the way ntfy does, naming the topic. Nothing reaches ntfy. Pins what DEV_SETUP §16
 * promises: the topic and the optional access token come from files outside the repo and travel on
 * curl's stdin, never in argv, the log or the hook's output; the session name comes from the
 * transcript's titles; every path exits 0, so a missing topic or a failed push never blocks a session;
 * the log says why a push did not go out; and a turn that ends with BLOCKED ON YOU pushes once, with the
 * number of questions and never their text. settings.json runs it on both events.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HOOK = resolve(process.cwd(), ".claude/hooks/notify-ntfy.sh");
const TOPIC = "qt_test-topic42";
const TOKEN = "tk_testtoken0123456789";
// Records argv and stdin; writes ntfy's reply, which names the topic, where -o points; prints the
// status -w asks for.
const FAKE_CURL = `#!/usr/bin/env bash
{ printf 'ARGV:'; printf ' [%s]' "$@"; printf '\\nSTDIN:'; cat; printf '\\n'; } >> "$FAKE_CURL_LOG"
out=/dev/stdout
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
printf '{"topic":"%s"}\\n' "$FAKE_REPLY_TOPIC" > "$out"
printf '%s' "\${FAKE_HTTP_CODE:-200}"
exit "\${FAKE_CURL_EXIT:-0}"
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  curl: string;
  log: string;
}

interface RunOptions {
  topic?: string | null;
  token?: string;
  transcript?: string[];
  curlExit?: number;
  httpCode?: number;
  /** A root from an earlier run, to see what that run left behind. */
  root?: string;
  /** Stdin as given, instead of the payload as JSON. */
  rawInput?: string;
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qt-notify-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "curl"), FAKE_CURL);
  chmodSync(join(root, "bin", "curl"), 0o755);
  return root;
}

function hookEnv(root: string, opts: RunOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    HOME: root,
    FAKE_CURL_LOG: join(root, "curl.log"),
    FAKE_CURL_EXIT: String(opts.curlExit ?? 0),
    FAKE_HTTP_CODE: String(opts.httpCode ?? 200),
    FAKE_REPLY_TOPIC: opts.topic ?? TOPIC,
    QT_NTFY_TOPIC_FILE: join(root, "topic"),
    QT_NTFY_TOKEN_FILE: join(root, "token"),
    QT_NOTIFY_LOG: join(root, "notify.log"),
  };
}

function run(payload: Record<string, unknown>, opts: RunOptions = {}): Run & { root: string } {
  const root = opts.root ?? newRoot();
  if (opts.topic !== null) writeFileSync(join(root, "topic"), `${opts.topic ?? TOPIC}\n`);
  if (opts.token !== undefined) writeFileSync(join(root, "token"), `${opts.token}\n`);
  const transcript = join(root, "session.jsonl");
  if (opts.transcript) writeFileSync(transcript, opts.transcript.map((l) => `${l}\n`).join(""));
  const input = opts.rawInput ?? JSON.stringify({ transcript_path: transcript, ...payload });
  const result = spawnSync("bash", [HOOK], { input, encoding: "utf8", env: hookEnv(root, opts) });
  const read = (f: string) =>
    existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "";
  return {
    root,
    status: result.status,
    stdout: result.stdout + result.stderr,
    curl: read("curl.log"),
    log: read("notify.log"),
  };
}

const PROMPT = {
  hook_event_name: "Notification",
  notification_type: "permission_prompt",
  message: "Claude needs your permission",
  session_id: "16c30c82-8ba1-4fd3",
  cwd: "/work/demo-1",
};

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

  it("sends both kinds of question dialog at high priority", () => {
    for (const type of ["elicitation_dialog", "elicitation_url_dialog"]) {
      const r = run({ ...PROMPT, notification_type: type, message: "A question" });
      expect(r.curl).toContain("[Title: Claude: question for you]");
      expect(r.curl).toContain("[Priority: high]");
    }
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

  it("pushes the same questions once, and changed ones again", () => {
    const first = run({ ...STOP, last_assistant_message: BLOCKED });
    const again = run({ ...STOP, last_assistant_message: BLOCKED }, { root: first.root });
    expect(pushes(again.curl)).toBe(1);
    const nextAction = BLOCKED.replace("Next action: mine.", "Next action: yours.");
    const moved = run({ ...STOP, last_assistant_message: nextAction }, { root: first.root });
    expect(pushes(moved.curl)).toBe(1);
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
