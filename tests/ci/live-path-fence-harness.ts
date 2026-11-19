/**
 * Runs scripts/ci/live-path-fence.sh, the merge-side live-path fence (docs/decisions/0015), the way
 * .github/workflows/fence.yml does: a base checkout, the pull request's file list as
 * `gh api --paginate repos/…/pulls/N/files` writes it (one JSON array per page), the PR's
 * `[head sha, changed_files]` read before and after the list, and HEAD_SHA and PR_TITLE in the environment.
 * The base is a temporary directory holding this repo's live-paths.txt and,
 * when asked, a review/VERDICT.md, so no test depends on what the checkout it runs in holds.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(__dirname, "..", "..");
export const LIVE_PATHS = join(ROOT, ".claude", "hooks", "live-paths.txt");
const SCRIPT = join(ROOT, "scripts", "ci", "live-path-fence.sh");

/** The head commit of the event, which GitHub reports the check on. */
export const HEAD = "a".repeat(40);

/** The title marker CLAUDE.md quotes ("Paper/live boundary"). */
export const MARKER = "[changes fenced live paths]";

/** One entry of the pulls/files API: the fields the script reads. */
export interface ApiFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  previous_filename?: string;
}

export interface GateInput {
  /** The API's pages, or raw text written as it is. */
  pages: ApiFile[][] | string;
  title?: string;
  verdict?: boolean;
  /** The PR's changed_files; defaults to the number of entries in the pages. */
  count?: number;
  /** The PR's head as read before and after the list; both default to HEAD. */
  heads?: [string, string];
  base?: string;
}

export interface GateRun {
  status: number;
  output: string;
}

export const modified = (...paths: string[]): ApiFile[] =>
  paths.map((filename) => ({ filename, status: "modified" }));

/** A base checkout: this repo's live-paths.txt, and review/VERDICT.md when `verdict`. */
export function makeBase(verdict: boolean): string {
  const base = mkdtempSync(join(tmpdir(), "fence-base-"));
  mkdirSync(join(base, ".claude", "hooks"), { recursive: true });
  copyFileSync(LIVE_PATHS, join(base, ".claude", "hooks", "live-paths.txt"));
  if (verdict) {
    mkdirSync(join(base, "review"));
    writeFileSync(join(base, "review", "VERDICT.md"), "# Verdict\n");
  }
  return base;
}

function write(dir: string, name: string, text: string): string {
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

export function runGate(input: GateInput): GateRun {
  const base = input.base ?? makeBase(input.verdict ?? false);
  const dir = mkdtempSync(join(tmpdir(), "fence-pr-"));
  const { pages } = input;
  // gh writes the pages back to back; jq reads them as a stream of arrays
  const files = typeof pages === "string" ? pages : pages.map((p) => JSON.stringify(p)).join("");
  const count = input.count ?? (typeof pages === "string" ? 0 : pages.flat().length);
  const [before, after] = input.heads ?? [HEAD, HEAD];
  // `gh api … --jq '[.head.sha, .changed_files]'` prints one compact array
  const written = [
    write(dir, "pr-files.json", files),
    write(dir, "pr-before.json", JSON.stringify([before, count])),
    write(dir, "pr-after.json", JSON.stringify([after, count])),
  ];
  const r = spawnSync("bash", [SCRIPT, base, ...written], {
    encoding: "utf8",
    env: { ...process.env, HEAD_SHA: HEAD, PR_TITLE: input.title ?? "" },
    timeout: 20_000,
  });
  return { status: r.status ?? -1, output: r.stdout + r.stderr };
}

/** The paths a run printed as fenced. */
export const fencedPaths = (run: GateRun): string[] =>
  run.output
    .split("\n")
    .filter((line) => line.startsWith("fenced: "))
    .map((line) => line.slice("fenced: ".length));
