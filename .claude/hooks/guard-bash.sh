#!/usr/bin/env bash
# PreToolUse hook for Bash. Splits the command into simple commands (quote-aware,
# the inside of $(…) and `…` included), strips wrappers from each head (sudo, env,
# xargs, nice, time, VAR=value prefixes, /bin/ paths, a leading backslash, shell
# keywords) and refuses, with exit 2 and the reason on stderr:
#   1  reads or writes of .env files other than .env.example (readers, interpreters,
#      --env-file, redirects, quoted or not, any case), and pipelines that feed one
#      to a reader (echo .env.local | xargs cat)
#   2  writes into the pinned corpora (scripts/canonical/data) and the golden inputs
#      (tests/golden/*.json), including rm/mv/git rm/git checkout/find -delete,
#      redirects, fixers, and destructive verbs on their parent directories
#   3  shell writes into the live-runner paths of live-paths.txt (same list as
#      guard-paths) unless QT_ALLOW_LIVE_EDITS=1, with a FENCE DOWN notice when set
#   4  mirror pushes; force, delete or +refspec pushes that touch dev or main,
#      including a bare `git push --force` while dev or main is checked out
#   5  git commit --no-verify (any unambiguous prefix), -n, or HUSKY=0
#   6  a command that names scripts/canonical/enable-broker-mirror.ts anywhere (an enable-broker
#      name, continuation lines and quotes included) and runs anything that can execute it: an
#      interpreter, a TypeScript or package runner by any path, timeout, ssh (DEBT D-33; lifts
#      when MODERNISATION P19 lands). Reading the file stays allowed
#   7  pre-approved commands turned into writes: make with an alternate makefile
#      (-f, -C, --eval, MAKEFILES=, a makefile on stdin — quoted or not), a host
#      target beside another goal, behind a flag or behind an override, or a
#      variable override containing shell metacharacters;
#      git diff/log/show/blame/grep --output or -O; vitest -u/--outputFile;
#      prettier --check combined with --write; prettier or vitest given a file to
#      import (--config, --plugin, --setupFiles, --globalSetup, vitest -c)
#   8  raw host commands: ssh, scp, sftp or rsync run bare (lower case, unquoted,
#      first word of its own command) reach only the qt alias, with no user@ and
#      only short-listed options, read before and after the host; any other
#      command that names a host word is refused unless it only reads or prints
#      it, as are a command word built from a substitution, a variable, or a glob
#      that matches a host word, anything but a reader fed by a pipe or heredoc that named one, a
#      host word on a continuation line, RSYNC_RSH/GIT_SSH*, git told to run
#      another program or to reach an ssh remote, and anything but a reader
#      naming ~/.ssh. Best-effort against plain and accidental forms; a
#      deliberate spelling can still get past a text check (DEBT D-22)
# Pattern-based and best-effort by nature (DEBT D-22); the permission deny rules
# are the hard stop for Claude's own file tools. Fails CLOSED on any inspection
# error. Every rule has a case in tests/hooks/hooks.test.ts.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trap 'echo "guard-bash: internal error while inspecting the command; refusing" >&2; exit 2' ERR
command -v node >/dev/null || { echo "guard-bash: node not found; refusing" >&2; exit 2; }
input=$(cat)
raw=$(printf '%s' "$input" | node "$here/lib/hook-input.cjs" segments) || { echo "guard-bash: could not read the tool input; refusing" >&2; exit 2; }
[ -n "$raw" ] || exit 0
root="${CLAUDE_PROJECT_DIR:-$PWD}"

deny() { printf 'guard-bash: refusing "%s" — %s\n' "$1" "$2" >&2; exit 2; }

# live-path regex from live-paths.txt (glob → regex; `dir/**` also matches the bare directory), and the
# list of every directory that holds a fenced or protected file (plus each parent): a destructive verb on
# one of those takes the files with it, so `destroys` refuses the directory itself (any trailing /, // or
# /.) and any globbed or brace-expanded path beneath it — never a plain path to one specific file.
live_re=""
anc_list=" scripts/canonical/data tests/golden"
add_ancestors() {
  local d=$1
  while [ -n "$d" ] && [ "$d" != "." ] && [ "$d" != "/" ]; do
    case "$anc_list" in *" $d "*|*" $d") ;; *) anc_list="$anc_list $d";; esac
    d=${d%/*}
    [ "$d" = "$1" ] && break
    case "$d" in */*) ;; *) case "$anc_list" in *" $d "*|*" $d") ;; *) anc_list="$anc_list $d";; esac; break;; esac
  done
}
add_ancestors scripts/canonical/data
add_ancestors tests/golden
while IFS= read -r pattern; do
  case "$pattern" in ''|'#'*) continue;; esac
  r=$(printf '%s' "$pattern" | sed -E 's/[.]/\\./g; s#/\*\*$#(/.*)?#; s/\*\*/@@/g; s#\*#[^[:space:]/]*#g; s/@@/.*/g')
  live_re="${live_re:+$live_re|}$r"
  dir=${pattern%/\*\*}                      # dir/** → dir
  last=${dir##*/}
  case "$last" in *\**|*.*) dir=${dir%/*};; esac   # a globbed or file last component → its directory
  [ "$dir" != "$pattern" ] || [ "${pattern%/\*\*}" != "$pattern" ] || true
  add_ancestors "$dir"
done < "$here/live-paths.txt"
bnd='([[:space:]"'"'"'/]|$)'
protected="(scripts/canonical/data|tests/golden/[^[:space:]\"']*\\.json)${bnd}"
live="(${live_re})${bnd}"
# directories above protected paths: a destructive verb on one of these takes the protected files with it
anc_dirs="($(printf '%s' "${anc_list# }" | sed 's/[.]/\\./g; s/ /|/g'))"
ancestors="${anc_dirs}((/+\.?)*([[:space:]\"']|$)|(/[^[:space:]\"']*)?([][*?{]|//|/\.\.?(/|[[:space:]\"']|$)))" # the directory itself; a glob/brace beneath it; a //, /. or /.. segment anywhere beneath it

envfile='\.env(rc|[._-][A-Za-z0-9_.-]*)?'
tail_='([^A-Za-z0-9_]|$)'
q="[\"']?"
pathprefix='([^[:space:];&|"'"'"']*/)?'
readers='(cat|less|more|head|tail|nl|tac|paste|uniq|column|fold|fmt|hexdump|grep|rg|ag|sed|awk|cut|sort|diff|cmp|cp|mv|rm|tee|source|\.|vi|vim|nano|open|scp|rsync|base64|xxd|od|strings|dotenv|export|set|perl|python3?|node|ruby|php|bash|sh|zsh|jq|xargs)'
interpreters='(node|python3?|perl|ruby|php|bash|sh|zsh|eval)'
mirror_script='enable-broker'                       # the script's name, and any glob that spells it out to here
# rule 6's runners: anything that can execute a TypeScript file, by name at any path
runner_words='(node|python3?|perl|ruby|php|bash|sh|zsh|eval|awk|gawk|tsx|ts-node|vite-node|vite|vitest|jiti|bun|bunx|deno|npx|pnpx|pnpm|yarn|npm|corepack|timeout|ssh)'
anywriters='(mv|rm|tee|truncate|touch|chmod|chown|mkdir|rmdir|shred|unlink|ln)'
destwriters='(cp|install|rsync|scp)'
destructive='(rm|mv|truncate|shred|unlink|rmdir)'
writeish='(writeFile|appendFile|createWriteStream|unlink|rename|rmSync|rmdir|mkdir|copyFile|truncate|chmod|chown|os\.remove|shutil|FileUtils|fopen\(|open\([^)]*["'"'"'][wax])'

