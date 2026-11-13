/**
 * .claude/hooks/notify-ntfy.sh, run for real against a stand-in curl that records its arguments and
 * stdin. Nothing reaches ntfy. Pins what DEV_SETUP §16 promises: the topic comes from a file outside
 * the repo and travels on curl's stdin, never in argv or the log; the session name comes from the
 * transcript's titles; and every path exits 0, so a missing topic or a failed push never blocks a
 * session.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HOOK = resolve(process.cwd(), ".claude/hooks/notify-ntfy.sh");
const TOPIC = "qt_test-topic42";
const FAKE_CURL = `#!/usr/bin/env bash
{ printf 'ARGV:'; printf ' [%s]' "$@"; printf '\\nSTDIN:'; cat; printf '\\n'; } >> "$FAKE_CURL_LOG"
exit "\${FAKE_CURL_EXIT:-0}"
`;

interface Run {
  status: number | null;
  stdout: string;
  curl: string;
  log: string;
}

function run(
  payload: Record<string, unknown>,
  opts: { topic?: string | null; transcript?: string[]; curlExit?: number } = {}
): Run {
  const root = mkdtempSync(join(tmpdir(), "qt-notify-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "curl"), FAKE_CURL);
  chmodSync(join(root, "bin", "curl"), 0o755);
  const topicFile = join(root, "topic");
  if (opts.topic !== null) writeFileSync(topicFile, `${opts.topic ?? TOPIC}\n`);
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
      QT_NTFY_TOPIC_FILE: topicFile,
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

describe("notify-ntfy hook", () => {
  it("pushes a permission prompt with the topic on curl's stdin only", () => {
    const r = run(PROMPT, {
      transcript: ['{"type":"ai-title","aiTitle":"Repository tooling","sessionId":"x"}'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const [argv, stdin] = r.curl.split("\nSTDIN:");
    expect(stdin).toContain(`url = "https://ntfy.sh/${TOPIC}"`);
    expect(argv).not.toContain(TOPIC);
    expect(argv).toContain("[Title: Claude: permission needed]");
    expect(argv).toContain("[Priority: high]");
    expect(argv).toContain("Repository tooling\nClaude needs your permission");
    expect(r.log).toMatch(/permission_prompt \[Repository tooling\] sent\n$/);
    expect(r.log).not.toContain(TOPIC);
  });

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

  it("sends nothing and exits 0 when the topic file is missing", () => {
    const r = run(PROMPT, { topic: null });
    expect(r.status).toBe(0);
    expect(r.curl).toBe("");
    expect(r.log).toContain("not sent: no topic in");
  });

  it("sends nothing when the topic file holds anything but a plain topic", () => {
    for (const topic of ["ntfy.sh/abc", "a b", "x;touch y", "a".repeat(65)]) {
      const r = run(PROMPT, { topic });
      expect(r.status).toBe(0);
      expect(r.curl).toBe("");
      expect(r.log).toContain("not a plain ntfy topic");
    }
  });

  it("logs a failed push and still exits 0", () => {
    const r = run(PROMPT, { curlExit: 22 });
    expect(r.status).toBe(0);
    expect(r.log).toContain("push FAILED (curl exit 22)");
  });

  it("survives malformed input without blocking", () => {
    const root = mkdtempSync(join(tmpdir(), "qt-notify-bad-"));
    const result = spawnSync("bash", [HOOK], {
      input: "not json",
      encoding: "utf8",
      env: { ...process.env, HOME: root, QT_NTFY_TOPIC_FILE: join(root, "none") },
    });
    expect(result.status).toBe(0);
  });
});
