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
 *   node hook-input.cjs words             (stdin is one simple command, not JSON) its words as the shell would pass
 *                                         them, quotes and backslashes resolved, one per line: so a quoted value
 *                                         such as -t "--config x" stays one word
 *   node hook-input.cjs expands           (stdin is one simple command) 1 when the shell would expand it: a $ or
 *                                         backtick outside single quotes, or a { outside any quotes; else 0
 *   node hook-input.cjs gitenv <root>     (stdin is one simple command) why a git command can print an ignored file
 *                                         such as .env.local (guard-bash rule 1d), or nothing
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
    // zsh's =(…) is a process substitution too, where the = starts a word (not arr=(…))
    if (c === "=" && n === "(" && (i === 0 || /\s/.test(cmd[i - 1]))) {
      if (strict) return deny("process substitution");
      const [text, end] = matchSubst(i + 1);
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
    if (c === "|" && n === "&") { push("pipe"); i++; continue; } // |& pipes stderr too
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

/** The words of one simple command, quotes and backslash escapes resolved; a newline inside a word becomes a space. */
function words(cmd) {
  const out = [];
  let cur = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      if (cmd[i + 1] !== "\n") cur += cmd[i + 1];
      has = true;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out.map((w) => w.replace(/\n/g, " "));
}

/** 1 when the shell would expand the command: a $ or backtick outside single quotes, or a { outside any quotes. */
function expands(cmd) {
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "$" || c === "`") return 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "$" || c === "`" || c === "{") return 1;
  }
  return 0;
}

// rule 1d of guard-bash.sh: the git forms that print an ignored file such as .env.local
const ENV_NAME = /(^|[^A-Za-z0-9_])\.env(rc|[._-][A-Za-z0-9_.-]*)?([^A-Za-z0-9_]|$)/i;
const GIT_GLOBAL_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
// short options that take a value, per subcommand: the value is the rest of the bundle or the next word
const GIT_SHORT_VALUE = { commit: "mFtcC", tag: "mFu", merge: "mF", stash: "m", notes: "mFcC", blame: "LS", grep: "efABC" };
const GIT_MESSAGE = new Set(["-m", "--message"]);
const GIT_MESSAGE_SUBS = new Set(["commit", "tag", "merge", "stash", "notes"]);
// long options that make git read a path outside the index, or stage an ignored file; git takes any unambiguous
// prefix of a long option, so a word that is a prefix of one of these counts (diff matches --no-index exactly,
// but a prefix there is refused too)
const GIT_REFUSED_LONG = {
  diff: ["--no-index"],
  grep: ["--no-index", "--no-exclude-standard"],
  blame: ["--contents", "--ignore-revs-file"],
  add: ["--force"],
  stash: ["--all"],
};
const GIT_REFUSED_SHORT = { blame: "S", add: "f", stash: "a" };

/**
 * Why a git command (one simple command, wrappers stripped, .env.example already removed) can print an ignored
 * file, or "" when it cannot by any of the forms below. Best-effort, like the rest of the guard: a deliberate
 * spelling (a variable, a glob, an alias in a config file) can still get past it (DEBT D-22).
 */
function gitEnv(cmd, root) {
  if (/\$'/.test(cmd)) return "$'…' quoting in a git command";
  const w = words(cmd.replace(/\n\x1f/g, "\n"));
  if (!w.length || w[0].replace(/.*\//, "").toLowerCase() !== "git") return "";
  let i = 1;
  for (; i < w.length && w[i].startsWith("-"); i++) {
    const g = w[i];
    if (/^(-c|--config-env)$/.test(g) && /^alias\./i.test(w[i + 1] || "")) return "an alias set with -c";
    if (/^--config-env=alias\./i.test(g)) return "an alias set with --config-env";
    if (GIT_GLOBAL_VALUE.has(g)) i++;
  }
  const sub = (w[i] || "").toLowerCase();
  const args = w.slice(i + 1);
  const shortValue = GIT_SHORT_VALUE[sub] || "";
  const named = [];
  let pathsOnly = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (pathsOnly || a === "-" || !a.startsWith("-")) {
      named.push(a);
      continue;
    }
    if (a === "--") {
      pathsOnly = true;
      continue;
    }
    if (a.startsWith("--")) {
      const name = a.split("=")[0];
      if (name.length >= 3 && (GIT_REFUSED_LONG[sub] || []).some((l) => l.startsWith(name))) return `${sub} ${name}`;
      if (GIT_MESSAGE.has(name) && GIT_MESSAGE_SUBS.has(sub)) {
        if (!a.includes("=")) k++; // the message is text, so it may mention an env file
        continue;
      }
      named.push(a);
      continue;
    }
    // a bundle of short options, -abc: the first one that takes a value takes the rest of the word or the next word
    let flags = a;
    for (let c = 1; c < a.length; c++) {
      if ((GIT_REFUSED_SHORT[sub] || "").includes(a[c])) return `${sub} -${a[c]}`;
      if (shortValue.includes(a[c])) {
        const value = c + 1 < a.length ? a.slice(c + 1) : args[++k] || "";
        if (!(a[c] === "m" && GIT_MESSAGE_SUBS.has(sub))) named.push(value);
        flags = a.slice(0, c + 1);
        break;
      }
    }
    named.push(flags);
  }
  // diff compares two plain files, --no-index or not, when one path is outside the work tree
  if (sub === "diff") {
    const home = process.env.HOME || "~";
    const outside = named.find((a) => {
      if (!/^(\/|~|\.\.)/.test(a)) return false;
      const p = path.resolve(root, a.replace(/^~(?=\/|$)/, home));
      return p !== root && !p.startsWith(root + path.sep);
    });
    if (outside !== undefined) return `diff of a path outside the repository (${outside}), which is --no-index`;
  }
  // naming an env file: only git status and check-ignore, and the commands that take one out of the index, may
  const inert =
    /^(status|check-ignore|check-attr|ls-files)$/.test(sub) ||
    (sub === "rm" && args.includes("--cached")) ||
    (sub === "restore" && args.some((a) => /^(--staged|-S)$/.test(a)) && !args.some((a) => /^(--worktree|-W)$/.test(a)));
  if (!inert) {
    const hit = named.find((a) => ENV_NAME.test(a));
    if (hit !== undefined) return `it names ${hit}`;
  }
  return "";
}

const mode = process.argv[2];
if (mode === "gitenv") {
  const root = process.argv[3];
  if (!root) process.exit(3);
  process.stdout.write(gitEnv(fs.readFileSync(0, "utf8"), path.resolve(root)));
  process.exit(0);
}
if (mode === "words") {
  process.stdout.write(words(fs.readFileSync(0, "utf8")).map((w) => `${w}\n`).join(""));
  process.exit(0);
}
if (mode === "expands") {
  process.stdout.write(String(expands(fs.readFileSync(0, "utf8"))));
  process.exit(0);
}
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
    // a newline kept inside a segment (a backslash-newline or one in quotes) starts its next line with \x1f, so a
    // continuation line can never pass for a record of its own, whatever its first field says
    else process.stdout.write(r.segments.map((s) => `${s.sep}\t${s.text.replace(/\n/g, "\n\x1f")}`).join("\n"));
    break;
  }
  case "stop-active":
    process.stdout.write(json.stop_hook_active === true ? "1" : "0");
    break;
  default:
    process.stderr.write(`hook-input: unknown mode ${String(mode)}\n`);
    process.exit(3);
}
