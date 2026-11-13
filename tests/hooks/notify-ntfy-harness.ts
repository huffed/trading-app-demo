/**
 * Runs .claude/hooks/notify-ntfy.sh for real against a stand-in curl that records its arguments and stdin
 * and answers the way ntfy does, naming the topic. Nothing reaches ntfy. Shared by notify-ntfy.test.ts
 * (the Notification pushes) and notify-ntfy-stop.test.ts (the Stop push and settings.json).
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK = resolve(process.cwd(), ".claude/hooks/notify-ntfy.sh");
export const TOPIC = "qt_test-topic42";
export const TOKEN = "tk_testtoken0123456789";
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

/** Removes every temporary root the runs made; each test file calls it after each test. */
export function cleanupRoots(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export interface Run {
  status: number | null;
  stdout: string;
  curl: string;
  log: string;
}

export interface RunOptions {
  topic?: string | null;
  token?: string;
  transcript?: string[];
  curlExit?: number;
  httpCode?: number;
  /** A root from an earlier run, to see what that run left behind. */
  root?: string;
  /** Stdin as given, instead of the payload as JSON. */
  rawInput?: string;
  /** PATH holds only the tools the hook uses, without jq. */
  withoutJq?: boolean;
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qt-notify-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "curl"), FAKE_CURL);
  chmodSync(join(root, "bin", "curl"), 0o755);
  return root;
}

const HOOK_TOOLS = ["awk", "basename", "cat", "cksum", "cut", "date", "dirname", "grep", "head"];
const MORE_TOOLS = ["bash", "mkdir", "sed", "tail", "tr", "wc"];

/** A bin directory with links to the tools the hook uses, jq left out, beside the fake curl. */
function binWithoutJq(root: string): string {
  const dir = join(root, "nojq");
  if (!existsSync(dir)) {
    mkdirSync(dir);
    for (const tool of [...HOOK_TOOLS, ...MORE_TOOLS]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).stdout.trim();
      symlinkSync(found, join(dir, tool));
    }
    symlinkSync(join(root, "bin", "curl"), join(dir, "curl"));
  }
  return dir;
}

function hookEnv(root: string, opts: RunOptions): NodeJS.ProcessEnv {
  const path = opts.withoutJq
    ? binWithoutJq(root)
    : `${join(root, "bin")}:${process.env.PATH ?? ""}`;
  return {
    ...process.env,
    PATH: path,
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

export function run(
  payload: Record<string, unknown>,
  opts: RunOptions = {}
): Run & { root: string } {
  const root = opts.root ?? newRoot();
  if (opts.topic !== null) writeFileSync(join(root, "topic"), `${opts.topic ?? TOPIC}\n`);
  if (opts.token !== undefined) writeFileSync(join(root, "token"), `${opts.token}\n`);
  const transcript = join(root, "session.jsonl");
  if (opts.transcript) writeFileSync(transcript, opts.transcript.map((l) => `${l}\n`).join(""));
  const input = opts.rawInput ?? JSON.stringify({ transcript_path: transcript, ...payload });
  // a hook that hangs fails its test: spawnSync blocks vitest's own timeout
  const result = spawnSync("bash", [HOOK], {
    input,
    encoding: "utf8",
    env: hookEnv(root, opts),
    timeout: 10_000,
  });
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

export const PROMPT = {
  hook_event_name: "Notification",
  notification_type: "permission_prompt",
  message: "Claude needs your permission",
  session_id: "16c30c82-8ba1-4fd3",
  cwd: "/work/demo-1",
};
