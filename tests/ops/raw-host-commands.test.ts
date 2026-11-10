/**
 * Raw host commands prompt every time. ssh, scp, sftp and rsync are ask rules in the committed settings, and no
 * allow rule (committed, local, or a skill's allowed-tools) matches any shape guard-bash rule 8 lets through;
 * the guard refuses every other shape (tests/hooks/host-cases.ts). An ask rule outranks allow rules and auto
 * mode's classifier, so a matching command prompts in auto mode too: checked live on 2026-11-10, when every shape
 * below prompted in an auto-mode session (docs/DEV_SETUP.md §17). This test keeps the rules in place; it cannot
 * run Claude Code itself.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_ALLOWED } from "../hooks/host-cases";

const TRANSPORTS = ["ssh", "scp", "sftp", "rsync"] as const;
const ROOT = process.cwd();

function rulesOf(path: string, kind: "allow" | "ask"): string[] {
  const json = JSON.parse(readFileSync(path, "utf8")) as { permissions?: Record<string, unknown> };
  const list = json.permissions?.[kind];
  return Array.isArray(list) ? list.filter((r): r is string => typeof r === "string") : [];
}

function skillAllowRules(): string[] {
  const dir = resolve(ROOT, ".claude/skills");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((name) => {
    const file = resolve(dir, name, "SKILL.md");
    if (!existsSync(file)) {
      return [];
    }
    const allowed = /^allowed-tools:(.*)$/m.exec(readFileSync(file, "utf8"));
    return allowed === null ? [] : (allowed[1].match(/Bash\([^)]*\)/g) ?? []);
  });
}

// A Bash rule as Claude Code matches it: the text inside Bash(…), with * matching anything; a bare "Bash" or a
// rule with no parentheses matches every command.
function matches(rule: string, command: string): boolean {
  if (rule === "Bash" || rule === "Bash(*)") {
    return true;
  }
  if (!rule.startsWith("Bash(") || !rule.endsWith(")")) {
    return false;
  }
  const escape = (part: string): string => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${rule.slice(5, -1).split("*").map(escape).join(".*")}$`, "s").test(command);
}

// the host-command segments of the shapes the guard allows (cd … && ssh qt …, cat … | ssh qt …); the bare word,
// which prints usage and reaches nothing, is the one shape the guard allows that needs no prompt
const shapes = HOST_ALLOWED.flatMap((command) =>
  command.split(/&&|\|\|?|;/).map((part) => part.trim())
).filter((part) => TRANSPORTS.some((t) => part.startsWith(`${t} `)));

describe("raw host commands prompt every time", () => {
  const ask = rulesOf(resolve(ROOT, ".claude/settings.json"), "ask");

  it("lists ssh, scp, sftp and rsync as ask rules", () => {
    for (const t of TRANSPORTS) {
      expect(ask).toContain(`Bash(${t} *)`);
    }
  });

  it("has an ask rule for every shape the guard lets through", () => {
    expect(shapes.length).toBeGreaterThan(10);
    for (const shape of shapes) {
      expect(
        ask.some((rule) => matches(rule, shape)),
        shape
      ).toBe(true);
    }
  });

  it("is pre-approved by no allow rule: committed, local or a skill's", () => {
    const local = resolve(ROOT, ".claude/settings.local.json");
    const allow = [
      ...rulesOf(resolve(ROOT, ".claude/settings.json"), "allow"),
      ...(existsSync(local) ? rulesOf(local, "allow") : []),
      ...skillAllowRules(),
    ];
    for (const shape of shapes) {
      expect(
        allow.filter((rule) => matches(rule, shape)),
        shape
      ).toEqual([]);
    }
  });

  it("recognises a rule that would pre-approve a host command, and not one that would not", () => {
    expect(matches("Bash(ssh *)", "ssh qt uptime")).toBe(true);
    expect(matches("Bash(*)", "rsync -a qt:/x/ ./y/")).toBe(true);
    expect(matches("Bash(s*)", "scp a qt:/tmp/")).toBe(true);
    expect(matches("Bash(make status)", "ssh qt uptime")).toBe(false);
    expect(matches("Bash(git log *)", "sftp qt")).toBe(false);
  });
});