# strip shell keywords, grouping characters, wrappers, VAR=value prefixes, directory prefixes and a leading backslash
strip_kw() {
  local s=$1 prev=""
  while [ "$s" != "$prev" ]; do
    prev=$s
    s=$(sed -E 's/^(((do|then|else|elif|if|while|until|time|exec|command|builtin|nohup|nice|env|sudo)[[:space:]]+)|((sudo|env|nice)[[:space:]]+-[A-Za-z0-9]+[[:space:]]+)|([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)|(xargs([[:space:]]+-[A-Za-z0-9{}]+([[:space:]]+[^[:space:]-][^[:space:]]*)?)*[[:space:]]+)|[{(!][[:space:]]*)+//; s#^(/[^[:space:]]*/)?\\?##' <<<"$s")
  done
  printf '%s' "$s"
}
strip_keywords_only() { sed -E 's/^(((do|then|else|elif|if|while|until|time)[[:space:]]+)|[{(!][[:space:]]*)+//' <<<"$1"; }
unquoted() { sed -E "s/\"[^\"]*\"//g; s/'[^']*'//g" <<<"$1"; }

# does the lower-cased segment write to a path matching $1? ($2 = lower-cased segment, $3 = its unquoted form)
writes_to() {
  local target=$1 seg_l=$2 uq_l=$3 last
  last=${seg_l##* }
  grep -qiE "^${anywriters}([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^(sed|perl)[[:space:]]" <<<"$seg_l" && grep -qiE "(^|[[:space:]])(-[a-zA-Z]*i|--in-place)" <<<"$uq_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^${interpreters}([[:space:]]|$)" <<<"$seg_l" && grep -qiE "$writeish" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^${destwriters}([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[/\"'])${target}" <<<"$last" && return 0
  grep -qiE "^git[[:space:]]+(checkout|restore|rm|mv|clean|apply|am|cherry-pick|revert|stash)([[:space:]]|$)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE "^find[[:space:]].*(-delete|-exec|-ok)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  grep -qiE ">[|]?[[:space:]]*[\"']?${pathprefix}${target}" <<<"$seg_l" && return 0
  grep -qiE "^pnpm[[:space:]]+(exec[[:space:]]+)?(prettier[[:space:]].*(-w|--write)|eslint[[:space:]].*--fix|lint[[:space:]].*--fix)" <<<"$seg_l" && grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l" && return 0
  return 1
}
destroys() { # destructive verbs only, for parent directories
  local target=$1 seg_l=$2
  grep -qiE "^(${destructive}|git[[:space:]]+(rm|checkout|restore|clean)|find)([[:space:]]|$)" <<<"$seg_l" || return 1
  grep -qiE "(^|[[:space:]/\"'])${target}" <<<"$seg_l"
}

# rule 8's helpers. Host words open an ssh connection or run one. A segment names one when the word appears in it
# as a word once quotes and backslashes are gone and case is folded: 'ssh', s\sh, SSH, ./ssh, =ssh, c=ssh and
# {ssh,…} all do; ~/.ssh/… and ssh-keygen do not.
host_words='(ssh|slogin|scp|sftp|rsync|autossh|sshpass|ssh-copy-id|ssh-agent|ssh-keyscan|sshfs|mosh)'
mentions_host() {
  local t=${1//\"/}
  t=${t//\'/}; t=${t//\\/}
  t=${t//\$[0-9]/}                                  # a positional parameter is empty here: $1ssh is ssh
  # a test with no subprocess first: most segments name no host word, and every hook has a 10 s budget
  case "$t" in
    *[sS][sS][hH]*|*[sS][cC][pP]*|*[sS][fF][tT][pP]*|*[rR][sS][yY][nN][cC]*|*[sS][lL][oO][gG][iI][nN]*|*[mM][oO][sS][hH]*) ;;
    *) return 1 ;;
  esac
  t=$(tr '[:upper:]' '[:lower:]' <<<"$t")
  grep -qE "(^|[^a-z0-9_.-])${host_words}([^a-z0-9_-]|$)" <<<"$t"
}
# git's words with quotes gone and its global options dropped, so `git -P push …` and `git -C x push …` read as push
git_words() {
  tr -d "\"'\\\\" <<<"$1" | awk '{
    i = 2
    while (i <= NF && substr($i, 1, 1) == "-") { if ($i == "-C" || $i == "-c" || $i == "--git-dir" || $i == "--work-tree" || $i == "--namespace") i++; i++ }
    w = "git"; for (j = i; j <= NF; j++) w = w " " $j; print w }'
}
# a command for which a host word is data, not a command to run: readers, printers, and git's local subcommands
inert_mention() {
  case "$1" in
    grep|egrep|fgrep|ag|echo|which|whereis|type|ls|cat|head|tail|wc|file|stat|jq|shellcheck) return 0 ;;
    printf) ! grep -qE '^printf[[:space:]]+-v' <<<"$2" ;;   # printf -v assigns, and the variable can be run
    rg) ! grep -qE -- '--pre' <<<"$2" ;;                    # rg --pre runs a program on each file
    man) ! grep -qE '(^|[[:space:]])-[A-Za-z]*P' <<<"$2" ;; # man -P names the pager it runs
    git) grep -qE "^git[[:space:]]+(commit|log|show|diff|blame|status|add)([[:space:]]|$)" <<<"$(git_words "$2")" ;;
    *) return 1 ;;
  esac
}
# an ssh -o that the qt alias's connection sharing uses (the Makefile's options), never one that changes the host,
# user, port, identity, proxy, forwarding or config
ssh_option_ok() {
  local key=${1%%=*} value=${1#*=}
  [ "$key" != "$1" ] || return 1
  case "$(tr '[:upper:]' '[:lower:]' <<<"$key")" in
    controlmaster|controlpersist|batchmode|connecttimeout|serveraliveinterval|serveralivecountmax) return 0 ;;
    controlpath) case "$value" in \~/.ssh/qt-*) return 0 ;; esac ;;
  esac
  return 1
}
# host_check <ssh|scp|sftp|rsync> <arguments>: 0 when every host the command reaches is the qt alias, given with
# no user, and every option is on the short list; ssh's options are read before and after the host, as OpenSSH
# reads them, up to the remote command. Else 1 and $host_reason
host_reason=""
host_check() {
  local cmd=$1 args toks tok dest="" end=0 want="" remote bare
  # $ and backticks outside single quotes expand before the command sees them, to an option or a host
  bare=$(sed -E "s/'[^']*'//g" <<<"$2")
  case "$bare" in
    *'$'*|*'`'*) host_reason="$cmd with \$ or a backtick outside single quotes, which can expand to an option or a host; single-quote the remote part"; return 1 ;;
  esac
  args=$(tr -d "\"'\\\\" <<<"$2")                    # quotes and backslashes go; the words stay
  read -r -a toks <<<"$args"
  case "$cmd" in
    ssh|sftp)
      for tok in ${toks[@]+"${toks[@]}"}; do
        if [ -n "$want" ]; then
          case "$want:$tok" in
            o:*) ssh_option_ok "$tok" || { host_reason="ssh -o $tok is not one of the qt alias's connection-sharing options"; return 1; } ;;
            O:exit|O:check|O:stop) ;;
            L:*) grep -qE '^[0-9]+:(localhost|127\.0\.0\.1):[0-9]+$' <<<"$tok" || { host_reason="ssh -L $tok forwards somewhere other than the host's own loopback"; return 1; } ;;
            *) host_reason="ssh -$want $tok is not allowed"; return 1 ;;
          esac
          want=""; continue
        fi
        if [ "$end" = 0 ] && [ "$tok" = "--" ]; then
          [ -z "$dest" ] || break
          end=1; continue
        fi
        if [ "$end" = 0 ] && [ "${tok#-}" != "$tok" ]; then
          case "$cmd:$tok" in
            ssh:-o|ssh:-O|ssh:-L) want=${tok#-} ;;
            ssh:-o?*) ssh_option_ok "${tok#-o}" || { host_reason="ssh $tok is not one of the qt alias's connection-sharing options"; return 1; } ;;
            ssh:-*[!46CGNnqtTvx]*|sftp:-*[!46Cqv]*)
              host_reason="$cmd $tok changes the host, user, port, config, proxy or forwarding, or is not on the short list; the qt alias carries its own settings"; return 1 ;;
          esac
          continue
        fi
        case "$tok" in *[*?[]*) host_reason="$cmd $tok: a glob where $cmd still reads its host or options"; return 1 ;; esac
        [ -z "$dest" ] || break                       # the remote command starts: ssh reads no option after it
        dest=$tok; end=0                              # after the host, ssh reads options again, even after a --
      done
      [ -z "$want" ] || { host_reason="$cmd -$want has no value"; return 1; }
      [ "$cmd" = ssh ] || dest=${dest%%:*}           # sftp takes host:path; ssh takes the host after the last @
      [ "$dest" = qt ] || { host_reason="$cmd to ${dest:-no host}; raw host commands go to the qt alias only, with no user@"; return 1; } ;;
    scp|rsync)
      case "$(sed -E "s/\"[^\"]*\"//g" <<<"$bare")" in
        *[*?[]*) host_reason="$cmd with an unquoted glob, which can expand to a host:path; quote it"; return 1 ;;
      esac
      for tok in ${toks[@]+"${toks[@]}"}; do
        case "$cmd:$tok" in
          rsync:-e*|rsync:--rsh*|rsync:-[!-]*e*|scp:-*[!-346BCOpqrv]*)
            host_reason="$cmd $tok sets a remote shell, a port, a config, a proxy or another option off the short list"; return 1 ;;
        esac
        case "$tok" in
          -*) ;;
          *::*|*://*)
            host_reason="$cmd $tok is a daemon or URL form; use qt:path"; return 1 ;;
          [!/]*:*)
            remote=${tok%%:*}
            [ "$remote" = qt ] || { host_reason="$cmd to $remote; raw host commands go to the qt alias only, with no user@"; return 1; } ;;
        esac
      done ;;
  esac
  return 0
}

