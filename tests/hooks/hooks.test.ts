/**
 * The Claude Code hooks are production code: these tests pipe tool payloads
 * into each hook exactly as Claude Code does and assert the exit code
 * (0 = allow, 2 = refuse) and, where it matters, the output. They also cover
 * the commit-msg hook and the fence check. Nothing here runs the commands under
 * test; the hooks only classify them.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
const envFile = ".env" + ".local"; // keep the literal out of the source text the guards scan
const firstLine = (s: string): string => s.split("\n")[0];

const PATH_CASES: [string, string, number][] = [
  ["live path blocked", "src/lib/scan/engine.ts", 2],
  ["broker adapter blocked", "src/lib/brokers/metaapi.ts", 2],
  ["api route blocked (admin too)", "src/app/api/admin/flatten-algo/route.ts", 2],
  ["cron wrapper blocked", "scripts/manage-cron.sh", 2],
  ["cron-invoked script blocked", "scripts/canonical/m1-progress.ts", 2],
  ["deploy script blocked", "scripts/canonical/deploy-arb-daily-bias.ts", 2],
  ["pinned data blocked", "scripts/canonical/data/xau-usd-h4-pinned.json", 2],
  ["golden json blocked", "tests/golden/xau-usd-h4-2026h1.golden.json", 2],
  ["golden rules fixture blocked", "tests/golden/deployed-rules-2026-10-28.json", 2],
  ["secrets blocked", envFile, 2],
  [".env.example allowed", ".env.example", 0],
  ["ordinary component allowed", "src/components/analytics/tooltip-style.ts", 0],
  ["golden replay code allowed", "tests/golden/replay.ts", 0],
  ["docs allowed", "docs/DEV_SETUP.md", 0],
  ["traversal into a live path blocked", "docs/../src/lib/scan/engine.ts", 2],
  ["worktree copy of a live path blocked", ".claude/worktrees/agent-x/src/lib/scan/engine.ts", 2],
];

const BASH_BLOCKED = [
  `cat ${envFile}`,
  `sudo cat /opt/quanttrader/${envFile}`,
  `source ${envFile} && make check`,
  `cp ${envFile} /tmp/x`,
  `echo foo > ${envFile}`,
  `perl -pi -e 's/^X=.*/X=1/' ${envFile}`,
  `node --env-file=${envFile} -e 'console.log(1)'`,
  `echo ${envFile} | xargs cat`,
  `diff ${envFile} .env.example`,
  `cat ${envFile.toUpperCase()}`,
  `bash -c 'cat ${envFile}'`,
  `node -e 'require("fs").readFileSync("${envFile}")'`,
  `python3 -c "print(open('${envFile}').read())"`,
  `printf '%s\\n' ${envFile} | while read -r f; do cat "$f"; done`,
  "cp x.json scripts/canonical/data/y.json",
  "rm -rf scripts/canonical/data",
  "git rm -r scripts/canonical/data",
  "sed -E -i 's/a/b/' scripts/canonical/data/x.json",
  "find scripts/canonical/data -name '*.json' -delete",
  "echo '{}' > tests/golden/xau-usd-h4-2026h1.golden.json",
  "sed -i '' 's/a/b/' src/lib/scan/engine.ts",
  "cat > src/lib/brokers/x.ts",
  "git checkout other -- src/lib/scan/",
  "pnpm exec eslint --fix src/lib/scan",
  "pnpm exec prettier --write src/app/api/cron/heartbeat/route.ts",
  "cp x.sh scripts/scan-cron.sh",
  "git push --force origin dev",
  "git push -f origin main",
  "git push origin +main",
  "git push origin :dev",
  "git push --mirror origin",
  "git push origin --delete main",
  "git commit -m x --no-verify",
  "git commit -n -m x",
  "git commit -am x -n",
];

const BASH_ALLOWED = [
  "grep -n FOO .env.example",
  "git commit -q -F - <<EOF\nfeat: deny for .env* (except .env.example) and pinned data\nEOF",
  'echo "deny .env* reads"',
  `echo "${envFile} is where secrets live" | wc -c`,
  "ls -la",
  "make check",
  "ls scripts/canonical/data/",
  "cp scripts/canonical/data/x.json /tmp/",
  "ls scripts/canonical/data/ && rm -rf .next",
  "cat src/lib/scan/engine.ts",
  "grep -n catch src/lib/scan/engine.ts",
  "git diff -- src/lib/scan/engine.ts",
  "git push --force-with-lease origin tooling/x",
  "git push -u origin tooling/x",
  "git commit -m 'fix: n is fine inside words'",
  "pnpm exec eslint src/lib/scan",
];

