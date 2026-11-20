/**
 * One list, one meaning. guard-paths.sh (the session's fence) and scripts/ci/live-path-fence.sh (the merge-side
 * fence, docs/decisions/0015) both read .claude/hooks/live-paths.txt. This runs both over the same paths: the hook
 * with an Edit payload, as tests/hooks/hooks.test.ts does, and the CI script once over all of them; it asserts they
 * fence the same ones. The samples are made from every glob in the list (a path inside it and near misses beside
 * it), so a glob added later is covered too. The hook is frozen (operator, 2026-11-18): when this fails, the CI
 * script has moved, or the list holds a glob the two read differently.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fencedPaths, LIVE_PATHS, modified, ROOT, runGate } from "./live-path-fence-harness";

const GUARD = join(ROOT, ".claude", "hooks", "guard-paths.sh");
const GLOBS = readFileSync(LIVE_PATHS, "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"));

/** A path each glob fences, and paths beside it (most of which it does not fence). */
function samplesFor(glob: string): { inside: string; near: string[] } {
  const inside = glob.replaceAll("**", "a/b.ts").replaceAll("*", "a");
  if (glob.endsWith("/**")) {
    const dir = glob.slice(0, -3);
    return { inside, near: [dir, `${dir}-x/a.ts`, `${dir.slice(0, dir.lastIndexOf("/"))}/a.ts`] };
  }
  return { inside, near: [`${inside}.bak`, inside.replace(/(\.[a-z]+)$/, ".test$1")] };
}

const INSIDE = GLOBS.map((g) => samplesFor(g).inside);
const NEAR = GLOBS.flatMap((g) => samplesFor(g).near);
/** Paths whose result does not depend on case, so both agree on every platform. */
const HAND = [
  "tests/hooks/hooks.test.ts",
  "docs/decisions/0006-fence-covers-trading-code-not-infrastructure.md",
  "ops/crontab",
  "scripts/ops/deploy.sh",
  "scripts/ops/a-cron.sh",
  "scripts/ci/live-path-fence.sh",
  ".github/workflows/fence.yml",
  ".claude/hooks/live-paths.txt",
  "review/verdict.md",
  "src/app/(dashboard)/algorithms/page.tsx",
  "src/app/api/cron/scan/route.ts",
  "src/lib/scan/a b.ts",
  "src/lib/[x]/a.ts",
  "src/lib/scan.ts",
  "src/lib/utils/pnl.ts",
  "src/lib/algo-search/criteria.ts",
  "src/lib/constants/algorithm.ts",
  "supabase/config.toml",
];
/** Paths whose result depends on case: the hook folds case on macOS only, the CI script always. */
const CASED = ["SRC/lib/scan/engine.ts", "src/lib/Utils/Date.ts", "Scripts/manage-cron.sh"];

/** true: the hook fences the path; false: it allows it; a string: it refused for another reason, or failed. */
type HookVerdict = boolean | string;

/** Whether guard-paths.sh refuses an edit of `rel` for the live-path fence (and not for another rule). */
function hookVerdict(rel: string): Promise<HookVerdict> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: ROOT };
  delete env.QT_ALLOW_LIVE_EDITS;
  return new Promise((done) => {
    // Claude Code gives the guard 60 s (.claude/settings.json); a run past that fails here, as in tests/hooks
    const child = spawn("bash", [GUARD], { env, cwd: ROOT, timeout: 60_000 });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (status) => {
      if (status === 0) done(false);
      else if (status === 2 && stderr.includes("live-path fence")) done(true);
      else done(`guard-paths.sh gave ${String(status)} for ${rel}: ${stderr}`);
    });
    child.stdin.end(
      JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(ROOT, rel) } })
    );
  });
}

/** Runs the hook over every path, up to six at a time (each run starts node: about 0.3 s on the workstation). */
async function hookVerdicts(paths: string[]): Promise<Map<string, HookVerdict>> {
  const out = new Map<string, HookVerdict>();
  const queue = [...paths];
  const worker = async (): Promise<void> => {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
      out.set(rel, await hookVerdict(rel));
    }
  };
  const workers = Math.min(6, Math.max(2, availableParallelism() - 1));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

describe("guard-paths.sh and live-path-fence.sh fence the same paths", () => {
  const all = [
    ...new Set([...INSIDE, ...NEAR, ...HAND, ...(process.platform === "darwin" ? CASED : [])]),
  ];
  let ci = new Set<string>();
  let hook = new Map<string, HookVerdict>();
  beforeAll(async () => {
    const run = runGate({ pages: [modified(...all)] });
    expect(run.status).toBe(1);
    ci = new Set(fencedPaths(run));
    hook = await hookVerdicts(all);
  }, 120_000);
  it("the list has globs", () => {
    expect(GLOBS.length).toBeGreaterThan(0);
  });
  for (const rel of all) {
    it(rel, () => {
      const verdict = hook.get(rel);
      if (typeof verdict !== "boolean") throw new Error(verdict ?? `no hook run for ${rel}`);
      expect(ci.has(rel)).toBe(verdict);
      if (INSIDE.includes(rel)) expect(verdict).toBe(true);
    });
  }
});
