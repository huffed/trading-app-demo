/**
 * guard-bash rule 1d: git prints any file it is given or can reach, ignored ones such as .env.local included, and
 * .claude/settings.json pre-approves seven git subcommands. Those run only when their text is plain (plainGate: words
 * of ordinary characters, quotes with nothing the shell expands, a few fixed redirections), bare, with their short list
 * of global options and flags, and with paths inside the repository (rule 7's approach for prettier, vitest and tsc,
 * which replaced a list of bad flags after its reviews found more; this rule's six reviews found the same, the later
 * ones through the shell's own syntax). Every other git command prompts or goes to the auto-mode classifier (unless
 * settings.local.json pre-approves it), and gets the known forms refused, best-effort (DEBT D-22). Required by
 * hook-input.cjs (mode gitcheck) and by the tests.
 */

const fs = require("fs");
const path = require("path");

const ENV_NAME = /(^|[^A-Za-z0-9_])\.env(rc|[._-][A-Za-z0-9_.-]*)?([^A-Za-z0-9_]|$)/i;
/** A word naming an env file other than .env.example, which is public (tested on the word, nothing deleted from it). */
const namesEnv = (w) => ENV_NAME.test(w.replace(/(^|[^A-Za-z0-9_])\.env\.example(?=[^A-Za-z0-9_]|$)/gi, "$1"));
/** The same, anywhere in an option word, where a value can follow the letter directly (-F.env.local) */
const optionNamesEnv = (w) => /\.env(rc|[._-][A-Za-z0-9_.-]*)?([^A-Za-z0-9_]|$)/i.test(w.replace(/\.env\.example(?=[^A-Za-z0-9_]|$)/gi, ""));

/** Is the { at i a brace expansion ({a,b} or {a..b})? One linear scan to the next brace, not a regex per character. */
function braceExpands(cmd, i) {
  const re = /\{[^{}]*\}/y;
  re.lastIndex = i;
  const m = re.exec(cmd);
  return m !== null && /,|\.\./.test(m[0]);
}

/**
 * The words of one simple command, quotes resolved, each with what the shell would do to it after this hook has
 * read it: expands (a $ or backtick outside single quotes, $'…' and $"…" included; an unquoted {a,b} or {a..b}; an
 * unquoted leading ~), bare when one of those is outside double quotes too, glob for an unquoted * ? or [, and plain
 * (no quote or backslash in it). A backslash-newline joins the two halves of a word, as the shell does; cont records it.
 */
function lexWords(cmd) {
  const out = [];
  let w = null;
  let quote = null;
  let cont = false;
  const begin = () => {
    if (!w) w = { text: "", expands: false, bare: false, glob: false, plain: true, nl: false };
  };
  const end = () => {
    if (w) out.push(w);
    w = null;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      else {
        w.text += c;
        if (c === "\n") w.nl = true;
      }
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && n !== undefined && '"\\$`\n'.includes(n)) {
        if (n !== "\n") w.text += n;
        i++;
      } else {
        if (c === "$" || c === "`") w.expands = true;
        if (c === "\n") w.nl = true;
        w.text += c;
      }
      continue;
    }
    if (c === "\\" && n !== undefined) {
      if (n === "\n") cont = true; // a line continuation: removed, and the word goes on
      else {
        begin();
        w.plain = false;
        w.text += n;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      begin();
      w.plain = false;
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      end();
      continue;
    }
    begin();
    // ~ or = (zsh's =cmd) starting a word, even after an empty quote (zsh reads ''~nobody and ''=ls as expansions)
    if (c === "$" || c === "`" || ((c === "~" || c === "=") && w.text === "") || (c === "{" && braceExpands(cmd, i))) {
      w.expands = true;
      w.bare = true;
    }
    if (c === "*" || c === "?" || c === "[") w.glob = true;
    w.text += c;
  }
  end();
  // a redirection and its target are the shell's, not git's: 2>/dev/null, > x.patch, <<EOF
  const words = [];
  for (let k = 0; k < out.length; k++) {
    const t = out[k].text;
    if (!out[k].plain || !/^(\d*|&)(>>?|>\||>&|<<-?|<&|<>)/.test(t)) words.push(out[k]);
    else if (/^(\d*|&)(>>?|>\||>&|<<-?|<&|<>)$/.test(t)) k++;
  }
  return { words, cont };
}

