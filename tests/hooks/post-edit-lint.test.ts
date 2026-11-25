/**
 * post-edit-lint.sh chooses the checks a written file gets. These tests run the hook against a throwaway git repo with a
 * fake pnpm first on the PATH: it records each call and fails as Prettier and ESLint fail on an unformatted file that
 * breaks a rule, so the hook's message and its recorded calls show which config it chose. Nothing here runs the real
 * Prettier or ESLint.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Each hook run is bounded at 20 s below; vitest's 5 s default would cut a slow run under load first.
vi.setConfig({ testTimeout: 60_000 });

const HOOK = resolve(__dirname, "..", "..", ".claude", "hooks", "post-edit-lint.sh");
const STRICT = "--config eslint.config.strict.mjs --no-ignore --no-warn-ignored";
const BASELINE = "--no-warn-ignored --quiet";

const FAKE_PNPM = `#!/usr/bin/env bash
# Fake pnpm for post-edit-lint.test.ts: records its arguments, then fails as Prettier and ESLint would.
printf '%s\\n' "$*" >> "$FAKE_PNPM_CALLS"
case "$2" in
  prettier) echo "[warn] Code style issues found in the above file. Run Prettier with --write to fix."; exit 1;;
  eslint) echo "fake eslint: 1 problem"; exit 1;;
esac
exit 0
`;

let top = "";
let repo = "";
let calls = "";

interface Run {
  status: number;
  stderr: string;
  calls: string[];
}

function git(...args: string[]): void {
  const r = spawnSync(
    "git",
    ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    {
      encoding: "utf8",
    }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function file(rel: string): void {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), "export const x = 1\n");
}

function run(filePath: string, projectDir = repo): Run {
  writeFileSync(calls, "");
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: filePath } }),
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      PATH: `${join(top, "bin")}:${process.env.PATH ?? ""}`,
      FAKE_PNPM_CALLS: calls,
    },
    timeout: 20_000,
  });
  return {
    status: r.status ?? -1,
    stderr: r.stderr,
    calls: readFileSync(calls, "utf8").split("\n").filter(Boolean),
  };
}

beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), "post-edit-lint-"));
  repo = join(top, "repo");
  calls = join(top, "calls.txt");
  mkdirSync(join(top, "bin"));
  writeFileSync(join(top, "bin", "pnpm"), FAKE_PNPM);
  chmodSync(join(top, "bin", "pnpm"), 0o755);
  mkdirSync(repo);
  git("init", "-q");
  file("review/old.ts");
  file("src/old.ts");
  git("add", ".");
  git("commit", "-q", "-m", "tracked files");
  file("review/new.ts");
  file("src/new.ts");
  file(".claude/worktrees/x/review/new.ts");
  symlinkSync(repo, join(top, "link"));
  symlinkSync(join("..", "src", "old.ts"), join(repo, "review", "link.ts"));
  symlinkSync(join("..", "src"), join(repo, "review", "out"));
  symlinkSync(join("..", "review"), join(repo, "src", "in"));
});

afterAll(() => {
  rmSync(top, { recursive: true, force: true });
});

describe("post-edit-lint.sh: which checks a written file gets", () => {
  it("a new file under review/ gets the baseline config, errors only, and no Prettier check", () => {
    const p = join(repo, "review/new.ts");
    const r = run(p);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("eslint (baseline config, errors only (review/))");
    expect(r.stderr).not.toContain("prettier");
    expect(r.calls).toEqual([`exec eslint ${BASELINE} ${p}`]);
  });

  it("a tracked file under review/ gets the same", () => {
    const p = join(repo, "review/old.ts");
    expect(run(p).calls).toEqual([`exec eslint ${BASELINE} ${p}`]);
  });

  it("a new file elsewhere still gets the strict config and the Prettier check", () => {
    const p = join(repo, "src/new.ts");
    const r = run(p);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`prettier: ${p} is not formatted`);
    expect(r.stderr).toContain("eslint (target config for a new file (eslint.config.strict.mjs))");
    expect(r.calls).toEqual([`exec prettier --check ${p}`, `exec eslint ${STRICT} ${p}`]);
  });

  it("a tracked file elsewhere gets the baseline config and the Prettier check", () => {
    const p = join(repo, "src/old.ts");
    expect(run(p).calls).toEqual([`exec prettier --check ${p}`, `exec eslint ${BASELINE} ${p}`]);
  });

  it("a review/ file named through a symlinked project root still counts as review/, either way round", () => {
    const viaRepo = join(realpathSync(repo), "review/new.ts");
    expect(run(viaRepo, join(top, "link")).calls).toEqual([`exec eslint ${BASELINE} ${viaRepo}`]);
    const viaLink = join(top, "link", "review/new.ts");
    expect(run(viaLink, realpathSync(repo)).calls).toEqual([`exec eslint ${BASELINE} ${viaLink}`]);
  });

  it("a review/ file in a Claude Code worktree copy (.claude/worktrees/<x>/) counts as review/", () => {
    const p = join(repo, ".claude/worktrees/x/review/new.ts");
    expect(run(p).calls).toEqual([`exec eslint ${BASELINE} ${p}`]);
  });

  it.runIf(process.platform === "darwin")(
    "on macOS, Review/ typed in another case counts as review/",
    () => {
      const p = join(repo, "Review/new.ts");
      expect(run(p).calls).toEqual([`exec eslint ${BASELINE} ${p}`]);
    }
  );

  it("a file in review/ that links out, or a folder in review/ that links out, gets the checks of where it leads", () => {
    for (const p of [join(repo, "review/link.ts"), join(repo, "review/out/new.ts")]) {
      expect(run(p).calls[0]).toBe(`exec prettier --check ${p}`);
    }
  });

  it("a folder elsewhere that links into review/ counts as review/", () => {
    const p = join(repo, "src/in/new.ts");
    expect(run(p).calls).toEqual([`exec eslint ${BASELINE} ${p}`]);
  });

  it("a file outside the project, in a folder called review/, gets the checks of a file elsewhere", () => {
    mkdirSync(join(top, "review"), { recursive: true });
    const p = join(top, "review", "x.ts");
    writeFileSync(p, "export const x = 1\n");
    expect(run(p).calls).toEqual([`exec prettier --check ${p}`, `exec eslint ${STRICT} ${p}`]);
  });
});
