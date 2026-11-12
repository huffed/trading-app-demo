/**
 * The Claude Code hooks are production code: these tests pipe tool payloads
 * into each hook exactly as Claude Code does and assert the exit code
 * (0 = allow, 2 = refuse) and, where it matters, the output. They also cover
 * the commit-msg hook and the fence check. Nothing here runs the commands under
 * test; the hooks only classify them. The case tables live in ./cases.ts, rule 6's (the script that turns
 * mirroring on) in ./mirror-cases.ts, and rule 8's (raw host commands) in ./host-cases.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASH_ALLOWED,
  BASH_BLOCKED,
  envFile,
  PATH_CASES,
  REVIEWER_ALLOWED,
  REVIEWER_BLOCKED,
} from "./cases";
import { GIT_ENV_ALLOWED } from "./git-env-allowed";
import { GIT_ENV_BLOCKED } from "./git-env-cases";
import { HOST_ALLOWED, HOST_BLOCKED } from "./host-cases";
import { MIRROR_ALLOWED, MIRROR_BLOCKED } from "./mirror-cases";
import { MODULE_FLAG_ALLOWED, MODULE_FLAG_BLOCKED } from "./module-flag-cases";
import {
  GIT_CD_BLOCKED,
  GIT_CWD_ALLOWED,
  GIT_CWD_BLOCKED,
  GIT_MULTI_ALLOWED,
  GIT_MULTI_BLOCKED,
  RULE1_BLOCKED,
} from "./rule1-cases";

const ROOT = resolve(__dirname, "..", "..");
const HOOKS = join(ROOT, ".claude", "hooks");

type Env = Record<string, string | undefined>;

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(name: string, payload: unknown, env: Env = {}): HookResult {
  const base: Env = { ...process.env, CLAUDE_PROJECT_DIR: ROOT };
  delete base.QT_ALLOW_LIVE_EDITS;
  delete base.QT_STOP_VALIDATE;
  const merged: NodeJS.ProcessEnv = { ...base, ...env, NODE_ENV: process.env.NODE_ENV };
  const r = spawnSync("bash", [join(HOOKS, name)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: merged,
    cwd: ROOT,
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const edit = (rel: string): unknown => ({
  tool_name: "Edit",
  tool_input: { file_path: join(ROOT, rel) },
});
const bash = (command: string): unknown => ({ tool_name: "Bash", tool_input: { command } });
const firstLine = (s: string): string => s.split("\n")[0];
const notice = (r: HookResult): string =>
  (JSON.parse(r.stdout) as { systemMessage: string }).systemMessage;

describe("guard-paths.sh (edits)", () => {
  for (const [label, rel, expected] of PATH_CASES) {
    it(label, () => {
      expect(runHook("guard-paths.sh", edit(rel)).status).toBe(expected);
    });
  }
  it("uppercase live path blocked on a case-insensitive filesystem", () => {
    const r = runHook("guard-paths.sh", edit("SRC/lib/scan/engine.ts"));
    expect(r.status).toBe(process.platform === "darwin" ? 2 : 0);
  });
  it("a case-changed project root still resolves inside the project on macOS", () => {
    if (process.platform !== "darwin") return;
    const swapped = join(
      ROOT.slice(0, -1) + ROOT.slice(-1).toUpperCase(),
      "src/lib/scan/engine.ts"
    );
    expect(
      runHook("guard-paths.sh", { tool_name: "Edit", tool_input: { file_path: swapped } }).status
    ).toBe(2);
  });
  it("override lifts the live fence and leaves a FENCE DOWN notice", () => {
    const r = runHook("guard-paths.sh", edit("src/lib/scan/engine.ts"), {
      QT_ALLOW_LIVE_EDITS: "1",
    });
    expect(r.status).toBe(0);
    expect(notice(r)).toMatch(/FENCE DOWN/);
    expect(notice(r)).toMatch(/src\/lib\/scan\/engine\.ts/);
  });
  it("override never lifts secrets, pinned data or the golden inputs", () => {
    const env = { QT_ALLOW_LIVE_EDITS: "1" };
    expect(runHook("guard-paths.sh", edit(envFile), env).status).toBe(2);
    expect(runHook("guard-paths.sh", edit("scripts/canonical/data/x.json"), env).status).toBe(2);
    expect(runHook("guard-paths.sh", edit("tests/golden/x.golden.json"), env).status).toBe(2);
  });
  it("fails closed on malformed input and on a missing path", () => {
    expect(runHook("guard-paths.sh", "not json").status).toBe(2);
    expect(runHook("guard-paths.sh", { tool_name: "Edit", tool_input: {} }).status).toBe(2);
  });
  it("paths outside the project are not its business", () => {
    const outside = { tool_name: "Write", tool_input: { file_path: "/tmp/qt-probe.txt" } };
    expect(runHook("guard-paths.sh", outside).status).toBe(0);
  });
});

describe("guard-bash.sh (shell commands)", () => {
  for (const cmd of BASH_BLOCKED) {
    it(`blocks: ${firstLine(cmd)}`, () => {
      expect(runHook("guard-bash.sh", bash(cmd)).status).toBe(2);
    });
  }
  for (const cmd of MIRROR_BLOCKED) {
    it(`blocks, under rule 6: ${firstLine(cmd)}`, () => {
      const r = runHook("guard-bash.sh", bash(cmd));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("DEBT D-33");
    });
  }
  for (const cmd of [...BASH_ALLOWED, ...MIRROR_ALLOWED]) {
    it(`allows: ${firstLine(cmd)}`, () => {
      expect(runHook("guard-bash.sh", bash(cmd)).status).toBe(0);
    });
  }
  it("override lifts the live fence for shell writes with a notice, never the secrets rule", () => {
    const env = { QT_ALLOW_LIVE_EDITS: "1" };
    const r = runHook("guard-bash.sh", bash("sed -i '' 's/a/b/' src/lib/scan/engine.ts"), env);
    expect(r.status).toBe(0);
    expect(notice(r)).toMatch(/FENCE DOWN/);
    expect(runHook("guard-bash.sh", bash(`cat ${envFile}`), env).status).toBe(2);
  });
  it("fails closed on malformed input", () => {
    expect(runHook("guard-bash.sh", "not json").status).toBe(2);
  });
});

describe("guard-bash.sh rule 8 (raw host commands reach the qt alias only, bare, so they prompt)", () => {
  for (const [cmd, reason] of HOST_BLOCKED) {
    it(`blocks: ${firstLine(cmd)}`, () => {
      const r = runHook("guard-bash.sh", bash(cmd));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(reason);
    });
  }
  for (const cmd of HOST_ALLOWED) {
    it(`allows: ${firstLine(cmd)}`, () => {
      expect(runHook("guard-bash.sh", bash(cmd)).status).toBe(0);
    });
  }
  // every one-line command to the qt alias that the runbooks give must still pass, with its trailing comment
  // dropped (the guard does not model comments); commands to other hosts are the operator's, from their terminal
  const docs = [
    ...readdirSync(join(ROOT, "docs", "runbooks")).map((f) => join("docs", "runbooks", f)),
    join("docs", "DEV_SETUP.md"),
  ].filter((f) => f.endsWith(".md"));
  for (const doc of docs) {
    const blocks = readFileSync(join(ROOT, doc), "utf8").match(/```bash\n[\s\S]*?```/g) ?? [];
    const lines = blocks
      .flatMap((b) => b.split("\n"))
      .filter((l) => /^(ssh|scp|sftp|rsync) /.test(l) && /(^|[\s'":])qt([\s:'"]|$)/.test(l))
      .map((l) => l.replace(/\s+#\s.*$/, ""));
    for (const line of lines) {
      it(`allows the runbook line in ${doc}: ${line.slice(0, 60)}`, () => {
        expect(runHook("guard-bash.sh", bash(line)).stderr).toBe("");
      });
    }
  }
});

describe("guard-bash.sh rule 1d (the git forms that print an ignored file such as .env.local)", () => {
  it("holds every git subcommand .claude/settings.json pre-approves to its short list", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8")) as {
      permissions: { allow: string[] };
    };
    // every git allow must be Bash(git <sub> *): a wider one (Bash(git *), Bash(git:*), Bash(git --no-pager log *))
    // would pre-approve forms this rule does not hold to a list
    const gitRules = settings.permissions.allow.filter((r) => /^Bash\(\s*git\b/.test(r));
    const allowed = gitRules.map(
      (r) => /^Bash\(git ([a-z-]+) \*\)$/.exec(r)?.[1] ?? `unlisted form: ${r}`
    );
    const src = readFileSync(join(HOOKS, "lib", "git-check.cjs"), "utf8");
    const listed = JSON.parse(
      /const PRE_APPROVED = (\[[^\]]*\]);/.exec(src)?.[1] ?? "[]"
    ) as string[];
    expect([...listed].sort()).toEqual([...allowed].sort());
  });
  for (const [cmd, reason] of GIT_ENV_BLOCKED) {
    it(`blocks: ${firstLine(cmd)}`, () => {
      const r = runHook("guard-bash.sh", bash(cmd));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("git can print an ignored file");
      expect(r.stderr).toContain(reason);
    });
  }
  for (const cmd of GIT_ENV_ALLOWED) {
    it(`allows: ${firstLine(cmd)}`, () => {
      expect(runHook("guard-bash.sh", bash(cmd)).status).toBe(0);
    });
  }
  for (const cmd of GIT_CD_BLOCKED) {
    it(`blocks after a cd out of the work tree: ${firstLine(cmd)}`, () => {
      const r = runHook("guard-bash.sh", bash(cmd));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("git can print an ignored file");
    });
  }
  // the shell's directory persists between calls and comes in the payload's cwd
  const fromDir = (cmd: string, dir: string): unknown => ({
    tool_name: "Bash",
    tool_input: { command: cmd },
    cwd: resolve(ROOT, dir),
  });
  for (const [cmd, dir] of GIT_CWD_BLOCKED) {
    it(`blocks from ${dir}: ${cmd}`, () => {
      const r = runHook("guard-bash.sh", fromDir(cmd, dir));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("outside the repository's work tree");
    });
  }
  for (const [cmd, dir] of GIT_CWD_ALLOWED) {
    it(`allows from ${dir}: ${cmd}`, () => {
      expect(runHook("guard-bash.sh", fromDir(cmd, dir)).status).toBe(0);
    });
  }
  it("counts .git and a nested worktree as outside the work tree", () => {
    const requireCjs = createRequire(join(ROOT, "package.json"));
    const { inWorkTree } = requireCjs(join(HOOKS, "lib", "git-check.cjs")) as {
      inWorkTree: (dir: string, root: string) => boolean;
    };
    const top = mkdtempSync(join(tmpdir(), "worktree-"));
    for (const d of ["docs", ".git", "nested/inner"]) mkdirSync(join(top, d), { recursive: true });
    writeFileSync(join(top, "nested", ".git"), "gitdir: elsewhere\n");
    expect(inWorkTree(top, top)).toBe(true);
    expect(inWorkTree(join(top, "docs"), top)).toBe(true);
    expect(inWorkTree(join(top, ".git"), top)).toBe(false);
    expect(inWorkTree(join(top, "nested"), top)).toBe(false);
    expect(inWorkTree(join(top, "nested", "inner"), top)).toBe(false);
    expect(inWorkTree(join(top, "missing"), top)).toBe(false);
    expect(inWorkTree(tmpdir(), top)).toBe(false);
  });
  for (const [cmd, reason] of GIT_MULTI_BLOCKED) {
    it(`blocks across commands: ${firstLine(cmd)}`, () => {
      const r = runHook("guard-bash.sh", bash(cmd));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(reason);
    });
  }
  for (const cmd of GIT_MULTI_ALLOWED) {
    it(`allows across commands: ${firstLine(cmd)}`, () => {
      expect(runHook("guard-bash.sh", bash(cmd)).status).toBe(0);
    });
  }
});

describe("guard-bash.sh rule 1 (readers the list did not name, and git fed names by a pipe)", () => {
  for (const cmd of RULE1_BLOCKED) {
    it(`blocks: ${firstLine(cmd)}`, () => {
      expect(runHook("guard-bash.sh", bash(cmd)).status).toBe(2);
    });
  }
});

describe("guard-bash.sh rule 7 (a pre-approved prettier, vitest or tsc takes only its short list of flags)", () => {
  for (const cmd of MODULE_FLAG_BLOCKED) {
    it(`blocks: ${firstLine(cmd)}`, () => {
      const r = runHook("guard-bash.sh", bash(cmd));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("a pre-approved");
    });
  }
  for (const cmd of MODULE_FLAG_ALLOWED) {
    it(`allows: ${firstLine(cmd)}`, () => {
      expect(runHook("guard-bash.sh", bash(cmd)).status).toBe(0);
    });
  }
});

describe("reviewer-bash-allowlist.sh (read-only reviewer)", () => {
  for (const cmd of REVIEWER_ALLOWED) {
    it(`allows: ${firstLine(cmd)}`, () => {
      expect(runHook("reviewer-bash-allowlist.sh", bash(cmd)).status).toBe(0);
    });
  }
  for (const cmd of REVIEWER_BLOCKED) {
    it(`blocks: ${firstLine(cmd)}`, () => {
      expect(runHook("reviewer-bash-allowlist.sh", bash(cmd)).status).toBe(2);
    });
  }
  it("fails closed on malformed or empty input", () => {
    expect(runHook("reviewer-bash-allowlist.sh", "not json").status).toBe(2);
    expect(runHook("reviewer-bash-allowlist.sh", bash("")).status).toBe(2);
  });
});

describe("stop-validate.sh", () => {
  it("is silent unless QT_STOP_VALIDATE=1", () => {
    expect(runHook("stop-validate.sh", { stop_hook_active: false }).status).toBe(0);
  });
  it("does not loop when the stop was caused by a hook", () => {
    expect(
      runHook("stop-validate.sh", { stop_hook_active: true }, { QT_STOP_VALIDATE: "1" }).status
    ).toBe(0);
  });
});

describe(".husky/commit-msg", () => {
  const dir = mkdtempSync(join(tmpdir(), "qt-commit-msg-"));
  const check = (message: string): number => {
    const f = join(dir, `${String(Math.random()).slice(2)}.txt`);
    writeFileSync(f, message);
    return (
      spawnSync("sh", [join(ROOT, ".husky", "commit-msg"), f], { encoding: "utf8" }).status ?? -1
    );
  };
  it("rejects every attribution form", () => {
    expect(check("feat: x\n\nCo-Authored-By: Someone <a@b.c>\n")).toBe(1);
    expect(check("feat: x\n\nco-authored-by: someone\n")).toBe(1);
    expect(
      check("feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n")
    ).toBe(1);
    expect(check("feat: x\n\nGenerated with Claude Code\n")).toBe(1);
    expect(check("feat: x\n\nGenerated by Claude\n")).toBe(1);
  });
  it("accepts a plain message, including one that talks about the rule", () => {
    expect(check("feat: x\n\nplain body mentioning a robot without the trailer\n")).toBe(0);
    expect(
      check("test(golden): regenerated with make backtest-update after the CLAUDE.md pointer fix\n")
    ).toBe(0);
    expect(check("docs: the commit-msg hook rejects Co-Authored-By lines\n")).toBe(0);
  });
});

describe("make fence-check", () => {
  it("finds no committed switch", () => {
    const r = spawnSync("node", [join(ROOT, "scripts", "dev", "fence-check.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no committed file sets/);
  });
});