/**
 * Why a pre-approved git segment is not plain text, or "". Plain: ordinary characters (letters, digits and
 * _ . / : @ ^ ~ = , + % -; no = starting a word, which zsh expands to a command's path, and no ~ starting a word or
 * after = or :, which bash and zsh may expand), single-quoted text, double-quoted text with no $, backtick or
 * backslash, @{…} of a revision, a leading !, and the redirections 2>&1, 1>&2, >&2, >/dev/null, 2>/dev/null,
 * &>/dev/null, > or >> to a file under a temp directory, and a heredoc whose delimiter is quoted (<<'EOF'), whose body
 * the shell does not expand. Anything else (a ( { < $ #, a glob, an unquoted backslash or newline, a write elsewhere)
 * is shell syntax this rule does not read or a write a read-only git must not make.
 */
function plainGate(s, info = {}) {
  const not = (what) => `${what}, shell syntax this rule does not read; write the command plainly (a message with $ or a backtick goes in a file for -F)`;
  let i = 0;
  let wordStart = true;
  let first = true;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      i++;
      wordStart = true;
      continue;
    }
    if (wordStart) {
      const rest = s.slice(i);
      const fixed = /^(2>&1|1>&2|>&2|&>[ \t]*\/dev\/null|[12]?>>?[ \t]*\/dev\/null|<<-?[ \t]*('[A-Za-z_][A-Za-z0-9_]*'|"[A-Za-z_][A-Za-z0-9_]*"))(?=[ \t]|$)/.exec(rest);
      if (fixed) {
        if (fixed[0].startsWith("<<")) info.heredoc = true; // the only stdin -F - may read
        i += fixed[0].length;
        continue;
      }
      const out = /^(&|[12])?>>?[ \t]*([^ \t]+)(?=[ \t]|$)/.exec(rest);
      if (out) {
        // an absolute path only: a relative one is the shell's directory, which this hook does not know
        const t = out[2];
        if (!/^[A-Za-z0-9_./-]+$/.test(t) || !t.startsWith("/") || t.split("/").includes("..") || !TEMP_DIRS.some((d) => t.startsWith(d))) return `a redirect to ${t}, a write a read-only git must not make; send output to an absolute path under /tmp or the scratchpad`;
        i += out[0].length;
        continue;
      }
      if (/^<</.test(rest)) return not("a heredoc whose delimiter is not quoted, so the shell expands its body");
      if (first && /^![ \t]/.test(rest)) {
        i += 1;
        continue;
      }
      if (c === "~" || c === "=") return not(`a ${c} that starts a word`);
    }
    first = false;
    wordStart = false;
    if (c === "~" && (s[i - 1] === "=" || s[i - 1] === ":")) return not(`a ~ after ${s[i - 1]}`);
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return not("an unterminated quote");
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if ("$`\\".includes(s[j])) return not(`a ${s[j]} inside double quotes`);
        j++;
      }
      if (j >= s.length) return not("an unterminated quote");
      i = j + 1;
      continue;
    }
    if ((c === "@" || c === "^") && s[i + 1] === "{") {
      // a revision's @{1}, @{upstream} or ^{tree}: no .. or , that would brace-expand
      const m = /^[@^]\{[A-Za-z0-9_/-]+(\.[A-Za-z0-9_/-]+)*\}/.exec(s.slice(i));
      if (!m) return not("a {");
      i += m[0].length;
      continue;
    }
    // # stays out: the splitter reads a quote after a comment's # as opening a string, which can hide the next line.
    // * ? [ ] pass here; preApproved holds a word that globs to paths inside the repository (globOk)
    if (/[A-Za-z0-9_./:@^~=,+%*?[\]-]/.test(c)) {
      i++;
      continue;
    }
    return not(c === "\n" ? "a newline outside quotes" : `${c} outside quotes`);
  }
  return "";
}

