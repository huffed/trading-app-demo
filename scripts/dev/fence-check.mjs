/**
 * make fence-check — the session-only switches QT_ALLOW_LIVE_EDITS (lifts the
 * live-path fence) and QT_STOP_VALIDATE (turns on the Stop hook) are never set
 * in a committed file (docs/decisions/0004). Scans every tracked file for an
 * assignment or export of either name. Reads of the variables (`${NAME:-0}` in
 * the hooks, `process.env.NAME` in code) are fine; docs may show the command.
 *
 * Exit 1 with the offending lines when one is found; exit 0 otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const NAMES = "(QT_ALLOW_LIVE_EDITS|QT_STOP_VALIDATE)";
// An ASSIGNMENT is the name at the start of a statement (line start, or after ; & |),
// a JSON/YAML key, an `export`, or a `process.env` write. Mentions inside comments,
// messages and `${NAME:-0}` reads are not assignments and are not flagged.
const ASSIGNMENT = new RegExp(
  [
    `(^|[^A-Za-z0-9_])${NAMES}[\\t ]*=(?!=)`, // NAME=1 anywhere: shell, env NAME=1, a script string "NAME=1 claude"
    `(^|[^A-Za-z0-9_])export[\\t ]+${NAMES}([\\t ]|$)`, // export NAME
    `["']${NAMES}["'][\\t ]*:`, // "NAME": "1" as a JSON key, anywhere on the line (one-line env blocks included)
    `^[\\t ]*${NAMES}[\\t ]*:[\\t ]*[^-\\s]`, // NAME: 1 as a YAML key (not the ${NAME:-0} read)
    `process\\.env(\\.|\\[["'])${NAMES}["'\\]]*[\\t ]*=(?!=)`, // process.env.NAME = "1"
  ].join("|")
);
const COMMENT = /^[\t ]*(#|\/\/|\*|<!--)/;
const EXCLUDED = [/^docs\//, /^CLAUDE\.md$/, /^tests\/hooks\//, /^scripts\/dev\/fence-check\.mjs$/];
const TEXT =
  /\.(ts|tsx|mjs|cjs|js|json|yml|yaml|sh|toml|md|txt|env|example|mk|cfg|ini)$|^(Makefile|\.[a-z]+rc|\.husky\/.*)$/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !EXCLUDED.some((re) => re.test(f)) && TEXT.test(f));

const hits = [];
for (const file of files) {
  try {
    if (statSync(file).size > 2_000_000) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      if (ASSIGNMENT.test(line)) hits.push(`${file}:${String(i + 1)}: ${line.trim()}`);
    });
  } catch {
    // unreadable or binary: not a place a switch is set
  }
}

if (hits.length > 0) {
  console.error(
    "fence-check: a session-only switch is set in a committed file (docs/decisions/0004):"
  );
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(
  `fence-check: no committed file sets QT_ALLOW_LIVE_EDITS or QT_STOP_VALIDATE (${String(files.length)} files scanned)`
);
