/**
 * Cases for guard-bash rule 1 that span more than one simple command, or are not git, found by the reviews of #336.
 * Kept apart from cases.ts so both files stay under the target size limit. Nothing here is executed.
 */

const envFile = ".env" + ".local";

/** guard-bash.sh must refuse these (exit 2): readers rule 1 did not list, and git fed names by a pipe */
export const RULE1_BLOCKED: readonly string[] = [
  `dd if=${envFile}`,
  `egrep . ${envFile}`,
  // a link: a pre-approved git add and git diff --cached would print it
  `ln ${envFile} x`,
  `comm ${envFile} x`,
  `rev ${envFile}`,
  `iconv -f utf-8 ${envFile}`,
  `python3.12 -c 'print(open("${envFile}").read())'`,
  `echo ${envFile} | xargs git hash-object -w`,
  `printf '%s\\n' ${envFile} | git update-index --add --stdin`,
  // the splitter on dev reads these as the shell does; a change to it must keep refusing them
  `cat <<< x\necho 'a\nb' ; cat ${envFile}`,
  `cat <<'EOF'\nx \\\nEOF\necho 'a\nb' ; cat ${envFile}`,
  `(( y = 1 << 2 ))\necho 'a\nb' ; cat ${envFile}`,
  `ksh -c 'cat ${envFile}'`,
  `dd of=${envFile}`,
];

/** guard-bash.sh must refuse these with the rule 1d text and this reason: git across two simple commands */
export const GIT_MULTI_BLOCKED: readonly (readonly [string, string])[] = [
  ["HOME+=/../../private/tmp/x; git diff HEAD~1", "assignment of a variable git reads"],
  ["printf -v HOME %s /private/tmp/x; git diff HEAD~1", "assignment of a variable git reads"],
  [
    "export EDITOR='sh /private/tmp/x/e.sh'; git commit --allow-empty",
    "assignment of a variable git reads",
  ],
  ["cd / && git diff var/empty Users", "outside the repository's work tree"],
  ["cd && git log -1", "outside the repository's work tree"],
  ["cd - && git log -1", "outside the repository's work tree"],
  ["make help | git commit -F -", "not a quoted heredoc"],
  // the sixth review: the splitter reads the & of &> as a separator; cd's options leave the repository; a heredoc
  // token inside quotes is not a heredoc
  ["git log -1 --format=%x21.en%x76.local &>> .gitignore", "a redirect to"],
  ["git log -1 --format=exit%x200 &> .claude/hooks/guard-bash.sh", "a redirect to"],
  ["cd -- && git log -1", "outside the repository's work tree"],
  [
    "cd -P && git diff Documents/trading-app/demo-1/docs Documents/trading-app/demo-1",
    "outside the repository's work tree",
  ],
  [
    'make help | if true; then git commit --allow-empty -F - -- ":(exclude)<<\'x"; fi',
    "not a quoted heredoc",
  ],
];

/** the seventh review: cd forms the old check did not see, and a cd into .git, where git sees no work tree */
export const GIT_CD_BLOCKED: readonly string[] = [
  "cd .git && git diff docs .",
  "builtin cd / && git diff private/var/empty Users",
  "\\cd / && git diff private/var/empty Users",
  "chdir / && git diff private/var/empty Users",
  "{ cd /; } && git diff private/var/empty Users",
  "if cd /; then git diff private/var/empty Users; fi",
  "CDPATH=/ cd private && git diff var/empty x",
  "cd docs/no-such-directory && git log -1",
  "git -C .git diff docs .",
];

/** guard-bash.sh must refuse these when the shell is already in this directory (the payload's cwd, from root) */
export const GIT_CWD_BLOCKED: readonly (readonly [string, string])[] = [
  ["git diff docs .", ".git"],
  ["git log -1", "/tmp"],
];

/** guard-bash.sh must allow these from this directory */
export const GIT_CWD_ALLOWED: readonly (readonly [string, string])[] = [
  ["git log --oneline -1", "docs"],
  ["git diff ../README.md", "docs"],
];

/** guard-bash.sh must allow these (exit 0) */
export const GIT_MULTI_ALLOWED: readonly string[] = [
  "cd docs && git diff ../README.md",
  "git -C docs log --oneline -1",
  "cd docs && git log --oneline -1",
  "cd . && git status --short",
  "git commit -q -F - <<'EOF'\nfeat: x\n\nwhy it is needed\nEOF",
];
