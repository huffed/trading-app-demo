/**
 * The VPS make targets (status, logs, kill-switch, resume, unpause, deploy, deploy-pointer) take user
 * input only through the recipe's environment (`$$VAR`, validated in the shell), never through make
 * expansion. The one value make itself expands into those recipes is the fixed ssh option string
 * `SSH`, and it must be declared with `override` so that neither a command-line `SSH=…` nor
 * `MAKEFLAGS` can replace it (fresh-context review of PR #316, 2026-11-01).
 */
import { readFileSync } from "node:fs";
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
