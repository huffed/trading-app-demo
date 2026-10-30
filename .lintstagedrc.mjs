/**
 * lint-staged: what runs on STAGED files at commit time (see .husky/pre-commit).
 *
 * - Prettier formats every staged code file (changed-files-only policy until the
 *   whole-tree format PR lands after the audit verdict).
 * - ESLint baseline (errors only) on staged TS/JS.
 * - ESLint TARGET config (eslint.config.strict.mjs) on files that are NEW in
 *   this commit — new code is held to the target from its first commit.
 * - shellcheck on staged cron wrappers.
 * - actionlint on staged GitHub workflow files (a workflow GitHub cannot parse
 *   otherwise fails as a run with no jobs and no log).
 */
import { execFileSync } from "node:child_process";

function addedInThisCommit() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=A"], {
    encoding: "utf8",
  });
  return new Set(out.split("\n").filter(Boolean));
}

const quote = (files) => files.map((f) => `"${f}"`).join(" ");

const config = {
  "*.{ts,tsx,mjs,js,json,css}": (files) => [`prettier --write ${quote(files)}`],
  "*.{ts,tsx,mjs,js}": (files) => {
    const added = addedInThisCommit();
    const newFiles = files.filter((f) => added.has(f.replace(`${process.cwd()}/`, "")));
    const commands = [`eslint --no-warn-ignored ${quote(files)}`];
    if (newFiles.length > 0) {
      commands.push(
        `eslint --config eslint.config.strict.mjs --no-ignore --no-warn-ignored ${quote(newFiles)}`
      );
    }
    return commands;
  },
  "scripts/*.sh": (files) => [`shellcheck -S error ${quote(files)}`],
  ".claude/hooks/*.sh": (files) => [`shellcheck -S error ${quote(files)}`],
  ".husky/commit-msg": (files) => [`shellcheck -S error ${quote(files)}`],
  ".github/workflows/*.{yml,yaml}": () => ["make lint-workflows"],
};

export default config;
