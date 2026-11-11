/**
 * guard-bash rule 1d: git prints any file it is given or can reach, ignored ones such as .env.local included, and
 * .claude/settings.json pre-approves seven git subcommands. Those run only bare, on one line, with no shell expansion,
 * with their short list of flags and paths inside the repository (rule 7's approach for prettier, vitest and tsc, which
 * replaced a list of bad flags after its review found more). Every other git command prompts or goes to the auto-mode
 * classifier, and gets the known forms refused, best-effort (DEBT D-22). Required by hook-input.cjs (mode gitcheck) and
 * by the tests.
 */

const path = require("path");

const ENV_NAME = /(^|[^A-Za-z0-9_])\.env(rc|[._-][A-Za-z0-9_.-]*)?([^A-Za-z0-9_]|$)/i;
/** A word naming an env file other than .env.example, which is public (tested on the word, nothing deleted from it). */
const namesEnv = (w) => ENV_NAME.test(w.replace(/(^|[^A-Za-z0-9_])\.env\.example(?=[^A-Za-z0-9_]|$)/gi, "$1"));
/** The same, anywhere in an option word, where a value can follow the letter directly (-F.env.local) */
const optionNamesEnv = (w) => /\.env(rc|[._-][A-Za-z0-9_.-]*)?([^A-Za-z0-9_]|$)/i.test(w.replace(/\.env\.example(?=[^A-Za-z0-9_]|$)/gi, ""));

/**
 * The words of one simple command, quotes resolved, each with what the shell would do to it after this hook has
 * read it: expands (a $ or backtick outside single quotes, $'…' and $"…" included; an unquoted {a,b} or {a..b}; an
 * unquoted leading ~), bare when one of those is outside double quotes too, so the shell may split it into more words,
 * and plain (no quote or backslash in it). cont is set by a backslash-newline outside quotes.
 */
function lexWords(cmd) {
  const out = [];
  let w = null;
  let quote = null;
  let cont = false;
  const begin = () => {
    if (!w) w = { text: "", expands: false, bare: false, plain: true, nl: false };
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
      if (n === "\n") {
        cont = true;
        end();
      } else {
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
    if (c === "$" || c === "`" || (c === "~" && w.text === "") || (c === "{" && /^\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(cmd.slice(i)))) {
      w.expands = true;
      w.bare = true;
    }
    w.text += c;
  }
  end();
  // a redirection and its target are the shell's, not git's: 2>/dev/null, > x.patch, <<EOF
  const words = [];
  for (let k = 0; k < out.length; k++) {
    const t = out[k].text;
    if (!out[k].plain || !/^(\d*|&)(>>?|>\||>&|<<?<?|<&|<>)/.test(t)) words.push(out[k]);
    else if (/^(\d*|&)(>>?|>\||>&|<<?<?|<&|<>)$/.test(t)) k++;
  }
  return { words, cont };
}

// the git subcommands .claude/settings.json pre-approves (tests/hooks/hooks.test.ts checks the two lists agree)
const PRE_APPROVED = ["status", "diff", "log", "show", "blame", "add", "commit"];
const GLOBAL_OK = new Set(["--no-pager", "-P", "--no-optional-locks"]);
// every other global option git knows; one it does not know could take a value and shift the subcommand
const GLOBAL_KNOWN = /^(-p|--paginate|--no-replace-objects|--no-lazy-fetch|--no-advice|--bare|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--exec-path(=.*)?|--html-path|--man-path|--info-path|--version|--help|-v|-h|--(git-dir|work-tree|namespace|attr-source|super-prefix|list-cmds)=.*)$/;
const DIFFISH = [
  "--stat", "--shortstat", "--numstat", "--dirstat", "--summary", "--compact-summary", "--name-only", "--name-status",
  "-p", "-u", "--patch", "-s", "--no-patch", "-U", "--unified", "--no-color", "--color", "--color-moved", "-w",
  "--ignore-all-space", "-b", "--ignore-space-change", "--ignore-blank-lines", "--word-diff", "--diff-filter",
  "--exit-code", "--quiet", "-M", "--find-renames", "--no-renames", "--check", "--no-ext-diff", "--no-textconv",
  "--minimal", "--patience", "--histogram", "-R", "--relative", "-z", "--abbrev", "--full-index", "--binary",
];
const LOGISH = [
  ...DIFFISH, "--oneline", "-n", "--max-count", "--skip", "--format", "--pretty", "--date", "--since", "--after",
  "--until", "--before", "--author", "--committer", "--grep", "-i", "--regexp-ignore-case", "--all-match",
  "--invert-grep", "-E", "--extended-regexp", "-F", "--fixed-strings", "--all", "--branches", "--remotes", "--tags",
  "--graph", "--decorate", "--no-decorate", "--abbrev-commit", "--no-abbrev-commit", "--follow", "-S", "-G",
  "--pickaxe-regex", "--reverse", "--no-merges", "--merges", "--first-parent", "--left-right", "--cherry-pick",
  "--topo-order", "--date-order", "-L", "--full-history", "--ancestry-path", "--no-walk", "--boundary",
  "--relative-date", "-m", "-c", "--cc", "--source", "--show-signature",
];
// per subcommand: the flags it may take, and which of them take a value (attached, after =, or the next word)
const FLAGS = {
  status: { ok: ["-s", "--short", "-b", "--branch", "--porcelain", "--long", "-u", "--untracked-files", "--ignored", "-z", "--show-stash", "--ahead-behind", "--no-ahead-behind", "-v", "--verbose"], value: [] },
  diff: { ok: [...DIFFISH, "--cached", "--staged", "--merge-base"], value: [] },
  log: { ok: LOGISH, value: ["-n", "-L", "-S", "-G"] },
  show: { ok: LOGISH, value: ["-n", "-L", "-S", "-G"] },
  blame: { ok: ["-L", "-w", "-M", "-C", "-e", "--show-email", "-s", "-l", "-t", "-f", "--show-name", "-n", "--show-number", "-p", "--porcelain", "--line-porcelain", "--date", "--root", "--show-stats", "--abbrev", "-c", "--color-lines", "--color-by-age", "--first-parent", "--ignore-rev", "--progress", "--no-progress"], value: ["-L", "--ignore-rev"] },
  add: { ok: ["-A", "--all", "-u", "--update", "-p", "--patch", "-N", "--intent-to-add", "-n", "--dry-run", "-v", "--verbose"], value: [] },
  commit: { ok: ["-m", "--message", "-F", "--file", "-a", "--all", "-q", "--quiet", "-v", "--verbose", "--amend", "--no-edit", "--allow-empty", "--fixup", "--squash"], value: ["-m", "-F"] },
};
const MESSAGE_FLAGS = new Set(["-m", "--message"]);
const TEMP_DIRS = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "time", "timeout", "stdbuf", "command", "builtin", "exec", "xargs", "caffeinate", "ionice", "unbuffer", "chronic"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "("]);
const C_KEYS_OK = /^(color\.[a-z.]+|core\.quotepath|advice\.[a-z.]+)=/i;
const ASSIGN = /^(GIT_[A-Z0-9_]+|HOME|XDG_CONFIG_HOME)=/;

