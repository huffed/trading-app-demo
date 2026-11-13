#!/usr/bin/env bash
# notify-ntfy.sh — Notification hook: pushes "Claude needs you" to the operator's phone through ntfy,
# so a session blocked on a permission prompt or waiting for an answer is visible away from the
# screen. settings.json runs it for the notification types it lists in its matcher.
#
# The ntfy topic is read from a file outside the repo (QT_NTFY_TOPIC_FILE, default
# ~/.config/quanttrader/ntfy-topic, one line); it never appears in argv, output or the log, and curl
# reads the URL from stdin. The session name is the transcript's latest custom-title (/rename), else
# its latest ai-title, else the folder name and the session id's first 8 characters.
#
# It never blocks or fails the session: every path exits 0 and writes one line to
# ~/.local/state/quanttrader/notify.log (QT_NOTIFY_LOG), which says whether the push went out.
set -uo pipefail
TOPIC_FILE=${QT_NTFY_TOPIC_FILE:-$HOME/.config/quanttrader/ntfy-topic}
LOG=${QT_NOTIFY_LOG:-$HOME/.local/state/quanttrader/notify.log}
SERVER=https://ntfy.sh

input=$(cat)
field() { printf '%s' "$input" | jq -r --arg k "$1" '.[$k] // empty | tostring' 2> /dev/null; }
type=$(field notification_type)
message=$(field message)
transcript=$(field transcript_path)
cwd=$(field cwd)
sid=$(field session_id)

name=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  titles=$(grep -E '"type":"(custom-title|ai-title)"' "$transcript" 2> /dev/null)
  name=$(printf '%s\n' "$titles" | grep -F '"type":"custom-title"' | tail -n 1 | jq -r '.customTitle // empty' 2> /dev/null)
  [ -n "$name" ] || name=$(printf '%s\n' "$titles" | tail -n 1 | jq -r '.aiTitle // empty' 2> /dev/null)
fi
[ -n "$name" ] || name="$(basename "${cwd:-$PWD}") ${sid:0:8}"

log() {
  mkdir -p "$(dirname "$LOG")" 2> /dev/null || return 0
  printf '%s %s [%s] %s\n' "$(date -u +%FT%TZ)" "${type:-unknown}" "$name" "$1" >> "$LOG" 2> /dev/null || true
}

case "$type" in
  permission_prompt) title="Claude: permission needed" priority=high ;;
  idle_prompt) title="Claude: waiting for you" priority=default ;;
  elicitation_dialog | elicitation_url_dialog) title="Claude: question for you" priority=high ;;
  agent_needs_input) title="Claude: a background session needs you" priority=high ;;
  *) title="Claude: ${type:-notification}" priority=default ;;
esac

topic=""
[ -r "$TOPIC_FILE" ] && topic=$(head -n 1 "$TOPIC_FILE" 2> /dev/null | tr -d '\r')
topic=${topic#"${topic%%[![:space:]]*}"}
topic=${topic%"${topic##*[![:space:]]}"}
if [ -z "$topic" ]; then
  log "not sent: no topic in $TOPIC_FILE"
  exit 0
fi
if ! [[ $topic =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
  log "not sent: the topic file's first line is not a plain ntfy topic (letters, digits, - and _)"
  exit 0
fi

body=$(printf '%s\n%s' "$name" "${message:-(no message)}")
if printf 'url = "%s/%s"\n' "$SERVER" "$topic" \
  | curl -fsS --max-time 10 --config - -H "Title: $title" -H "Priority: $priority" -H "Tags: bell" \
    --data-binary "$body" -o /dev/null 2> /dev/null; then
  log "sent"
else
  log "push FAILED (curl exit $?)"
fi
exit 0
