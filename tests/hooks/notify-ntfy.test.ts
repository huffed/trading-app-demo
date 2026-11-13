/**
 * .claude/hooks/notify-ntfy.sh, run for real against a stand-in curl that records its arguments and
 * stdin and answers the way ntfy does, naming the topic. Nothing reaches ntfy. Pins what DEV_SETUP §16
 * promises: the topic and the optional access token come from files outside the repo and travel on
 * curl's stdin, never in argv, the log or the hook's output; the session name comes from the
 * transcript's titles; every path exits 0 and prints nothing, so a missing topic or a failed push
 * never blocks a session; and the log says why a push did not go out.
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

function run(
  payload: Record<string, unknown>,
  opts: {
    topic?: string | null;
    token?: string;
    transcript?: string[];
    curlExit?: number;
    httpCode?: number;
  } = {}
): Run {
  const root = mkdtempSync(join(tmpdir(), "qt-notify-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "curl"), FAKE_CURL);
  chmodSync(join(root, "bin", "curl"), 0o755);
  const topicFile = join(root, "topic");
  if (opts.topic !== null) writeFileSync(topicFile, `${opts.topic ?? TOPIC}\n`);
  const tokenFile = join(root, "token");
  if (opts.token !== undefined) writeFileSync(tokenFile, `${opts.token}\n`);
  const transcript = join(root, "session.jsonl");
  if (opts.transcript) writeFileSync(transcript, opts.transcript.map((l) => `${l}\n`).join(""));
  const input = JSON.stringify({ transcript_path: transcript, ...payload });
  const result = spawnSync("bash", [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
      HOME: root,
      FAKE_CURL_LOG: join(root, "curl.log"),
      FAKE_CURL_EXIT: String(opts.curlExit ?? 0),
      FAKE_HTTP_CODE: String(opts.httpCode ?? 200),
      FAKE_REPLY_TOPIC: opts.topic ?? TOPIC,
      QT_NTFY_TOPIC_FILE: topicFile,
      QT_NTFY_TOKEN_FILE: tokenFile,
      QT_NOTIFY_LOG: join(root, "notify.log"),
    },
  });
  const read = (f: string) =>
    existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "";
  return {
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

  it("survives malformed input without blocking", () => {
    const root = mkdtempSync(join(tmpdir(), "qt-notify-bad-"));
    roots.push(root);
    const result = spawnSync("bash", [HOOK], {
      input: "not json",
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        QT_NTFY_TOPIC_FILE: join(root, "none"),
        QT_NOTIFY_LOG: join(root, "notify.log"),
      },
    });
    expect(result.status).toBe(0);
  });
});