const outsideRoot = (p, root) => {
  const r = path.resolve(root, p);
  return r !== root && !r.startsWith(root + path.sep);
};
const pathEscapes = (p) => p.startsWith("/") || p.split("/").includes("..");

/**
 * Why this simple command, if it runs git, can print an ignored file such as .env.local, or "" when it cannot by any
 * form below. The pre-approved subcommands are held to a short list (rule 7's approach); the rest are checked for the
 * known forms only, best-effort (DEBT D-22).
 */
function gitCheck(text, root) {
  const { words, cont } = lexWords(text.replace(/\n\x1f/g, "\n"));
  // an assignment of a variable git reads (GIT_DIR, GIT_EXTERNAL_DIFF, GIT_CONFIG_*, HOME …), as a prefix or exported
  let i = 0;
  const assignsGit = (k) => ASSIGN.test(words[k].text);
  if (words.length && /^(export|declare|typeset|readonly|local)$/.test(words[0].text)) {
    if (words.slice(1).some((w) => ASSIGN.test(w.text))) return "an assignment of a variable git reads (GIT_*, HOME, XDG_CONFIG_HOME)";
    return "";
  }
  // find git: past shell keywords, assignments and wrappers with their options and numbers
  let wrapped = false;
  while (i < words.length) {
    const t = words[i].text;
    if (KEYWORDS.has(t)) i++;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      if (assignsGit(i)) return "an assignment of a variable git reads (GIT_*, HOME, XDG_CONFIG_HOME)";
      wrapped = true;
      i++;
    } else if (WRAPPERS.has(t.replace(/.*\//, ""))) {
      wrapped = true;
      i++;
      while (i < words.length && (/^-/.test(words[i].text) || /^\d+[smhd]?$/.test(words[i].text))) {
        if (/^-(n|u|g|k|s|S|C|E|I|L|P)$/.test(words[i].text)) i++;
        i++;
      }
    } else break;
  }
  if (i >= words.length || words[i].text.replace(/.*\//, "").toLowerCase() !== "git") return "";
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
      if (/^(-C|--git-dir|--work-tree)$/.test(g) && outsideRoot(v, root)) return `git ${g} outside the repository`;
      globals[globals.length - 1].v = v;
      j++;
    } else if (/^--(git-dir|work-tree)=/.test(g) && outsideRoot(g.split("=")[1], root)) return `git ${g.split("=")[0]} outside the repository`;
    else if (/^--config-env=/.test(g)) return "git --config-env, which can make git run a program";
    else if (!GLOBAL_OK.has(g) && !GLOBAL_KNOWN.test(g)) return `git with the global option ${g}, which git may read as taking a value`;
  }
  const subWord = words[j];
  const sub = subWord ? subWord.text.toLowerCase() : "";
  const args = words.slice(j + 1);

  if (PRE_APPROVED.includes(sub)) return preApproved(sub, { words, cont, wrapped, gitWord, globals, subWord, args, i, j }, root);
  return otherGit(sub, args);
}

/** The pre-approved subcommands run with no prompt, so they take only their short lists. */
function preApproved(sub, c, root) {
  const lead = `a pre-approved git ${sub}`;
  if (c.wrapped || c.words.slice(0, c.i).some((w) => !KEYWORDS.has(w.text))) return `${lead} behind a VAR= prefix or a wrapper; run git bare`;
  if (!c.gitWord.plain || c.gitWord.text !== "git" || !c.subWord.plain) return `${lead} not spelled as plain lower-case git ${sub}; spell it plainly`;
  if (c.cont) return `${lead} continued with a backslash-newline; put it on one line`;
  for (const { g, v } of c.globals) {
    if (GLOBAL_OK.has(g) || (g === "-c" && C_KEYS_OK.test(v)) || (g === "-C" && v && !pathEscapes(v))) continue;
    return `${lead} with the global option ${g}, which is not on its short list`;
  }
  const spec = FLAGS[sub];
  const countFlag = (t) => /^-\d+$/.test(t) && (sub === "log" || sub === "show");
  const optional = new Set(sub === "status" ? ["-u"] : ["-U", "-M", "-C"]); // -U3, -M50, -uno: an attached value may follow
  let message = false; // the next word is a -m text
  let paths = false; // after --
  for (let k = 0; k < c.args.length; k++) {
    const w = c.args[k];
    const t = w.text;
    // a -m text is one word, so inside double quotes it may expand and run over lines ("$(cat <<'EOF' …)")
    if (message) {
      if (w.bare) return `${lead} whose message the shell expands outside double quotes, into more words; quote it or use -F`;
      message = false;
      continue;
    }
    const attachedMessage = sub === "commit" && /^(--message=|-[a-zA-Z]*m.)/.test(t) && !w.bare;
    if (w.expands && !attachedMessage) return `${lead} with ${t}, which the shell expands after this hook has read it; spell it out`;
    if (w.nl && !attachedMessage) return `${lead} with a newline inside a word; write a multi-line message to a file and use -F`;
    if (paths || t === "-" || !t.startsWith("-")) {
      if (pathEscapes(t)) return `${lead} with the path ${t}, outside the repository or through ..; give a path inside it`;
      if (namesEnv(t) && sub !== "status") return `${lead} that names ${t}`;
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
        const r = fileOk(v, root);
        if (r) return `${lead} -F ${v}: ${r}`;
        continue;
      }
      if (value !== null && namesEnv(value)) return `${lead} with ${t}, which names an env file`;
      if (name === "--ignore-rev") k++; // its value is a revision
      continue;
    }
    // a bundle of short flags, -abc: each must be on the list; one that takes a value takes the rest or the next word
    for (let x = 1; x < t.length; x++) {
      const f = "-" + t[x];
      const rest = t.slice(x + 1);
      if (!spec.ok.includes(f)) return `${lead} given ${f}${t.length > 2 ? ` (in ${t})` : ""}, which is not on its short list of flags`;
      if (optional.has(f) && /^[A-Za-z0-9%]*$/.test(rest)) break;
      if (!spec.value.includes(f)) continue;
      const v = rest !== "" ? rest : c.args[k + 1] ? c.args[k + 1].text : "";
      if (f === "-m") message = rest === "";
      else {
        if (rest === "") k++;
        if (rest === "" && c.args[k] && (c.args[k].expands || c.args[k].nl)) return `${lead} with ${c.args[k].text}, which the shell expands after this hook has read it; spell it out`;
        if (f === "-F") {
          const r = fileOk(v, root);
          if (r) return `${lead} -F ${v}: ${r}`;
        } else if (namesEnv(v)) return `${lead} with ${f} ${v}, which names an env file`;
      }
      break;
    }
  }
  return "";
}

