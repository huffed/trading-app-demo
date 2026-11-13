#!/usr/bin/env bash
# notify-ntfy.sh — pushes "Claude needs you" to the operator's phone through ntfy, so a session waiting on
# them is visible away from the screen. settings.json runs it on two events:
# - Notification, for the types its matcher lists: a permission prompt left about 6 s, an idle wait of about
#   60 s, a background session's or a dialog's question. Claude Code never sends the idle wait while a
#   background agent runs. The permission prompt, idle wait and background session send Claude Code's
#   message, as the operator asked; a dialog sends fixed text, because its text can come from an MCP server.
# - Stop, at the end of every turn: it pushes only when the turn's last text (after its last tool call) has
#   a line reading BLOCKED ON YOU (CLAUDE.md) with numbered questions under it, with the number of
#   questions and never their text, once per set of questions in a session, also while background agents
#   run. A BLOCKED ON YOU line with no numbered question it can read is said in the session, not dropped.
#
# The ntfy topic is read from a file outside the repo (QT_NTFY_TOPIC_FILE, default
# ~/.config/quanttrader/ntfy-topic, one line), and the access token a reserved topic needs from an
# optional second one (QT_NTFY_TOKEN_FILE, default ~/.config/quanttrader/ntfy-token). Neither appears
# in argv, output or the log: curl reads the URL and the Authorization header from stdin, and -q stops
# it reading a ~/.curlrc. The session name is the latest custom-title (/rename), else the latest
# ai-title, in the transcript's last 8 MB, else the folder name and the session id's first 8 characters.
#
# It never blocks or fails the session: every path exits 0, and curl gives up after 6 s. Each push it tries
# writes one line to ~/.local/state/quanttrader/notify.log (QT_NOTIFY_LOG). Claude Code discards a
# Notification hook's systemMessage (hooks reference, read 2026-11-13); on Stop, a push that did not go
# out also prints one, which the operator sees. It needs jq, and says so when jq is missing.
set -uo pipefail
TOPIC_FILE=${QT_NTFY_TOPIC_FILE:-$HOME/.config/quanttrader/ntfy-topic}
TOKEN_FILE=${QT_NTFY_TOKEN_FILE:-$HOME/.config/quanttrader/ntfy-token}
LOG=${QT_NOTIFY_LOG:-$HOME/.local/state/quanttrader/notify.log}
SERVER=https://ntfy.sh
TITLE_SCAN_BYTES=8000000

input=$(cat)
field() { printf '%s' "$input" | jq -r --arg k "$1" '.[$k] // empty | tostring' 2> /dev/null; }
event=$(field hook_event_name)
type=$(field notification_type)
message=$(field message)
transcript=$(field transcript_path)
cwd=$(field cwd)
sid=$(field session_id)
name=""

log() {
  mkdir -p "$(dirname "$LOG")" 2> /dev/null || return 0
  printf '%s %s [%s] %s\n' "$(date -u +%FT%TZ)" "${type:-unknown}" "$name" "$1" >> "$LOG" 2> /dev/null || true
}

# A push that did not go out: one log line that never holds the topic or the token, and on Stop the same
# text in the session.
not_sent() {
  log "$1"
  [ "$event" = Stop ] && jq -cn --arg m "Phone push for BLOCKED ON YOU: $1" '{systemMessage: $m}' 2> /dev/null
  exit 0
}

command -v jq > /dev/null 2>&1 || {
  log "not sent: jq not found"
  printf '%s\n' '{"systemMessage":"Phone push: not sent, jq not found"}'
  exit 0
}

# Unreadable input, or another event, cannot say which push it is: sending one at every turn end would be noise.
case "$event" in
  Notification | Stop) ;;
  *) not_sent "not sent: the hook input is not a Notification or Stop event${event:+ ($event)}" ;;
esac