// the git subcommands .claude/settings.json pre-approves (tests/hooks/hooks.test.ts checks the two lists agree)
const PRE_APPROVED = ["status", "diff", "log", "show", "blame", "add", "commit"];
const GLOBAL_OK = new Set(["--no-pager", "-P", "--no-optional-locks"]);
// every other global option git knows; one it does not know could take a value and shift the subcommand
const GLOBAL_KNOWN = /^(-p|--paginate|--no-replace-objects|--no-lazy-fetch|--no-advice|--bare|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--html-path|--man-path|--info-path|--version|--help|-v|-h|--(git-dir|work-tree|namespace|attr-source|super-prefix|list-cmds)=.*)$/;
const DIFFISH = [
  "--stat", "--shortstat", "--numstat", "--dirstat", "--summary", "--compact-summary", "--name-only", "--name-status",
  "-p", "-u", "--patch", "-s", "--no-patch", "-U", "--unified", "--no-color", "--color", "--color-moved", "-w",
  "--ignore-all-space", "-b", "--ignore-space-change", "--ignore-blank-lines", "--word-diff", "--color-words",
  "--diff-filter", "--exit-code", "--quiet", "-M", "--find-renames", "-C", "--find-copies", "--no-renames", "--check",
  "--no-ext-diff", "--no-textconv", "--minimal", "--patience", "--histogram", "-R", "--relative", "-z", "--abbrev",
  "--full-index", "--binary", "-W", "--function-context", "--raw",
];
const LOGISH = [
  ...DIFFISH, "--oneline", "-n", "--max-count", "--skip", "--format", "--pretty", "--date", "--since", "--after",
  "--until", "--before", "--author", "--committer", "--grep", "-i", "--regexp-ignore-case", "--all-match",
  "--invert-grep", "-E", "--extended-regexp", "-F", "--fixed-strings", "--all", "--branches", "--remotes", "--tags",
  "--graph", "--decorate", "--no-decorate", "--abbrev-commit", "--no-abbrev-commit", "--follow", "-S", "-G",
  "--pickaxe-regex", "--reverse", "--no-merges", "--merges", "--first-parent", "--left-right", "--cherry-pick",
  "--topo-order", "--date-order", "-L", "--full-history", "--ancestry-path", "--no-walk", "--boundary", "--not",
  "--relative-date", "-m", "-c", "--cc", "--source", "--show-signature",
];
// per subcommand: the flags it may take, and which of them take a value (attached, after =, or the next word)
const FLAGS = {
  status: { ok: ["-s", "--short", "-b", "--branch", "--porcelain", "--long", "-u", "--untracked-files", "--ignored", "-z", "--show-stash", "--ahead-behind", "--no-ahead-behind", "-v", "--verbose"], value: [] },
  diff: { ok: [...DIFFISH, "--cached", "--staged", "--merge-base"], value: [] },
  log: { ok: LOGISH, value: ["-n", "-L", "-S", "-G"] },
  show: { ok: LOGISH, value: ["-n", "-L", "-S", "-G"] },
  blame: { ok: ["-L", "-w", "-M", "-C", "-e", "--show-email", "-s", "-l", "-t", "-f", "--show-name", "-n", "--show-number", "-p", "--porcelain", "--line-porcelain", "--date", "--root", "--show-stats", "--abbrev", "-c", "--color-lines", "--color-by-age", "--first-parent", "--ignore-rev", "--progress", "--no-progress"], value: ["-L", "--ignore-rev"] },
  add: { ok: ["-A", "--all", "-u", "--update", "-p", "--patch", "-N", "--intent-to-add", "-n", "--dry-run", "-v", "--verbose", "--chmod"], value: [] },
  commit: { ok: ["-m", "--message", "-F", "--file", "-a", "--all", "-q", "--quiet", "-v", "--verbose", "--amend", "--no-edit", "--allow-empty", "--fixup", "--squash", "-s", "--signoff"], value: ["-m", "-F"] },
};
const MESSAGE_FLAGS = new Set(["-m", "--message"]);
const TEMP_DIRS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "time", "timeout", "stdbuf", "command", "builtin", "exec", "xargs", "caffeinate", "ionice", "unbuffer", "chronic", "noglob", "nocorrect", "repeat", "coproc", "xcrun", "arch", "-"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "(", "time"]);
const C_KEYS_OK = /^((color\.[a-z.]+|core\.quotepath|advice\.[a-z.]+)=|(core\.editor|sequence\.editor)=(true|:)$|core\.pager=cat$)/i;
// an editor or pager set to one of these runs nothing that reads a file (GIT_EDITOR=true git rebase --continue)
const SAFE_VALUE = /^(GIT_EDITOR|GIT_SEQUENCE_EDITOR|EDITOR|VISUAL|GIT_PAGER|PAGER)=(true|false|cat|:)?$/;
// a variable git (or the editor and pager it runs) reads; += and name[i]= set it too
const GIT_VAR = /^(GIT_[A-Z0-9_]+|HOME|XDG_CONFIG_HOME|EDITOR|VISUAL|PAGER|LESSOPEN|LESSCLOSE)(\[[^\]]*\])?\+?=/;
const GIT_VAR_NAME = /^(GIT_[A-Z0-9_]+|HOME|XDG_CONFIG_HOME|EDITOR|VISUAL|PAGER|LESSOPEN|LESSCLOSE)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/** Does a shell glob (* ? [..]) match a name? A pattern that cannot be read is taken to match (fail closed). */
function globMatches(glob, name) {
  let re = "";
  for (let k = 0; k < glob.length; k++) {
    const ch = glob[k];
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[") {
      const close = glob.indexOf("]", k + 2);
      if (close < 0) re += "\\[";
      else {
        re += "[" + glob.slice(k + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        k = close;
      }
    } else re += ch.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`).test(name);
  } catch {
    return true;
  }
}

const outsideRoot = (p, root) => {
  const r = path.resolve(root, p);
  return r !== root && !r.startsWith(root + path.sep);
};

/**
 * Is this directory in the repository's own work tree, where git finds this repository? Symlinks resolved; not
 * .git or anything under it (git sees no work tree there), and no directory between the root and it holding a .git
 * entry (a nested repository or a linked worktree, such as .claude/worktrees/x). From anywhere else a pre-approved
 * git diff of two paths is a plain-file compare of the whole tree, ignored files included. A missing one is not.
 */
function inWorkTree(dir, root) {
  let r;
  let top;
  try {
    r = fs.realpathSync(dir);
    top = fs.realpathSync(root);
  } catch {
    return false;
  }
  if (r !== top && !r.startsWith(top + path.sep)) return false;
  const parts = path.relative(top, r).split(path.sep).filter(Boolean);
  if (parts.includes(".git")) return false;
  let cur = top;
  for (const p of parts) {
    cur = path.join(cur, p);
    if (fs.existsSync(path.join(cur, ".git"))) return false;
  }
  return true;
}

/** The command word of one simple command and the words after it, past keywords, assignments and wrappers. */
function commandWords(text) {
  const { words } = lexWords(text.replace(/\n\x1f/g, "\n"));
  let i = 0;
  let cdpath = false;
  while (i < words.length) {
    const t = words[i].text;
    if (KEYWORDS.has(t)) i++;
    else if (/^[({!]+./.test(t) && words[i].plain) words[i] = { ...words[i], text: t.replace(/^[({!]+/, "") };
    else if (ASSIGNMENT.test(t)) {
      if (/^CDPATH/.test(t)) cdpath = true;
      i++;
    } else if (WRAPPERS.has(t.replace(/.*\//, ""))) {
      i++;
      while (i < words.length && (/^-/.test(words[i].text) || /^\d+[smhd]?$/.test(words[i].text))) i++;
    } else break;
  }
  return { word: words[i] ? words[i].text.replace(/.*\//, "") : "", args: words.slice(i + 1), cdpath };
}

/**
 * Why this simple command, if it runs git, can print an ignored file such as .env.local, or "" when it cannot by any
 * form below. The pre-approved subcommands are held to plain text and short lists (rule 7's approach); the rest are
 * checked for the known forms only, best-effort (DEBT D-22).
 */
function gitCheck(text, root, ctx = {}) {
  const { words, cont } = lexWords(text.replace(/\n\x1f/g, "\n"));
  if (!words.length) return "";
  // a variable git reads, set for this command, exported, or set by printf -v / read
  const head0 = words[0].text;
  const unsafeVar = (t) => (GIT_VAR.test(t) && !SAFE_VALUE.test(t)) || GIT_VAR_NAME.test(t);
  if (/^(export|declare|typeset|readonly|local)$/.test(head0)) {
    if (words.slice(1).some((w) => unsafeVar(w.text))) return "an assignment of a variable git reads (GIT_*, HOME, XDG_CONFIG_HOME, EDITOR, VISUAL, PAGER)";
    return "";
  }
  if ((head0 === "printf" && words.some((w, k) => k > 0 && words[k - 1].text === "-v" && GIT_VAR_NAME.test(w.text))) || (head0 === "read" && words.slice(1).some((w) => GIT_VAR_NAME.test(w.text)))) {
    return "an assignment of a variable git reads (GIT_*, HOME, XDG_CONFIG_HOME, EDITOR, VISUAL, PAGER)";
  }
  // find the command word: past shell keywords (a ( { or ! glued to the word too), a case pattern, assignments, and
  // wrappers with their options and numbers. A pre-approved git found behind a ( { ) is then refused by plainGate
  let i = 0;
  let wrapped = false;
  let gitVarSet = false; // a prefix assignment git would read: refused when it reaches git, or stands alone
  while (i < words.length) {
    const t = words[i].text;
    if (KEYWORDS.has(t)) i++;
    else if (/^[({!]+./.test(t) && words[i].plain) words[i] = { ...words[i], text: t.replace(/^[({!]+/, "") };
    else if (t === "case") {
      while (i < words.length && !/\)$/.test(words[i].text)) i++;
      i++;
    } else if (ASSIGNMENT.test(t)) {
      if (GIT_VAR.test(t) && !SAFE_VALUE.test(t)) gitVarSet = true;
      wrapped = true;
      i++;
    } else if (WRAPPERS.has(t.replace(/.*\//, ""))) {
      wrapped = true;
      i++;
      while (i < words.length && (/^-/.test(words[i].text) || /^\d+[smhd]?$/.test(words[i].text))) {
        if (/^-(n|u|g|k|s|S|C|E|I|L|P|a)$/.test(words[i].text)) i++; // a wrapper option's value (exec -a x, nice -n 5)
        i++;
      }
    } else break;
  }
  const varWhy = "an assignment of a variable git reads (GIT_*, HOME, XDG_CONFIG_HOME, EDITOR, VISUAL, PAGER)";
  if (i >= words.length) return gitVarSet ? varWhy : ""; // HOME+=x on its own reaches every later git
  // a command word that is a glob the shell could expand to git (/usr/bin/gi?, g[i]t); a case pattern (x) or *) and
  // a heredoc line (* item, lines[a:b] = x) are not
  const cw = words[i].text;
  if (words[i].glob && !/\)$/.test(cw) && /[git]/.test(cw.replace(/.*\//, "")) && globMatches(cw.replace(/.*\//, ""), "git")) return `a command word that is a glob (${cw}), which the shell may expand to git; name the program`;
  if (words[i].text.replace(/.*\//, "").toLowerCase() !== "git") return "";
  if (gitVarSet) return varWhy;
  const gitWord = words[i];
  // global options
  let j = i + 1;
  const globals = [];
  for (; j < words.length && words[j].text.startsWith("-"); j++) {
    const g = words[j].text;
    globals.push({ g, v: null });
    if (/^(-c|-C|--git-dir|--work-tree|--namespace|--config-env|--attr-source|--shallow-file|--super-prefix|--list-cmds)$/.test(g)) {
      const v = words[j + 1] ? words[j + 1].text : "";
      if (g === "-c" && !C_KEYS_OK.test(v)) return `git -c ${v.split("=")[0]}, which can make git run a program or read another file`;
      if (g === "--config-env") return "git --config-env, which can make git run a program";
      if (/^(--git-dir|--work-tree)$/.test(g) && (outsideRoot(v, root) || (words[j + 1] && words[j + 1].expands))) return `git ${g} outside the repository`;
      // -C moves where git runs: only to a directory of this work tree (not .git, not a nested worktree)
      if (g === "-C" && ((words[j + 1] && words[j + 1].expands) || !inWorkTree(path.resolve(ctx.dir || root, v), root))) return "git -C to a directory outside the repository's work tree";
      globals[globals.length - 1].v = v;
      j++;
    } else if (/^--(git-dir|work-tree)=/.test(g) && outsideRoot(g.split("=")[1], root)) return `git ${g.split("=")[0]} outside the repository`;
    else if (/^--config-env=/.test(g)) return "git --config-env, which can make git run a program";
    else if (!GLOBAL_OK.has(g) && !GLOBAL_KNOWN.test(g)) return `git with the global option ${g}, which git may read as taking a value or running a program`;
  }
  const subWord = words[j];
  const sub = subWord ? subWord.text.toLowerCase() : "";
  const args = words.slice(j + 1);

  if (PRE_APPROVED.includes(sub)) {
    const lead = `a pre-approved git ${sub}`;
    if (wrapped) return `${lead} behind a VAR= prefix or a wrapper; run git bare`;
    if (ctx.away || !inWorkTree(ctx.dir || root, root)) return `${lead} run from outside the repository's work tree (a cd, pushd or popd, .git or a nested worktree), where its paths mean other files; run it from the project directory`;
    const plain = text.replace(/\n\x1f/g, "\n");
    const info = {};
    const gate = plainGate(plain, info);
    if (gate) return `${lead} with ${gate}`;
    // stdin for -F - is a quoted heredoc token on this command (as plainGate read it, not text inside quotes)
    const stdinOk = info.heredoc === true;
    return preApproved(sub, lead, { cont, gitWord, globals, subWord, args, stdinOk, dir: ctx.dir || root }, root);
  }
  return otherGit(sub, args);
}

/** The pre-approved subcommands run with no prompt, so they take only their short lists. Their text is plain here. */
function preApproved(sub, lead, c, root) {
  if (!c.gitWord.plain || c.gitWord.text !== "git" || !c.subWord.plain) return `${lead} not spelled as plain lower-case git ${sub}; spell it plainly`;
  if (c.cont) return `${lead} continued with a backslash-newline; put it on one line`;
  // the directory git runs in: the shell's (tracked through cd by gitcheck), moved by -C, which gitCheck has held to
  // this work tree
  let dir = c.dir;
  for (const { g, v } of c.globals) {
    if (g === "-C" && v) dir = path.resolve(dir, v);
    if (GLOBAL_OK.has(g) || (g === "-c" && C_KEYS_OK.test(v)) || (g === "-C" && v)) continue;
    return `${lead} with the global option ${g}, which is not on its short list`;
  }
  const spec = FLAGS[sub];
  const countFlag = (t) => /^-\d+$/.test(t) && (sub === "log" || sub === "show");
  const optional = new Set(sub === "status" ? ["-u"] : ["-U", "-M", "-C"]); // -U3, -M50, -uno: an attached value may follow
  const pathOk = (t) => {
    if (outsideRoot(path.resolve(dir, t), root)) return `${lead} with the path ${t}, outside the repository; give a path inside it`;
    if (namesEnv(t) && sub !== "status") return `${lead} that names ${t}`;
    return "";
  };
  // an unquoted glob expands to paths: only under a named directory (so no word it yields starts with -), with no ..
  // and no part that starts with a dot, which the shell would let it match
  const globOk = (t) => t.includes("/") && !t.startsWith("/") && !t.split("/").some((p) => p === ".." || (p.startsWith(".") && p !== "."));
  let message = false; // the next word is a -m text
  let paths = false; // after --
  for (let k = 0; k < c.args.length; k++) {
    const t = c.args[k].text;
    // a word the shell still expands that plainGate let by: zsh reads ''~nobody as ~nobody
    if (c.args[k].expands) return `${lead} with ${t}, which the shell expands; spell it out`;
    if (c.args[k].glob && !globOk(t)) return `${lead} with the glob ${t}, which may match a dotfile, an option or a path outside the repository; give it a directory inside the repository`;
    if (message) {
      message = false; // a -m text is one word of plain text, so it may mention an env file
      continue;
    }
    if (paths || t === "-" || !t.startsWith("-")) {
      const r = t === "-" ? "" : pathOk(t);
      if (r) return r;
      continue;
    }
    if (t === "--") {
      paths = true;
      continue;
    }
    if (countFlag(t)) continue;
    if (t.startsWith("--")) {
      const name = t.split("=")[0];
      if (!spec.ok.includes(name)) return `${lead} given ${name}, which is not on its short list of flags`;
      const value = t.includes("=") ? t.slice(t.indexOf("=") + 1) : null;
      if (MESSAGE_FLAGS.has(name)) {
        message = value === null;
        continue;
      }
      if (name === "--file") {
        const v = value !== null ? value : c.args[++k] ? c.args[k].text : "";
        if (value === null && c.args[k] && (c.args[k].expands || c.args[k].glob)) return `${lead} with --file ${v}, which the shell expands; spell it out`;
        const r = fileOk(v, root, c.stdinOk);
        if (r) return `${lead} -F ${v}: ${r}`;
        continue;
      }
      // the one value here that is a path; the others are patterns, dates and formats
      if (name === "--relative" && value !== null && (namesEnv(value) || outsideRoot(path.resolve(dir, value), root))) return `${lead} with ${t}, which names an env file or leaves the repository`;
      // --ignore-rev takes a revision, attached after = or as the next word (which is then not read as a flag)
      if (name === "--ignore-rev" && value === null) {
        k++;
        if (c.args[k] && (c.args[k].expands || c.args[k].glob)) return `${lead} with --ignore-rev ${c.args[k].text}, which the shell expands; spell it out`;
      }
      continue;
    }
    // a bundle of short flags, -abc: each must be on the list; the first that takes a value takes the rest or the next word
    for (let x = 1; x < t.length; x++) {
      const f = "-" + t[x];
      const rest = t.slice(x + 1);
      if (!spec.ok.includes(f)) return `${lead} given ${f}${t.length > 2 ? ` (in ${t})` : ""}, which is not on its short list of flags`;
      if (optional.has(f) && /^[A-Za-z0-9%]*$/.test(rest)) break;
      if (!spec.value.includes(f)) continue;
      const v = rest !== "" ? rest : c.args[k + 1] ? c.args[k + 1].text : "";
      if (rest === "") k++;
      if (rest === "" && c.args[k] && (c.args[k].expands || c.args[k].glob)) return `${lead} with ${f} ${c.args[k].text}, which the shell expands; spell it out`;
      if (f === "-F") {
        const r = fileOk(v, root, c.stdinOk);
        if (r) return `${lead} -F ${v}: ${r}`;
      }
      // -n, -L, -S and -G take a count, a line range or a search string, read from history, never from the work tree
      break;
    }
  }
  return "";
}

/** A -F message file: an absolute path under a temp directory, symlinks resolved (a file in the repository may be an
 * ignored one, such as .mcp.json); - (stdin) only from a quoted heredoc on the same command */
function fileOk(v, root, stdinOk) {
  if (v === "-") return stdinOk ? "" : "a message on stdin that is not a quoted heredoc on this command; give a file";
  if (v === "") return "no message file given";
  if (namesEnv(v)) return "it names an env file";
  let r = path.resolve(root, v);
  try {
    r = fs.realpathSync(r);
  } catch {
    // not there yet: git fails to read it, and the text check below still applies
  }
  if (!v.startsWith("/") || v.split("/").includes("..") || !TEMP_DIRS.some((d) => r.startsWith(d))) return "a message file outside the temp directories; write it under /tmp or the scratchpad";
  return "";
}

// the forms that read outside the index, stage an ignored file or run a program, for git commands that are not
// pre-approved; git takes any unambiguous prefix of a long option, so a word that is a 3+ character prefix of one counts
const REFUSED_LONG = { grep: ["--no-index", "--no-exclude-standard", "--open-files-in-pager"], stash: ["--all"] };
const REFUSED_SHORT = { stash: "a", grep: "O" };

function otherGit(sub, args) {
  if (/^(difftool|mergetool)$/.test(sub)) return `git ${sub}, which runs another program`;
  // rebase -x, bisect run and submodule foreach run a command, as bash -c does: refused when it names an env file or
  // holds a glob, which that command's own shell expands
  const runs =
    (sub === "rebase" && args.some((a) => /^(-x|--exec)/.test(a.text))) ||
    (sub === "bisect" && args.some((a) => a.text === "run")) ||
    (sub === "submodule" && args.some((a) => a.text === "foreach"));
  if (runs && args.some((a) => optionNamesEnv(a.text) || /[*?[]/.test(a.text))) return `git ${sub} running a command that names an env file or holds a glob`;
  if (sub === "config") {
    // a read: --get and friends, get/list, or a bare key with no value and no write option
    const reads =
      args.some((a) => /^(--get|--get-all|--get-regexp|-l|--list|--show-origin|--show-scope|get|list)$/.test(a.text)) ||
      (args.filter((a) => !a.text.startsWith("-")).length === 1 && !args.some((a) => /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|-e|--edit|--file|-f|--blob)/.test(a.text)));
    if (!reads) return "a git config write, which can make every later git command run a program";
  }
  // git writing the files that guard this session (an old guard-bash.sh checked out over the new one); a branch
  // switch rewrites them too, which a path check cannot see (DEBT D-22)
  if (/^(checkout|restore|reset|apply|am|cherry-pick|revert|merge|stash|switch|read-tree|update-index|checkout-index)$/.test(sub)) {
    const guarded = args.find((a) => /^(\.\/)?(\.claude\/|\.husky\/|\.gitignore$|\.gitattributes$)/.test(a.text));
    if (guarded) return `git ${sub} writing ${guarded.text}, one of the files that guard this session; change it with the file tools, which prompt`;
  }
  const bareWord = args.find((a) => a.bare);
  if (bareWord) return `git ${sub} with ${bareWord.text}, which the shell expands after this hook has read it`;
  const named = [];
  let paths = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (paths || !t.startsWith("-")) {
      named.push({ t, positional: true });
      continue;
    }
    if (t === "--") {
      paths = true;
      continue;
    }
    if (t.startsWith("--")) {
      const name = t.split("=")[0];
      if (name.length >= 3 && (REFUSED_LONG[sub] || []).some((l) => l.startsWith(name))) return `git ${sub} ${name}`;
      if (MESSAGE_FLAGS.has(name) && /^(tag|merge|stash|notes)$/.test(sub)) {
        if (!t.includes("=")) k++;
        continue;
      }
      named.push({ t, positional: false });
      continue;
    }
    for (let x = 1; x < t.length; x++) {
      if ((REFUSED_SHORT[sub] || "").includes(t[x])) return `git ${sub} -${t[x]}`;
      if (t[x] === "m" && /^(tag|merge|stash|notes)$/.test(sub)) {
        if (x + 1 === t.length) k++;
        break;
      }
    }
    named.push({ t, positional: false });
  }
  const inertSub = /^(check-ignore|check-attr|ls-files)$/.test(sub) || (sub === "rm" && args.some((a) => a.text === "--cached")) || (sub === "restore" && args.some((a) => /^(--staged|-S)$/.test(a.text)) && !args.some((a) => /^(--worktree|-W)$/.test(a.text)));
  const hit = named.find((n) => (n.positional ? namesEnv(n.t) && !inertSub : optionNamesEnv(n.t)));
  if (hit) return `git ${sub} that names ${hit.t}`;
  return "";
}

module.exports = { gitCheck, lexWords, plainGate, inWorkTree, commandWords, PRE_APPROVED };
