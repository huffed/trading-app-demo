/**
 * The permission rules other files rely on stay in .claude/settings.json: a conflict at the end of a list could drop one
 * with CI green. Pins the merge ask (D-43), the push hook's folder (D-42), the ~/.ssh edit deny (D-37) and the asks on
 * edits to the configs a pre-approved command loads as code (D-22).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Settings {
  permissions: { ask: string[]; deny: string[] };
}

const ROOT = resolve(__dirname, "..", "..");
const settings = JSON.parse(
  readFileSync(join(ROOT, ".claude", "settings.json"), "utf8")
) as Settings;

describe(".claude/settings.json permission rules", () => {
  it.each([
    "Bash(gh pr merge)",
    "Bash(gh pr merge *)",
    "Edit(/vitest.config.*)",
    "Edit(/.lintstagedrc*)",
    "Edit(/eslint.config*)",
    "Edit(/.prettierrc*)",
    "Edit(/prettier.config.*)",
    "Edit(/Makefile)",
    "Edit(/package.json)",
  ])("asks before %s", (rule) => {
    expect(settings.permissions.ask).toContain(rule);
  });

  it.each(["Read(~/.config/quanttrader/**)", "Edit(~/.ssh/**)"])("denies %s", (rule) => {
    expect(settings.permissions.deny).toContain(rule);
  });
});