if [ "$event" = Stop ]; then
  # The questions are the numbered lines ("1. ", "**1. **", "1) ") at the start of a line after a line that
  # reads BLOCKED ON YOU, with any heading or bold marks, up to the next heading ("# " to "###### "),
  # READY TO MERGE or Next action line. Fenced code (``` or ~~~ on a line of its own) is skipped, so an
  # example pushes nothing. A line that starts with the heading but yields no question is a format the hook
  # cannot read, and is said rather than dropped.
  parsed=$(field last_assistant_message | awk '
    /^[[:space:]]*(```|~~~)[A-Za-z0-9_+-]*[[:space:]]*$/ { fence = !fence; next }
    fence { next }
    /^[#*_[:space:]]*BLOCKED ON YOU/ { seen = 1 }
    /^[#*_[:space:]]*BLOCKED ON YOU[*_:[:space:]]*$/ { on = 1; next }
    on && /^(#+[[:space:]]|[*_]*Next action|[#*_[:space:]]*READY TO MERGE)/ { on = 0 }
    on && /^[*_]*[0-9]+[.)][*_]* / { print "Q " $0 }
    END { if (seen) print "SEEN" }')
  [ -n "$parsed" ] || exit 0
  questions_text=$(printf '%s\n' "$parsed" | sed -n 's/^Q //p')
  questions=$(printf '%s' "$questions_text" | grep -c . || true)
  # once per set of questions, by the numbered lines alone: a later turn that repeats them, with other words
  # around them, does not push again
  mark_file="$(dirname "$LOG")/blocked-${sid:0:8}"
  digest=$(printf '%s' "$questions_text" | cksum | tr -d ' ')
  [ "$questions" != 0 ] && [ "$(cat "$mark_file" 2> /dev/null)" = "$digest" ] && exit 0
  type=blocked_on_you
  message="BLOCKED ON YOU: $questions question(s)"
fi

if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  titles=$(tail -c "$TITLE_SCAN_BYTES" "$transcript" 2> /dev/null | grep -E '"type":"(custom-title|ai-title)"' 2> /dev/null)
  name=$(printf '%s\n' "$titles" | grep -F '"type":"custom-title"' | tail -n 1 | jq -r '.customTitle // empty' 2> /dev/null)
  [ -n "$name" ] || name=$(printf '%s\n' "$titles" | tail -n 1 | jq -r '.aiTitle // empty' 2> /dev/null)
fi
[ -n "$name" ] || name="$(basename "${cwd:-$PWD}") ${sid:0:8}"
# an AI title is generated from the conversation, so it is cut short and stripped of control characters
name=$(printf '%s' "$name" | tr -d '\000-\037\177' | cut -c1-60)
[ "$type" != blocked_on_you ] || [ "$questions" != 0 ] \
  || not_sent "not sent: a BLOCKED ON YOU line with no numbered question (1. at the start of a line) under it"

# The first line of a file, with surrounding spaces and a CR removed; empty if it is unreadable.
first_line() {
  local v=""
  [ -r "$1" ] && v=$(head -n 1 "$1" 2> /dev/null | tr -d '\r')
  v=${v#"${v%%[![:space:]]*}"}
  v=${v%"${v##*[![:space:]]}"}
  printf '%s' "$v"
}

case "$type" in
  permission_prompt) title="Claude: permission needed" priority=high ;;
  idle_prompt) title="Claude: waiting for you" priority=default ;;
  elicitation_dialog | elicitation_url_dialog) title="Claude: question for you" priority=high message="A dialog in the session asks you something" ;;
  agent_needs_input) title="Claude: a background session needs you" priority=high ;;
  blocked_on_you) title="Claude: questions for you" priority=high ;;
  *) not_sent "not sent: notification type ${type:-none} is not one this hook sends" ;;
esac

topic=$(first_line "$TOPIC_FILE")
[ -n "$topic" ] || not_sent "not sent: no topic in $TOPIC_FILE"
[[ $topic =~ ^[A-Za-z0-9_-]{1,64}$ ]] \
  || not_sent "not sent: the topic file's first line is not a plain ntfy topic (letters, digits, - and _)"
token=$(first_line "$TOKEN_FILE")
[ -z "$token" ] || [[ $token =~ ^tk_[A-Za-z0-9]{1,64}$ ]] \
  || not_sent "not sent: the token file's first line is not an ntfy access token (tk_ then letters and digits)"

config=$(printf 'url = "%s/%s"' "$SERVER" "$topic")
[ -z "$token" ] || config+=$(printf '\nheader = "Authorization: Bearer %s"' "$token")
body=$(printf '%s\n%s' "$name" "${message:-(no message)}")
code=$(printf '%s\n' "$config" \
  | curl -q -fsS --connect-timeout 3 --max-time 6 --config - -H "Title: $title" -H "Priority: $priority" -H "Tags: bell" \
    --data-raw "$body" -o /dev/null -w '%{http_code}' 2> /dev/null)
rc=$?
[[ $code =~ ^[0-9]{3}$ ]] || code=none
if [ "$rc" -eq 0 ]; then
  log "sent"
  [ "$event" = Stop ] && printf '%s' "$digest" > "$mark_file" 2> /dev/null
  exit 0
fi
hint=""
if [ -z "$token" ] && [[ $code == 401 || $code == 403 ]]; then
  hint="; a reserved topic needs the token file $TOKEN_FILE"
fi
not_sent "push FAILED (curl exit $rc, HTTP $code)$hint"