notice_emitted=0
pipeline_host=0
prev_host=""
prev_cont=0
pipeline_env=0
in_compound=0
any_protected=0
destructive_elsewhere=""
# rule 6 reads the whole command, continuation lines included, with quotes and backslashes gone: a name split
# across lines, behind a VAR= prefix or hidden in quotes is still the script's name
mirror_named=0
grep -qi "$mirror_script" <<<"$(tr -d "\"'\\\\\n\037" <<<"$raw")" && mirror_named=1
runner_seen=""
bs_cont=0
# rule 6, only when the command names the script: does this text run something that could execute it? A runner
# word anywhere in it counts, quotes gone and case folded, so VAR="a b", xargs -I{}, find -exec, nice -n, sudo -u
# and a quoted path do not hide one. Not if the command only reads or prints, nor eslint, prettier or tsc with no
# flag that loads a module (prettier --config and --plugin import the file they name)
# mirror_runner <command, wrappers stripped> [<the segment as written>]: the head is read from the first, runner
# words from the second, so one inside a VAR= value (GIT_EDITOR="tsx …" git commit) still counts
mirror_runner() {
  local r q h w
  r=$(tr -d "\"'\\\\" <<<"$1")
  q=$(tr '[:upper:]' '[:lower:]' <<<"$r")
  w=$(tr -d "\"'\\\\" <<<"${2:-$1}" | tr '[:upper:]' '[:lower:]')
  h=${q#"${q%%[![:space:]]*}"}; h=${h%%[[:space:]]*}; h=${h##*/}
  if grep -qE "^[[:space:]]*(pnpm|npx)[[:space:]]+(exec[[:space:]]+)?(eslint|prettier|tsc)([[:space:]]|$)" <<<"$q" \
     && ! grep -qE "(^|[[:space:]])(-c|--config|--plugin|--rulesdir|--resolve-plugins-relative-to|--loader|--import|--require|-r|-f|--format)(=|[[:space:]]|$)" <<<"$q"; then
    return 1
  fi
  # a reader only reads, unless git is handed a -c (diff.external, core.pager and others run a program)
  if inert_mention "$h" "$r" && ! { [ "$h" = git ] && grep -qE "(^|[[:space:]])-c[[:space:]]" <<<"$q"; }; then return 1; fi
  grep -qE "(^|[^a-z0-9_.-])${runner_words}([^a-z0-9_-]|$)" <<<"$w"
}
fence_down="${QT_ALLOW_LIVE_EDITS:-0}"

tab=$'\t'
while IFS=$'\t' read -r sep seg; do
  case "$sep" in
    start|and|or|pipe|seq|bg|nl|subst) ;;
    *)
      # a continuation line of the previous command (a backslash-newline, or a newline inside quotes), which the
      # rules above never see; a tab in it splits it, so the whole line is read again. A host command may not
      # continue over lines, except an ssh whose remote command carries on inside quotes; no other command may
      # name a host word on one
      line="$sep${seg:+$tab$seg}"; line=${line#$'\x1f'}
      # rule 6: after a backslash-newline the command goes on (FOO=1 \ newline tsx …); a newline inside quotes is
      # text, such as a commit message's next line
      if [ "$mirror_named" = 1 ] && [ "$bs_cont" = 1 ] && mirror_runner "$line"; then runner_seen=$line; fi
      case "$line" in *\\) bs_cont=1 ;; *) bs_cont=0 ;; esac
      case "$prev_host" in
        scp|sftp|rsync) deny "$line" "a host command continued over several lines; put it on one line (docs/DEV_SETUP.md §17)" ;;
        ssh) [ "$prev_cont" = 0 ] || deny "$line" "an ssh continued with a backslash-newline, where its options would hide; put it on one line, or the remote part in a file for ssh qt 'bash -s' < file (docs/DEV_SETUP.md §17)" ;;
        *) if mentions_host "$line"; then deny "$line" "a continuation line names a host command (docs/DEV_SETUP.md §17)"; fi ;;
      esac
      continue ;;
  esac
  [ -n "$seg" ] || continue
  case "$seg" in *\\) bs_cont=1 ;; *) bs_cont=0 ;; esac
  orig=$seg
  s0=$(printf '%s' "$seg" | sed -E 's/\.env\.example//g')     # the example file is public
  xargs_fed=0
  case "$(strip_keywords_only "$s0")" in xargs*) xargs_fed=1;; esac
  s=$(strip_kw "$s0")
  lower=$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')
  uq=$(unquoted "$s")
  uq_lower=$(printf '%s' "$uq" | tr '[:upper:]' '[:lower:]')
  # a pipeline into a compound command (… | while read f; do cat "$f"; done) keeps its input across the `;`
  case "$seg" in while*|until*|if*|for*|case*) in_compound=1;; esac
  if [ "$sep" != "pipe" ] && [ "${in_compound:-0}" = "0" ]; then pipeline_env=0; pipeline_host=0; fi
  case "$seg" in done*|fi|fi\ *|esac*) in_compound=0;; esac

  # 1. a reader (after wrapper stripping) given an env file; a redirect to or from one; --env-file
  if grep -qiE "^${readers}([[:space:]]+[^[:space:]]+)*[[:space:]]+${q}(--env-file=)?${pathprefix}${envfile}${tail_}" <<<"$s" \
     || grep -qiE "[<>][|]?[[:space:]]*${q}${pathprefix}${envfile}${tail_}" <<<"$s" \
     || grep -qiE "(^|[[:space:]])--env-file(=|[[:space:]]+)${q}${pathprefix}${envfile}" <<<"$s"; then
    deny "$orig" "it reads or writes a .env file; secrets are never read, printed, moved or edited from a Claude session (CLAUDE.md, Secrets). .env.example is fine"
  fi
  mentions_env=0
  grep -qiE "(^|[^A-Za-z0-9_])${envfile}${tail_}" <<<"$s" && mentions_env=1
  # 1b. an interpreter whose program text names an env file (the path hides inside the quoted program)
  if [ "$mentions_env" = "1" ] && grep -qiE "^${interpreters}([[:space:]]|$)" <<<"$s"; then
    deny "$orig" "an interpreter is given a .env file name; secrets are never read, printed, moved or edited from a Claude session (CLAUDE.md, Secrets)"
  fi
  # 1c. a pipe-fed reader (or one inside the compound the pipe feeds) after a command that named an env file
  if { [ "$sep" = "pipe" ] || [ "${in_compound:-0}" = "1" ]; } && [ "$pipeline_env" = "1" ] && grep -qiE "^${readers}([[:space:]]|$)" <<<"$s"; then
    deny "$orig" "a command in this pipeline names a .env file and this one reads its input; secrets are never read from a Claude session (CLAUDE.md, Secrets)"
  fi
  [ "$mentions_env" = "1" ] && pipeline_env=1

  # 2. pinned corpora and golden inputs (plus their parent directories under a destructive verb)
  if writes_to "$protected" "$lower" "$uq_lower" || destroys "$ancestors" "$lower"; then
    deny "$orig" "pinned data and golden inputs are never written by hand (nor their parent directories removed); a new pin is a new file, the golden file is regenerated with make backtest-update (docs/DEV_SETUP.md §14)"
  fi

  # 3. live-runner paths
  if [ -n "$live_re" ] && writes_to "$live" "$lower" "$uq_lower"; then
    if [ "$fence_down" != "1" ]; then
      deny "$orig" "it writes a fenced live path (.claude/hooks/live-paths.txt); trading code — engine, runner, strategies, risk, sizing, execution, the engine's migrations, the paper engine's price config — changes only in a PR about it, in a session the operator started with the override. Stop and ask the operator (docs/decisions/0004, 0006)"
    fi
    if [ "$notice_emitted" = "0" ]; then
      notice="guard-bash: FENCE DOWN (live-path override is set) — shell write to a fenced live path: ${orig}"
      printf '%s' "$notice" | node -e '
        let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
          process.stdout.write(JSON.stringify({ systemMessage: s }));
        });'
      printf '%s\n' "$notice" >&2
      notice_emitted=1
    fi
  fi
  # a destructive verb whose path comes from elsewhere (xargs, a variable): judged across the whole command below
  if { grep -qiE "^(${destructive}|git[[:space:]]+(rm|checkout|restore|clean)|find[[:space:]])" <<<"$lower" \
       || { grep -qiE "^(sed|perl)[[:space:]]" <<<"$lower" && grep -qiE "(^|[[:space:]])(-[a-zA-Z]*i|--in-place)" <<<"$uq_lower"; }; } \
     && { [ "$xargs_fed" = "1" ] || grep -q '\$' <<<"$s"; }; then destructive_elsewhere=$orig; fi
  if grep -qiE "(^|[[:space:]/\"'])(${protected%"${bnd}"}|${live_re}|${anc_dirs})${bnd}" <<<"$lower"; then any_protected=1; fi

  # 4. protected branches
  if grep -qE "^git[[:space:]]+push([[:space:]]|$)" <<<"$s"; then
    if grep -qE "(^|[[:space:]])--mirror([[:space:]]|$)" <<<"$uq"; then
      deny "$orig" "git push --mirror rewrites every remote ref, dev and main included (protect-dev ruleset; docs/DEV_SETUP.md §12)"
    fi
    if grep -qE "(^|[[:space:]])(--force([[:space:]]|$|=)|--force-with-lease|--force-if-includes|-[a-zA-Z]*f[a-zA-Z]*([[:space:]]|$)|--delete|-[a-zA-Z]*d([[:space:]]|$)|\+[A-Za-z0-9_./-]*|:[A-Za-z0-9_./-]*)" <<<"$uq"; then
      if grep -qE "(^|[[:space:]:+/])(dev|main)([[:space:]:]|$)" <<<"$uq"; then
        deny "$orig" "no force, delete or +refspec push touching dev or main in any spelling (protect-dev ruleset; docs/DEV_SETUP.md §12)"
      fi
      refs=$(sed -E 's/(^|[[:space:]])-[^[:space:]]+//g' <<<"${uq#*push}")
      if [ "$(wc -w <<<"$refs" | tr -d ' ')" -le 1 ]; then          # no refspec: the checked-out branch is pushed
        cur=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
        case "$cur" in dev|main) deny "$orig" "a force push of the checked-out branch, which is $cur (protect-dev ruleset)";; esac
      fi
    fi
  fi

  # 5. hooks must run
  if grep -qE "(^|[[:space:]])HUSKY(_SKIP_HOOKS)?=" <<<"$orig" && grep -qE "git[[:space:]]+commit" <<<"$orig"; then
    deny "$orig" "HUSKY=0 skips gitleaks and the commit-msg hook; commit normally (docs/DEV_SETUP.md §9)"
  fi
  if grep -qE "^git[[:space:]]+commit([[:space:]]|$)" <<<"$s" \
     && grep -qE "(^|[[:space:]])(--no-v[a-z]*|-[a-zA-Z]*n[a-zA-Z]*)([[:space:]]|$)" <<<"$uq"; then
    deny "$orig" "git commit --no-verify / -n skips gitleaks and the commit-msg hook; commit normally (docs/DEV_SETUP.md §9)"
  fi

  # 6. the script that turns mirroring on: judged across the whole command below, so a path in a variable or
  # fed through a pipe is still seen; mirror_runner says what counts as a runner
  if [ "$mirror_named" = 1 ] && mirror_runner "$s" "$orig"; then runner_seen=$orig; fi

  # 7. pre-approved commands that can be turned into writes
  if grep -qiE "^make([[:space:]]|$)" <<<"$s"; then
    # quotes and backslashes removed but their content kept: a quoted '--eval=…', an escaped --e\val or a
    # quoted '-f' is still an option to make
    uqk=$(tr -d "\"'\\\\" <<<"$s")
    if grep -qE "(^|[[:space:]])(-f|--file|--makefile|-C|--directory|-e|--eval|-I|--include-dir)([[:space:]]|=|$)" <<<"$uqk"; then
      deny "$orig" "make with an alternate makefile, directory, include dir or --eval runs code the Makefile does not define"
    fi
    # MAKEFILES=/MAKEFLAGS= as an override (any assignment operator, quoted or not) or as an env prefix
    # (strip_kw removed a prefix from $s, so the original segment is checked too), or a makefile on stdin
    if grep -qE "(^|[[:space:]])(MAKEFILES|MAKEFLAGS|GNUMAKEFLAGS)(:{1,3}|[+?!])?=" <<<"$orig $uqk" || grep -q '<' <<<"$s"; then
      deny "$orig" "make reading a makefile or flags from MAKEFILES=/MAKEFLAGS= or stdin (<, <<, <<<) runs code the Makefile does not define"
    fi
    # the host targets run alone (CLAUDE.md's live-table rule, decision 0010): make runs every goal on its command
    # line, so a host goal behind another goal (`make lint-strict FILES=x unpause` matches the pre-approved
    # `make lint-strict *`), behind a flag (`make -s unpause` matches no ask rule) or behind an override
    # (`make REASON=x kill-switch`) would run without the prompt the ask rules give `make <host-target> …`;
    # the Makefile refuses the multi-goal shape too, while it reads the file. A quoted span with whitespace
    # collapses to one token (FILES="a b" is one override, not an override and a goal); the quotes around a
    # single word are dropped, so 'unpause' is still the host goal it is. The target of a bare redirect
    # operator (> file) is not a goal
    mq=$(sed -E "s/\"[^\"]*[[:space:]][^\"]*\"/Q/g; s/'[^']*[[:space:]][^']*'/Q/g; s/[\"']//g" <<<"$s")
    read -r -a mtoks <<<"$mq"
    host_goal=""; goals=0; flags=0; redirect_target=0
    if [ "${#mtoks[@]}" -gt 1 ]; then
      for tok in "${mtoks[@]:1}"; do
        if [ "$redirect_target" -eq 1 ]; then redirect_target=0; continue; fi
        case "$tok" in
          [0-9]\>|[0-9]\>\>|\>|\>\>|\&\>|\&\>\>) redirect_target=1 ;;
          *'>'*|*'<'*) ;;
          -*) flags=$((flags + 1)) ;;
          *=*) ;;
          deploy|deploy-pointer|status|logs|kill-switch|resume|unpause) host_goal=$tok; goals=$((goals + 1)) ;;
          *) goals=$((goals + 1)) ;;
        esac
      done
    fi
    if [ -n "$host_goal" ] && { [ "$goals" -ne 1 ] || [ "$flags" -ne 0 ] || [ "${mtoks[1]}" != "$host_goal" ]; }; then
      deny "$orig" "the host targets run alone: make $host_goal [NAME=value …] with no flag, no other goal and no override before the target (CLAUDE.md's live-table rule)"
    fi
    # a $ or a backtick anywhere in a make command is either a make function such as $(shell …), which runs when
    # make reads the override, or a shell expansion bash performs after this hook has looked
    if grep -qE '[$`]' <<<"$s"; then
      deny "$orig" "a make command containing \$ or a backtick: \$(shell …) runs when make reads the override, and bash expands \$'…' after the hook has looked"
    fi
    if grep -qE "[A-Za-z_][A-Za-z0-9_]*!=" <<<"$s"; then
      deny "$orig" "make's != operator runs its whole value in a shell (GNU make ≥ 4.0)"
    fi
    # each NAME=value token's VALUE (quoted or bare) must be free of shell metacharacters; redirects after it are fine
    while IFS= read -r assignment; do
      [ -n "$assignment" ] || continue
      value=${assignment#*=}
      value=${value#[\"\']}; value=${value%[\"\']}
      # metacharacters, quotes, backslashes and dollars can escape the recipe's quoting (bash decodes $'…' after
      # this hook has looked); a leading dash turns a host or file argument into an option (ssh -oProxyCommand=…)
      if grep -qE '[;&|<>`$\\"'"'"']' <<<"$value" || grep -qE '^-' <<<"$value"; then
        deny "$orig" "a make variable override containing a shell metacharacter, a quote, a backslash, a dollar sign or a leading dash would run inside the recipe or change what ssh/make does"
      fi
    done < <(grep -oE "[A-Za-z_][A-Za-z0-9_]*(:{1,3}|[+?!])?=(\"[^\"]*\"|'[^']*'|[^[:space:]]*)" <<<"$s" || true)
  fi
  if grep -qE "^git[[:space:]]+(diff|log|show|blame|grep)([[:space:]]|$)" <<<"$s" && grep -qE "(^|[[:space:]])(--output(=|[[:space:]])|-O|--ext-diff)" <<<"$uq"; then
    deny "$orig" "git --output / -O / --ext-diff write a file or run a command from a read-only git command"
  fi
  if grep -qE "^pnpm[[:space:]]+(exec[[:space:]]+)?vitest([[:space:]]|$)" <<<"$s" && grep -qE "(^|[[:space:]])(-u|--update|--updateSnapshot|--outputFile(=|[[:space:]]))" <<<"$uq"; then
    deny "$orig" "vitest -u / --outputFile writes files; snapshots and reports are not updated from a session"
  fi
  if grep -qE "^pnpm[[:space:]]+(exec[[:space:]]+)?prettier([[:space:]]|$)" <<<"$s" && grep -qE "(^|[[:space:]])--check([[:space:]]|$)" <<<"$uq" && grep -qE "(^|[[:space:]])(-w|--write)([[:space:]]|$)" <<<"$uq"; then
    deny "$orig" "prettier --check combined with --write is a write; use make format (an ask rule) on purpose"
  fi
  # prettier and vitest import and run the file a --config, --plugin, --setupFiles or --globalSetup flag names (vitest
  # -c too; prettier's -c is --check), and both are pre-approved, so such a flag would let an allowed check run code
  if grep -qE "^(pnpm|npx)[[:space:]]+(exec[[:space:]]+)?(prettier|vitest)([[:space:]]|$)" <<<"$s"; then
    qs=$(tr -d "\"'\\\\" <<<"$s")
    if grep -qE "(^|[[:space:]])(--config|--plugin|--setupFiles|--globalSetup)(=|[[:space:]]|$)" <<<"$qs" \
       || { grep -qE "^(pnpm|npx)[[:space:]]+(exec[[:space:]]+)?vitest([[:space:]]|$)" <<<"$qs" && grep -qE "(^|[[:space:]])-c(=|[[:space:]]|$)" <<<"$qs"; }; then
      deny "$orig" "prettier and vitest import the file a --config, --plugin, --setupFiles or --globalSetup flag names (vitest -c too), so a pre-approved check would run code; they find the repo's own config by themselves (docs/DEV_SETUP.md §16)"
    fi
  fi

  # 8. raw host commands. Run bare (ssh, scp, sftp or rsync, lower case and unquoted, the first word of its own
  #    command) they get host_check and prompt under their ask rules. Any other command that names a host word is
  #    refused unless it only reads or prints it (inert_mention), and so are a shell fed by a pipe that named one,
  #    an assignment of the program rsync or git reaches a host with, git told to run another program or to reach
  #    an ssh remote, and a shell write under ~/.ssh, which decides where qt goes
  host_head=${seg%%[[:space:]]*}
  case "$host_head" in
    ssh|scp|sftp|rsync)
      prev_host=$host_head
      case "$seg" in *\\) prev_cont=1 ;; *) prev_cont=0 ;; esac
      pipeline_host=1
      [ "$seg" != "$host_head" ] || continue         # the bare word alone prints usage and reaches nothing
      [ "$sep" != "subst" ] || deny "$orig" "a host command inside \$(…) or backticks; run it as its own command so the ask rule prompts (docs/DEV_SETUP.md §17)"
      host_check "$host_head" "${seg#"$host_head"}" || deny "$orig" "$host_reason (docs/DEV_SETUP.md §17)"
      continue ;;
  esac
  prev_host=""; prev_cont=0
  sq=${seg//\"/}; sq=${sq//\'/}; sq=${sq//\\/}       # the segment with quotes and backslashes gone, no subprocess
  nh=${s//\"/}; nh=${nh//\'/}; nh=${nh//\\/}
  nh=${nh%%[[:space:]]*}; nh=${nh##*/}
  case "$nh" in *[A-Z]*) nh=$(tr '[:upper:]' '[:lower:]' <<<"$nh") ;; esac
  # a command word built from a glob, a substitution, a quoted escape or a bare variable can be any program, a host
  # command among them (s?h, ss$()h, $'\x73sh', $c); an assignment, a case label and a test bracket are not commands
  w=${s%%[[:space:]]*}
  if ! [[ $w =~ ^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?= ]]; then
    case "$w" in
      '['|'[['|*')') ;;
      *'`'*|*'$('*)
        deny "$orig" "a command word built from a substitution can be any program, a host command among them; name the program (docs/DEV_SETUP.md §17)" ;;
      *)
        b=${w##*/}; b=${b//\"/}; b=${b//\'/}
        case "$b" in
          '$'[0-9]*) ;;                               # a positional parameter (empty here) or a price in heredoc text
          *'$'*) deny "$orig" "a variable or escape in the command's name can be any program, a host command among them; name the program (docs/DEV_SETUP.md §17)" ;;
          *[a-zA-Z]*[*?[]*|*[*?[]*[a-zA-Z]*)          # a glob with no letter (a markdown bullet's *) names nothing
            case "$b" in *[A-Z]*) b=$(tr '[:upper:]' '[:lower:]' <<<"$b") ;; esac
            for hw in ssh slogin scp sftp rsync autossh sshpass ssh-copy-id ssh-agent ssh-keyscan sshfs mosh; do
              # shellcheck disable=SC2053  # $b is the glob, on purpose
              if [[ $hw == $b ]]; then deny "$orig" "a command word whose glob matches $hw; name the program (docs/DEV_SETUP.md §17)"; fi
            done ;;
        esac ;;
    esac
  fi
  # zsh's glob qualifiers run code from inside a reader's arguments (ls *(e:'…':), *(+fn)); quoted text is not a glob
  case "$uq" in
    *'(e:'*|*'(+'*) deny "$orig" "a zsh glob qualifier runs code from a glob (docs/DEV_SETUP.md §17)" ;;
  esac
  case "$seg" in                                    # a quote right after the e opens the qualifier's code
    *"(e'"*|*'(e"'*) deny "$orig" "a zsh glob qualifier runs code from a glob (docs/DEV_SETUP.md §17)" ;;
  esac
  # a shell or interpreter inside $(…), <(…) or >(…), in a command that names a host word (… | tee >(bash))
  if [ "$sep" = "subst" ]; then
    case "$nh" in
      bash|sh|zsh|dash|ksh|csh|tcsh|fish|eval|source|.|python|python3|perl|ruby|node|awk|osascript)
        if mentions_host "$raw"; then
          deny "$orig" "a shell or interpreter inside a substitution, in a command that names a host command (docs/DEV_SETUP.md §17)"
        fi ;;
    esac
  fi
  # after a command that names a host word, the rest of its pipeline may only read; a heredoc's or here-string's
  # lines are read by its command, out of the ask rule's sight, unless that command only reads them
  if [ "$sep" = "pipe" ] && [ "$pipeline_host" = 1 ]; then
    case "$nh" in
      grep|egrep|fgrep|rg|head|tail|cut|sort|uniq|wc|tr|column|cat|less|more|jq|nl|fold|diff|cmp|shasum|sha256sum|md5|tee|od|xxd|hexdump|strings) ;;
      *) deny "$orig" "a command fed by a pipe that names a host command, and not one that only reads it; run the host command bare (docs/DEV_SETUP.md §17)" ;;
    esac
  fi
  case "$seg" in
    *'<<'*) if ! inert_mention "$nh" "$s" && mentions_host "$raw"; then
        deny "$orig" "a heredoc or here-string fed to a command that runs it, in a command that names a host command; run the host command bare (docs/DEV_SETUP.md §17)"
      fi ;;
  esac
  if mentions_host "$seg"; then
    pipeline_host=1
    if ! inert_mention "$nh" "$s" && ! grep -qE '^command[[:space:]]+-[vV]([[:space:]]|$)' <<<"$s0"; then
      deny "$orig" "this names a host command but does not run one bare (ssh, scp, sftp or rsync, lower case and unquoted, the first word of its own command), so its ask rule might not see it (docs/DEV_SETUP.md §17)"
    fi
  fi
  case "$orig" in
    *RSYNC_RSH*|*RSYNC_CONNECT_PROG*|*GIT_SSH*)
      if ! inert_mention "$nh" "$s"; then
        deny "$orig" "it names the variable rsync or git reaches a host through; only the qt alias's own ssh is used (docs/DEV_SETUP.md §17)"
      fi ;;
  esac
  if [ "$nh" = git ]; then
    if grep -qiE "(^|[[:space:]])-c[[:space:]]*[^[:space:]]*(sshcommand|insteadof|receive-?pack|upload-?pack|\.url=|pushurl)" <<<"$(tr -d "\"'\\\\" <<<"$s")"; then
      deny "$orig" "git told to reach a host through another ssh command or a rewritten URL (docs/DEV_SETUP.md §17)"
    fi
    gq=$(git_words "$s")
    gsub=$(awk '{print $2}' <<<"$gq")
    case "$gsub" in
      commit|log|show|diff|blame|status|add) ;;
      *)
        if grep -qiE "sshcommand|receive-?pack|upload-?pack|insteadof" <<<"$gq" \
           || { [[ $gsub =~ ^(push|fetch|pull|clone|ls-remote|archive)$ ]] && grep -qE "(^|[[:space:]])--exec(=|[[:space:]]|$)" <<<"$gq"; }; then
          deny "$orig" "git told to run another program on the far side, through another ssh, or to rewrite a URL (docs/DEV_SETUP.md §17)"
        fi
        # an ssh remote anywhere: user@host:, ssh://; and host:path wherever no refspec can stand (not push,
        # fetch or pull, whose src:dst refspecs look the same; there only the repository position is read)
        for tok in $gq; do
          case "$tok" in
            *://*) case "$tok" in https://*|http://*|--*=https://*|--*=http://*) ;; *) deny "$orig" "git reaching $tok, not an https URL (docs/DEV_SETUP.md §17)" ;; esac ;;
            *@*:*) deny "$orig" "git reaching $tok, an ssh remote (docs/DEV_SETUP.md §17)" ;;
          esac
        done
        case "$gsub" in
          push|fetch|pull)
            repo=$(awk '{for (i = 3; i <= NF; i++) if (substr($i, 1, 1) != "-") { print $i; exit }}' <<<"$gq")
            case "$repo" in *://*) ;; [!/]*:*) deny "$orig" "git reaching $repo, an ssh remote (docs/DEV_SETUP.md §17)" ;; esac ;;
          clone|ls-remote|remote|config|submodule|archive)
            for tok in $gq; do
              case "$tok" in -*|*://*) ;; [!/]*:*) deny "$orig" "git reaching $tok, an ssh remote (docs/DEV_SETUP.md §17)" ;; esac
            done ;;
        esac ;;
    esac
  fi
  # ~/.ssh decides where qt goes: a command naming it must only read it (a write list misses dd, curl -o, tar -C, cd)
  case "$sq" in
    *.[sS][sS][hH]*)
      if grep -qiE "(^|[[:space:]/=\"'])\.ssh([/[:space:]\"']|$)" <<<"$seg"; then
        case "$nh" in
          ls|cat|grep|egrep|fgrep|head|tail|stat|file|wc|test|'['|diff|cmp) ;;
          ssh-keygen) grep -qE '(^|[[:space:]])-[A-Za-z]*[lF]' <<<"$s" \
              || deny "$orig" "ssh-keygen writing under ~/.ssh; only -l and -F read (docs/DEV_SETUP.md §17)" ;;
          rm) grep -qE '^rm([[:space:]]+-f)?[[:space:]]+(~|\$HOME)/\.ssh/qt-make-[^[:space:]]*$' <<<"$s" \
              || deny "$orig" "a write under ~/.ssh, which decides where the qt alias goes; the operator edits it (docs/DEV_SETUP.md §17)" ;;
          *) deny "$orig" "a command naming ~/.ssh that is not a reader; ~/.ssh decides where the qt alias goes, and the operator edits it (docs/DEV_SETUP.md §17)" ;;
        esac
      fi ;;
  esac
  # .git/config holds the remotes' URLs and the programs git runs on them
  case "$sq" in
    *.git/config*) if writes_to '\.git/config([[:space:]"'"'"']|$)' "$lower" "$uq_lower"; then
        deny "$orig" "a shell write to .git/config, where a remote's URL or program is set (docs/DEV_SETUP.md §17)"
      fi ;;
  esac
done <<<"$raw"

if [ "$mirror_named" = "1" ] && [ -n "$runner_seen" ]; then
  deny "$runner_seen" "enable-broker-mirror.ts sets live_trading_enabled=true with the service role and writes no ledger row, and it runs on import, so it is refused from a session until MODERNISATION P19 lands (DEBT D-33). Reading it is fine; if you only mention it, keep that apart from any command that runs code"
fi
if [ -n "$destructive_elsewhere" ] && [ "$any_protected" = "1" ]; then
  deny "$destructive_elsewhere" "a destructive command takes its paths from another command or a variable while this command line names pinned data, golden inputs or live-runner paths"
fi
exit 0
