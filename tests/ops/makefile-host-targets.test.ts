/**
 * The VPS make targets (status, logs, kill-switch, resume, unpause, deploy, deploy-pointer) take user
 * input only through the recipe's environment (`$$VAR`, validated in the shell), never through make
 * expansion. The one value make itself expands into those recipes is the fixed ssh option string
 * `SSH`, and it must be declared with `override` so that neither a command-line `SSH=…` nor
 * `MAKEFLAGS` can replace it (fresh-context review of PR #316, 2026-11-01).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const makefile = readFileSync(resolve(process.cwd(), "Makefile"), "utf8");
const HOST_TARGETS = [
  "status",
  "logs",
  "kill-switch",
  "resume",
  "unpause",
  "deploy",
  "deploy-pointer",
];

function recipeOf(target: string): string {
  const lines = makefile.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${target}:`));
  expect(start, `target ${target} exists`).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.startsWith("\t")) break;
    body.push(line);
  }
  return body.join("\n");
}

describe("Makefile host targets", () => {
  it("expand nothing from make into the shell except the fixed SSH option string", () => {
    for (const target of HOST_TARGETS) {
      // `$$` reaches the shell as a literal `$`; any other `$` — `$(NAME)`, `${NAME}`, `$X` — is a
      // make expansion. Only `$(SSH)` is allowed.
      const rest = recipeOf(target).replaceAll("$$", "").replaceAll("$(SSH)", "");
      expect(rest, `${target} expands`).not.toContain("$");
    }
  });

  it("declare SSH once, with override, as a fixed ssh option list", () => {
    expect(makefile.match(/^(?:override )?SSH\s*[:?+!]*=/gm)).toHaveLength(1);
    expect(makefile).toMatch(
      /^override SSH := ssh -o BatchMode=yes -o ConnectTimeout=\d+ -o ControlMaster=auto /m
    );
  });
});

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function permissionRules(path: string): { allow: string[]; ask: string[] } {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const permissions =
    typeof parsed === "object" && parsed !== null && "permissions" in parsed
      ? parsed.permissions
      : undefined;
  const rules = typeof permissions === "object" && permissions !== null ? permissions : {};
  return {
    allow: stringList("allow" in rules ? rules.allow : []),
    ask: stringList("ask" in rules ? rules.ask : []),
  };
}

// An allow rule must never pre-approve a host target (the three live-table writers, the deploy and the
// read-only host views): CLAUDE.md promises they prompt every time. Caught here: a blanket Bash or make
// rule, a flag form (`make -…`), a host target anywhere after `make ` (behind a goal or an override), and
// a trailing-wildcard make rule whose prefix could grow into a host target name (`Bash(make k*)`).
// Not caught: user-level settings, `--allowedTools`, and a pre-approved program that runs make for you
// (`pnpm dlx …`); those are the operator's to prune.
const HOST_TARGET_WORD = new RegExp(`\\b(${HOST_TARGETS.join("|")})\\b`);

function preApprovesHostTarget(rule: string): boolean {
  if (/^Bash(\(\*?\))?$/.test(rule)) return true;
  const make = /^Bash\(make(.*)\)$/.exec(rule);
  if (make === null) return false;
  const rest = make[1];
  if (rest === "" || rest.startsWith("*") || /^[:\s]\*$/.test(rest)) return true;
  if (/^\s+-/.test(rest)) return true;
  if (HOST_TARGET_WORD.test(rest)) return true;
  const prefix = /^\s+([^\s*]*)\*$/.exec(rest);
  return prefix !== null && HOST_TARGETS.some((target) => target.startsWith(prefix[1]));
}

const LIVE_TABLE_TARGETS = ["kill-switch", "resume", "unpause"];

describe("the host targets prompt every time", () => {
  const project = permissionRules(resolve(process.cwd(), ".claude/settings.json"));

  it("recognises the spellings that would pre-approve a host target, and no others", () => {
    for (const rule of [
      "Bash",
      "Bash(*)",
      "Bash(make)",
      "Bash(make *)",
      "Bash(make:*)",
      "Bash(make*)",
      "Bash(make -s *)",
      "Bash(make lint-strict unpause)",
      "Bash(make REASON=x kill-switch)",
      "Bash(make k*)",
      "Bash(make deploy)",
      "Bash(make status *)",
    ]) {
      expect(preApprovesHostTarget(rule), rule).toBe(true);
    }
    for (const rule of [
      "Bash(make lint)",
      "Bash(make lint-strict *)",
      "Bash(make test)",
      "Bash(make regime-report *)",
      "Bash(make help)",
      "Bash(git status)",
    ]) {
      expect(preApprovesHostTarget(rule), rule).toBe(false);
    }
  });

  it("are never pre-approved by the project settings", () => {
    expect(project.allow.filter(preApprovesHostTarget)).toEqual([]);
  });

  it("are never pre-approved by the local settings when that file exists (local runs only; CI has no such file)", () => {
    const local = resolve(process.cwd(), ".claude/settings.local.json");
    if (!existsSync(local)) return;
    expect(permissionRules(local).allow.filter(preApprovesHostTarget)).toEqual([]);
  });

  it("list both spellings of the three live-table writers, and every flagged make, as ask rules", () => {
    for (const target of LIVE_TABLE_TARGETS) {
      expect(project.ask).toContain(`Bash(make ${target})`);
      expect(project.ask).toContain(`Bash(make ${target} *)`);
    }
    expect(project.ask).toContain("Bash(make -*)");
  });
});

// make runs every goal on its command line, so a host goal behind a pre-approved goal would run without a
// prompt; the Makefile refuses that while it reads the file (nothing runs). `-n` keeps every recipe dry.
describe("make refuses a host goal beside another goal", () => {
  // Under `make test` the parent make exports REF (which the Makefile refuses from the environment),
  // MAKEFLAGS and MAKELEVEL; the dry run must look like a top-level make.
  const INHERITED = new Set([
    "MAKEFLAGS",
    "MFLAGS",
    "MAKELEVEL",
    "MAKECMDGOALS",
    "QT_HOST",
    "REF",
    "LOG",
    "N",
    "QT_MARKET_HOURS_OK",
    "REASON",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !INHERITED.has(key))
  );
  const dryRun = (args: string[]): { status: number | null; output: string } => {
    const result = spawnSync("make", ["-n", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };

  it("errors before any recipe when a host goal shares the command line", () => {
    for (const args of [
      ["lint-strict", "FILES=x", "kill-switch"],
      ["help", "status"],
      ["status", "help"],
    ]) {
      const result = dryRun(args);
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.output, args.join(" ")).toContain("run alone");
    }
  });

  it("errors when MAKECMDGOALS is supplied from outside make", () => {
    const result = dryRun(["status", "MAKECMDGOALS=lint"]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("run alone");
  });

  it("dry-runs a single host goal, no goal at all, and two goals that are not host targets", () => {
    expect(dryRun(["status"]).status).toBe(0);
    expect(dryRun([]).status).toBe(0);
    expect(dryRun(["help", "lint"]).status).toBe(0);
  });
});
