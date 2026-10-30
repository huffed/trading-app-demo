#!/usr/bin/env node
/**
 * Shared parser for the Claude Code hook scripts in this directory. Reads the
 * hook payload on stdin and prints exactly what the shell side needs, so every
 * hook parses JSON the same way and fails the same way.
 *
 *   node hook-input.cjs field <name>      tool_input.<name>; for file_path falls back to notebook_path
 *   node hook-input.cjs relpath <root>    the edited path relative to the REAL project root: symlinks resolved,
 *                                         `..` collapsed, `.claude/worktrees/<x>/` stripped, lowercased on macOS
 *                                         (case-insensitive filesystem); prints OUTSIDE when the path leaves the root
 *   node hook-input.cjs segments [--strict]
 *                                         quote-aware split of tool_input.command into simple commands, one per
 *                                         line. With --strict the first line is DENY:<reason> for constructs a
 *                                         read-only caller must refuse (command substitution, process substitution,
 *                                         heredocs, any `<`, any redirect other than >&1 >&2 >/dev/null 2>/dev/null)
 *   node hook-input.cjs stop-active       1 when stop_hook_active is true, else 0
 *
 * Exit 3 on malformed input or an unknown mode. Callers treat anything but
 * exit 0 as "cannot inspect, refuse" (fail closed).
 */
const fs = require("fs");
const path = require("path");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function payload() {
  const raw = readStdin();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    process.stderr.write("hook-input: stdin is not JSON\n");
    process.exit(3);
  }
  if (!json || typeof json !== "object") {
    process.stderr.write("hook-input: payload is not an object\n");
    process.exit(3);
  }
  return json;
}

function toolInput(json) {
  const t = json.tool_input;
  return t && typeof t === "object" ? t : {};
}

function nearestExistingRealpath(p) {
  // realpath of the deepest existing ancestor, plus the untouched remainder
  let cur = p;
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

function relpath(root, filePath) {
  const realRoot = fs.realpathSync(root);
  const abs = path.isAbsolute(filePath) ? filePath : path.join(realRoot, filePath);
  const resolved = nearestExistingRealpath(path.normalize(abs));
  if (resolved === null) return "OUTSIDE";
  let rel = path.relative(realRoot, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "OUTSIDE";
  rel = rel.split(path.sep).join("/");
  rel = rel.replace(/^\.claude\/worktrees\/[^/]+\//, "");
  if (process.platform === "darwin") rel = rel.toLowerCase();
  return rel;
}

/**
 * Split a shell command into simple commands, respecting single quotes,
 * double quotes, $'…' and backslash escapes. In strict mode, refuse
 * constructs a read-only caller cannot reason about.
 */
function segments(cmd, strict) {
  const out = [];
  let cur = "";
  let quote = null; // "'" | '"' | "$'"
  const deny = (why) => ({ deny: why });
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (quote !== null) {
      if (quote === '"' && c === "\\" && n !== undefined) { cur += c + n; i++; continue; }
      if (quote === "$'" && c === "\\" && n !== undefined) { cur += c + n; i++; continue; }
      if (strict && quote === '"' && (c === "`" || (c === "$" && n === "("))) {
        return deny("command substitution inside double quotes");
      }
      cur += c;
      if ((quote === '"' && c === '"') || ((quote === "'" || quote === "$'") && c === "'")) quote = null;
      continue;
    }
    if (c === "\\" && n !== undefined) { cur += c + n; i++; continue; }
    if (c === "'") { quote = "'"; cur += c; continue; }
    if (c === '"') { quote = '"'; cur += c; continue; }
    if (c === "$" && n === "'") { quote = "$'"; cur += c + n; i++; continue; }
    if (strict) {
      if (c === "`" || (c === "$" && n === "(")) return deny("command substitution");
      if ((c === "<" || c === ">") && n === "(") return deny("process substitution");
      if (c === "<") return deny("input redirection or heredoc");
      if (c === ">") {
        const m = cmd.slice(i).match(/^>&[12](?=\s|$|[;&|])|^>>?\s*\/dev\/null(?=\s|$|[;&|])/);
        if (!m) return deny("redirect");
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if ((c === "&" && n === "&") || (c === "|" && n === "|")) { push(); i++; continue; }
    if (c === ">" && n === "&") { cur += c + n; i++; continue; } // 2>&1 outside strict mode
    if (c === "|" || c === ";" || c === "\n" || c === "&") { push(); continue; }
    cur += c;
  }
  if (strict && quote !== null) return deny("unterminated quote");
  push();
  return { segments: out };
}

const mode = process.argv[2];
const json = payload();
const ti = toolInput(json);

switch (mode) {
  case "field": {
    const name = process.argv[3];
    if (!name) process.exit(3);
    let v = ti[name];
    if ((v === undefined || v === null || v === "") && name === "file_path") v = ti.notebook_path;
    process.stdout.write(v === undefined || v === null ? "" : String(v));
    break;
  }
  case "relpath": {
    const root = process.argv[3];
    const fp = ti.file_path || ti.notebook_path || "";
    if (!root || !fp) process.exit(3);
    process.stdout.write(relpath(root, String(fp)));
    break;
  }
  case "segments": {
    const strict = process.argv.includes("--strict");
    const cmd = ti.command;
    if (typeof cmd !== "string") process.exit(3);
    const r = segments(cmd, strict);
    if (r.deny) process.stdout.write(`DENY:${r.deny}`);
    else process.stdout.write(r.segments.join("\n"));
    break;
  }
  case "stop-active":
    process.stdout.write(json.stop_hook_active === true ? "1" : "0");
    break;
  default:
    process.stderr.write(`hook-input: unknown mode ${String(mode)}\n`);
    process.exit(3);
}