const REVIEWER_ALLOWED = [
  "git diff origin/dev...HEAD -- src",
  "git log --oneline -20 | head -5",
  "git blame -L 10,20 src/lib/scan/engine.ts",
  "git show HEAD --stat",
  "make test",
  "make backtest 2>&1",
  "make lint >/dev/null 2>&1",
  "make lint && make typecheck",
  'make regime-report ARGS="90 60"',
  "pnpm exec vitest run tests/golden 2>&1 | tail -3",
  "pnpm exec tsc --noEmit -p tsconfig.json",
  "pnpm exec prettier --check scripts/regime-report.ts",
  "pnpm exec eslint --config eslint.config.strict.mjs --no-ignore scripts/regime-report.ts",
  "grep -nE 'a|b' src/lib/scan/engine.ts",
  "cat src/lib/scan/engine.ts | wc -l",
  "cd scripts && ls",
  "gh pr diff 307",
];

const REVIEWER_BLOCKED = [
  "git commit -m x",
  "git push origin HEAD",
  "git checkout -b x",
  "git reset --hard HEAD~1",
  "git stash",
  "git add -A",
  "git diff --output=/tmp/x",
  "git log --output /tmp/x",
  "git grep -Otouch x",
  "rm -rf node_modules",
  "mv a b",
  "echo x > file.txt",
  "make lint >> log.txt",
  "echo $(rm -rf /tmp/x)",
  'echo "$(touch /tmp/x)"',
  "echo `rm x`",
  "cat <<EOF\nx\nEOF",
  "cat < file",
  "pnpm install",
  "pnpm add leftpad",
  "make backtest-update",
  "make format",
  "make test PNPM='touch x;'",
  'make regime-report ARGS="1 1; touch x"',
  "make test -f /tmp/x.mk",
  "sed -i 's/a/b/' file.ts",
  "sed -i.bak 's/a/b/' file.ts",
  "awk 'BEGIN{system(\"touch x\")}'",
  "sort -o f f",
  "rg --pre cat .",
  "grep -rn SECRET .",
  "find . -name '*.log' -delete",
  "make lint && git commit -m x",
  'node -e \'require("fs").writeFileSync("x","y")\'',
  "brew install something",
  "pnpm exec vitest run -u",
  "pnpm exec vitest run --outputFile=/tmp/x.json",
  "pnpm exec eslint --fix .",
  "pnpm exec eslint -o /tmp/x src",
  "pnpm exec tsc",
  "pnpm exec prettier --write x.ts",
  'echo \\"; touch /tmp/x',
  "echo x >&1name",
  "cat <(ls)",
];

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
  it("override lifts the live fence and leaves a FENCE DOWN notice", () => {
    const r = runHook("guard-paths.sh", edit("src/lib/scan/engine.ts"), {
      QT_ALLOW_LIVE_EDITS: "1",
    });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout) as { systemMessage: string };
    expect(json.systemMessage).toMatch(/FENCE DOWN/);
    expect(json.systemMessage).toMatch(/src\/lib\/scan\/engine\.ts/);
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
  for (const cmd of BASH_ALLOWED) {
    it(`allows: ${firstLine(cmd)}`, () => {
      expect(runHook("guard-bash.sh", bash(cmd)).status).toBe(0);
    });
  }
  it("override lifts the live fence for shell writes with a notice, never the secrets rule", () => {
    const env = { QT_ALLOW_LIVE_EDITS: "1" };
    const r = runHook("guard-bash.sh", bash("sed -i '' 's/a/b/' src/lib/scan/engine.ts"), env);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { systemMessage: string }).systemMessage).toMatch(/FENCE DOWN/);
    expect(runHook("guard-bash.sh", bash(`cat ${envFile}`), env).status).toBe(2);
  });
  it("fails closed on malformed input", () => {
    expect(runHook("guard-bash.sh", "not json").status).toBe(2);
  });
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
  it("accepts a plain message", () => {
    expect(check("feat: x\n\nplain body mentioning a robot without the trailer\n")).toBe(0);
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
