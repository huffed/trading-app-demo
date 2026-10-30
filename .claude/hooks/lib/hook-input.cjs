#!/usr/bin/env node
/**
 * Shared parser for the Claude Code hook scripts in this directory. Reads the
 * hook payload on stdin and prints exactly what the shell side needs, so every
 * hook parses JSON the same way and fails the same way.
 *
 *   node hook-input.cjs field <name>      tool_input.<name>; for file_path falls back to notebook_path
 *   node hook-input.cjs relpath <root>    the edited path relative to the REAL project root: symlinks resolved
 *                                         (native realpath, so the on-disk case wins), `..` collapsed,
 *                                         `.claude/worktrees/<x>/` stripped, lowercased on macOS (case-insensitive
 *                                         filesystem); prints OUTSIDE when the path leaves the root
 *   node hook-input.cjs segments [--strict]
 *                                         quote-aware split of tool_input.command into simple commands, one per
 *                                         line as `<sep>\t<command>` where sep is start|and|or|pipe|seq|bg|nl|subst.
 *                                         Without --strict, the inside of every $(…) and `…` is split too and
 *                                         appended as `subst` lines, so inner commands are inspected. With --strict
 *                                         the only output is DENY:<reason> for constructs a read-only caller must
 *                                         refuse (command or process substitution, heredocs, any `<`, any redirect
 *                                         other than >&1 >&2 >/dev/null 2>/dev/null) — otherwise the same lines.
 *   node hook-input.cjs stop-active       1 when stop_hook_active is true, else 0
 *
 * Exit 3 on malformed input or an unknown mode. Callers treat anything but
 * exit 0 as "cannot inspect, refuse" (fail closed).
 */
const fs = require("fs");
const path = require("path");

function payload() {
  const raw = fs.readFileSync(0, "utf8");
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

const realpath = (p) => (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p));

function nearestExistingRealpath(p) {
  // native realpath of the deepest existing ancestor (on-disk case), plus the untouched remainder
  let cur = p;
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpath(cur), ...rest);
}

function relpath(root, filePath) {
  const realRoot = realpath(root);
  const abs = path.isAbsolute(filePath) ? filePath : path.join(realRoot, filePath);
  const resolved = nearestExistingRealpath(path.normalize(abs));
  if (resolved === null) return "OUTSIDE";
  const fold = (s) => (process.platform === "darwin" ? s.toLowerCase() : s);
  let rel = path.relative(fold(realRoot), fold(resolved));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return "OUTSIDE";
  rel = rel.split(path.sep).join("/");
  rel = rel.replace(/^\.claude\/worktrees\/[^/]+\//, "");
  return rel;
}

/**
 * Split a shell command into simple commands, respecting single quotes,
 * double quotes, $'…' and backslash escapes. Returns { deny } in strict mode
 * for constructs a read-only caller cannot reason about; otherwise
 * { segments: [{ sep, text }] } with the contents of $(…) and `…` appended
 * as extra `subst` segments.
 */
function segments(cmd, strict) {
  const out = [];
  const inner = [];
  let cur = "";
  let sep = "start";
  let quote = null; // "'" | '"' | "$'"
  const deny = (why) => ({ deny: why });
  const push = (nextSep) => {
    if (cur.trim()) out.push({ sep, text: cur.trim() });
    cur = "";
    sep = nextSep;
  };
  // find the matching close of a $( … ) or ` … ` starting at i (index of "(" or "`"); returns [innerText, endIndex]
  const matchSubst = (i) => {
    if (cmd[i] === "`") {
      const j = cmd.indexOf("`", i + 1);
      return j < 0 ? [cmd.slice(i + 1), cmd.length - 1] : [cmd.slice(i + 1, j), j];
    }
    let depth = 0;
    for (let j = i; j < cmd.length; j++) {
      if (cmd[j] === "(") depth++;
      else if (cmd[j] === ")") {
        depth--;
        if (depth === 0) return [cmd.slice(i + 1, j), j];
      }
    }
    return [cmd.slice(i + 1), cmd.length - 1];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (quote !== null) {
      if ((quote === '"' || quote === "$'") && c === "\\" && n !== undefined) { cur += c + n; i++; continue; }
      if (quote === '"' && (c === "`" || (c === "$" && n === "("))) {
        if (strict) return deny("command substitution inside double quotes");
        const [text, end] = matchSubst(c === "`" ? i : i + 1);
        inner.push(text);
        cur += cmd.slice(i, end + 1);
        i = end;
        continue;
      }
      cur += c;
      if ((quote === '"' && c === '"') || ((quote === "'" || quote === "$'") && c === "'")) quote = null;
      continue;
    }
    if (c === "\\" && n !== undefined) { cur += c + n; i++; continue; }
    if (c === "'") { quote = "'"; cur += c; continue; }
    if (c === '"') { quote = '"'; cur += c; continue; }
    if (c === "$" && n === "'") { quote = "$'"; cur += c + n; i++; continue; }
    if (c === "`" || (c === "$" && n === "(")) {
      if (strict) return deny("command substitution");
      const [text, end] = matchSubst(c === "`" ? i : i + 1);
      inner.push(text);
      cur += cmd.slice(i, end + 1);
      i = end;
      continue;
    }
    if ((c === "<" || c === ">") && n === "(") {
      if (strict) return deny("process substitution");
      const [text, end] = matchSubst(i + 1);
      inner.push(text);
      cur += cmd.slice(i, end + 1);
      i = end;
      continue;
    }
    if (strict) {
      if (c === "<") return deny("input redirection or heredoc");
      if (c === ">") {
        const m = cmd.slice(i).match(/^>&[12](?=\s|$|[;&|])|^>>?\s*\/dev\/null(?=\s|$|[;&|])/);
        if (!m) return deny("redirect");
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === ">" && (n === "&" || n === "|")) { cur += c + n; i++; continue; } // 2>&1 and >| are not separators
    if (c === "&" && n === "&") { push("and"); i++; continue; }
    if (c === "|" && n === "|") { push("or"); i++; continue; }
    if (c === "|") { push("pipe"); continue; }
    if (c === ";") { push("seq"); continue; }
    if (c === "&") { push("bg"); continue; }
    if (c === "\n") { push("nl"); continue; }
    cur += c;
  }
  if (strict && quote !== null) return deny("unterminated quote");
  push("nl");
  for (const text of inner) {
    const r = segments(text, false);
    for (const s of r.segments) out.push({ sep: "subst", text: s.text });
  }
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
    else process.stdout.write(r.segments.map((s) => `${s.sep}\t${s.text}`).join("\n"));
    break;
  }
  case "stop-active":
    process.stdout.write(json.stop_hook_active === true ? "1" : "0");
    break;
  default:
    process.stderr.write(`hook-input: unknown mode ${String(mode)}\n`);
    process.exit(3);
}
