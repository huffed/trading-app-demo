#!/usr/bin/env bash
# notify-ntfy.sh — Notification hook: pushes "Claude needs you" to the operator's phone through ntfy,
# so a session blocked on a permission prompt or waiting for an answer is visible away from the
# screen. settings.json runs it for the notification types it lists in its matcher.
#
# The ntfy topic is read from a file outside the repo (QT_NTFY_TOPIC_FILE, default
# ~/.config/quanttrader/ntfy-topic, one line), and the access token a reserved topic needs from an
# optional second one (QT_NTFY_TOKEN_FILE, default ~/.config/quanttrader/ntfy-token). Neither appears
# in argv, output or the log: curl reads the URL and the Authorization header from stdin, and -q stops
# it reading a ~/.curlrc. The session name is the latest custom-title (/rename), else the latest
# ai-title, in the transcript's last 8 MB, else the folder name and the session id's first 8 characters.
#
# It never blocks or fails the session: every path exits 0 and writes one line to
# ~/.local/state/quanttrader/notify.log (QT_NOTIFY_LOG), which says whether the push went out. That
# line is the only record: Claude Code ignores a Notification hook's exit code and discards its
# systemMessage (hooks reference, read 2026-11-13), so a session reads the log before it ends a turn
# with BLOCKED ON YOU (CLAUDE.md).
set -uo pipefail
TOPIC_FILE=${QT_NTFY_TOPIC_FILE:-$HOME/.config/quanttrader/ntfy-topic}
TOKEN_FILE=${QT_NTFY_TOKEN_FILE:-$HOME/.config/quanttrader/ntfy-token}
LOG=${QT_NOTIFY_LOG:-$HOME/.local/state/quanttrader/notify.log}
SERVER=https://ntfy.sh
TITLE_SCAN_BYTES=8000000

input=$(cat)
field() { printf '%s' "$input" | jq -r --arg k "$1" '.[$k] // empty | tostring' 2> /dev/null; }
type=$(field notification_type)
message=$(field message)
transcript=$(field transcript_path)
cwd=$(field cwd)
sid=$(field session_id)

name=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  titles=$(tail -c "$TITLE_SCAN_BYTES" "$transcript" 2> /dev/null | grep -E '"type":"(custom-title|ai-title)"' 2> /dev/null)
  name=$(printf '%s\n' "$titles" | grep -F '"type":"custom-title"' | tail -n 1 | jq -r '.customTitle // empty' 2> /dev/null)
  [ -n "$name" ] || name=$(printf '%s\n' "$titles" | tail -n 1 | jq -r '.aiTitle // empty' 2> /dev/null)
fi
[ -n "$name" ] || name="$(basename "${cwd:-$PWD}") ${sid:0:8}"

log() {
  mkdir -p "$(dirname "$LOG")" 2> /dev/null || return 0
  printf '%s %s [%s] %s\n' "$(date -u +%FT%TZ)" "${type:-unknown}" "$name" "$1" >> "$LOG" 2> /dev/null || true
}

# A push that did not go out: one log line that never holds the topic or the token.
not_sent() {
  log "$1"
  exit 0
}

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
  elicitation_dialog | elicitation_url_dialog) title="Claude: question for you" priority=high ;;
  agent_needs_input) title="Claude: a background session needs you" priority=high ;;
  *) title="Claude: ${type:-notification}" priority=default ;;
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
  | curl -q -fsS --max-time 10 --config - -H "Title: $title" -H "Priority: $priority" -H "Tags: bell" \
    --data-raw "$body" -o /dev/null -w '%{http_code}' 2> /dev/null)
rc=$?
[[ $code =~ ^[0-9]{3}$ ]] || code=none
if [ "$rc" -eq 0 ]; then
  log "sent"
  exit 0
fi
hint=""
if [ -z "$token" ] && [[ $code == 401 || $code == 403 ]]; then
  hint="; a reserved topic needs the token file $TOKEN_FILE"
fi
not_sent "push FAILED (curl exit $rc, HTTP $code)$hint"