/** A -F message file: a plain path in the repository or a temp directory, not an env file; - is stdin, which rules 1
 * and 1c keep an env file out of */
function fileOk(v, root) {
  if (v === "-") return "";
  if (v === "") return "no message file given";
  if (namesEnv(v)) return "it names an env file";
  const r = path.resolve(root, v);
  if (!(r.startsWith(root + path.sep) || TEMP_DIRS.some((d) => r.startsWith(d)))) return "a file outside the repository and the temp directories";
  return "";
}

// the forms that read outside the index or stage an ignored file, for git commands that are not pre-approved; git
// takes any unambiguous prefix of a long option, so a word that is a 3+ character prefix of one counts
const REFUSED_LONG = { grep: ["--no-index", "--no-exclude-standard"], stash: ["--all"] };
const REFUSED_SHORT = { stash: "a" };

function otherGit(sub, args) {
  if (/^(difftool|mergetool)$/.test(sub)) return `git ${sub}, which runs another program`;
  if (sub === "config") {
    const reads = args.some((a) => /^(--get|--get-all|--get-regexp|-l|--list|--show-origin|--show-scope|get|list)$/.test(a.text));
    if (!reads) return "a git config write, which can make every later git command run a program";
  }
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

module.exports = { gitCheck, lexWords, PRE_APPROVED };
