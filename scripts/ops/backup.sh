#!/usr/bin/env bash
# scripts/ops/backup.sh — nightly backup to the Hetzner Storage Box (D.6, decision 0011). Runs as ops
# from the crontab, from /usr/local/lib/quanttrader/ so a rollback of the checkout cannot remove it.
#
# Everything leaves the host encrypted with the age public key in backup-age-recipient.txt; the private
# key is the operator's and is never on the host or the box. One directory per night under nightly/:
#   db-public.dump.age   pg_dump -Fc of schema public, data included
#   db-auth.dump.age     auth.users and auth.identities, data only (15 public tables reference them)
#   env.tar.age          the host's .env.local
#   host.tar.age         the unit files, logrotate, sshd drop-in, the installed scripts, the crontab
#   logs.tar.age         /var/log/quanttrader
# The pinned corpora (public, already in git) go to pins/ unencrypted. Each part is attempted even if
# another failed. Nights older than 30 days are pruned only after a night that fully succeeded and
# was verified by a checksum pass, so a broken backup cannot eat the good ones. Failure: one urgent
# ntfy push and exit 1. Success: quiet, and backup.last-ok, which the daily summary checks.
# Secrets are read here and passed through the environment, never argv, and are never printed.
set -uo pipefail
umask 077

APP=/opt/quanttrader
LOGDIR=/var/log/quanttrader
STATE=/var/lib/quanttrader
LIB=/usr/local/lib/quanttrader
ENV_FILE=$APP/.env.local
RECIPIENT=$LIB/backup-age-recipient.txt
BOX=u708205-sub1@u708205-sub1.your-storagebox.de
RETENTION_DAYS=30
HOST_FILES=(
  etc/systemd/system/quanttrader.service
  etc/systemd/system/quanttrader-tailnet.socket
  etc/systemd/system/quanttrader-tailnet.service
  etc/logrotate.d/quanttrader
  etc/ssh/sshd_config.d/10-hardening.conf
  usr/local/lib/quanttrader
)
SSH_OPTS=(-p 23 -i "$HOME/.ssh/quanttrader_backup" -o BatchMode=yes -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$HOME/.ssh/known_hosts_storagebox" -o ConnectTimeout=20)
RSH="ssh ${SSH_OPTS[*]}"
DAY=$(date -u +%F)
errors=()

log() { printf '[%s] backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }
envval() { grep -E "^$1=" "$ENV_FILE" 2> /dev/null | head -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true; }
box() { ssh "${SSH_OPTS[@]}" "$BOX" "$@"; }
encrypt() { age -R "$RECIPIENT" -o "$1"; }
step() { # $1 name, then the command: a failure is recorded, and the next part still runs
  local name=$1
  shift
  if "$@"; then log "$name ok"; else errors+=("$name"); log "$name FAILED"; fi
}

db_env() { # BACKUP_DATABASE_URL → libpq's environment, so the password is never on a command line
  local url parts
  url=$(envval BACKUP_DATABASE_URL)
  [ -n "$url" ] || return 1
  parts=$(python3 -c 'import sys
from urllib.parse import urlsplit, unquote
u = urlsplit(sys.stdin.read().strip())
print("\t".join([u.hostname, str(u.port or 5432), unquote(u.username), unquote(u.password), u.path.lstrip("/") or "postgres"]))' <<< "$url" 2> /dev/null) || return 1
  IFS=$'\t' read -r PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE <<< "$parts"
  export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE=require
}
dump_public() {
  pg_dump --format=custom --no-owner --no-privileges --schema=public | encrypt "$OUT/db-public.dump.age" && [ -s "$OUT/db-public.dump.age" ]
}
dump_auth() { # a separate dump: pg_dump ignores --schema once --table is given
  pg_dump --format=custom --no-owner --no-privileges --data-only --table=auth.users --table=auth.identities \
    | encrypt "$OUT/db-auth.dump.age" && [ -s "$OUT/db-auth.dump.age" ]
}
archive_env() {
  tar -C "$APP" -cf - .env.local | encrypt "$OUT/env.tar.age" && [ -s "$OUT/env.tar.age" ]
}
archive_host() {
  crontab -l > "$WORK/crontab.txt" 2> /dev/null || return 1
  tar -cf - -C / "${HOST_FILES[@]}" -C "$WORK" crontab.txt | encrypt "$OUT/host.tar.age" && [ -s "$OUT/host.tar.age" ]
}
archive_logs() { # a copy first: the crons are appending, and tar exits non-zero on a file that changed
  cp -a "$LOGDIR" "$WORK/logs" && tar -C "$WORK" -czf - logs | encrypt "$OUT/logs.tar.age" && [ -s "$OUT/logs.tar.age" ]
}
upload_night() {
  rsync -a --partial -e "$RSH" "$OUT/" "$BOX:nightly/$DAY/"
}
verify_night() { # a checksum dry run that lists anything differing; only the files count
  local differs
  differs=$(rsync -anic -e "$RSH" "$OUT/" "$BOX:nightly/$DAY/") || return 1
  [ -z "$(grep -v '/$' <<< "$differs")" ]
}
upload_pins() {
  rsync -a --partial --include='*-pinned.json' --exclude='*' -e "$RSH" "$APP/scripts/canonical/data/" "$BOX:pins/"
}
prune_nights() {
  local cutoff night nights
  cutoff=$(python3 -c "import datetime as d; print(d.date.today() - d.timedelta(days=$RETENTION_DAYS))")
  nights=$(rsync --list-only -e "$RSH" "$BOX:nightly/") || return 1
  nights=$(awk '{print $NF}' <<< "$nights" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || true)
  for night in $nights; do
    if [[ "$night" < "$cutoff" ]]; then box rm -r "nightly/$night" || return 1; log "pruned $night"; fi
  done
}
push_failure() {
  local topic token
  topic=$(envval NTFY_TOPIC)
  token=$(envval NTFY_TOKEN)
  [ -n "$topic" ] || { log "NTFY_TOPIC unset; nothing sent"; return 0; }
  { [ -n "$token" ] && printf 'Authorization: Bearer %s\n' "$token" || printf 'X-Unused: 1\n'; } \
    | curl -fsS --max-time 15 -H @- -H "Title: quanttrader-prod backup FAILED" -H "Priority: urgent" -H "Tags: rotating_light" \
      -d "backup $DAY: ${errors[*]}" "https://ntfy.sh/$topic" > /dev/null || log "the failure push FAILED"
}

[ "$(id -un)" = ops ] || { echo "backup: run as ops; refusing as $(id -un)" >&2; exit 2; }
WORK=$(mktemp -d "$STATE/backup.XXXXXX") || { echo "backup: no working directory" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT
OUT=$WORK/out
mkdir "$OUT"

if db_env; then
  step db-public dump_public
  step db-auth dump_auth
else
  errors+=("database-url")
  log "BACKUP_DATABASE_URL missing or unreadable in $ENV_FILE"
fi
unset PGPASSWORD
step env archive_env
step host archive_host
step logs archive_logs
step upload upload_night
step verify verify_night
step pins upload_pins
[ ${#errors[@]} -ne 0 ] || step prune prune_nights

if [ ${#errors[@]} -eq 0 ]; then
  date -u +%FT%TZ > "$STATE/backup.last-ok"
  log "OK nightly/$DAY"
else
  log "FAILED: ${errors[*]}"
  push_failure
  exit 1
fi
