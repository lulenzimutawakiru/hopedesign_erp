#!/usr/bin/env bash
# Host-level alert delivery for the ERP stack.
#
# Why this exists: Uptime Kuma is running with a monitor but NO notification
# channel configured, and every ops script only ever wrote to a log file. On
# 2026-09-19 the host was down overnight, the 02:00 backup was skipped, and
# nobody was told for ~34 hours. Nothing on this box could have told them.
#
# Usage:
#   alert.sh send <SEVERITY> <dedupe-key> <subject> [body]
#   alert.sh clear <dedupe-key>
#
# Sends through the Resend account the ERP already uses. Repeated alerts for the
# same dedupe key are throttled so a */2min watchdog cannot become a mail bomb;
# call `clear` when the condition goes away so the next occurrence is loud again
# immediately.
#
# Transport is curl, not python: Resend sits behind Cloudflare and rejects the
# default Python-urllib user agent with HTTP 403. Python is used only to build
# the JSON body so quoting/newlines can never corrupt the request.
set -uo pipefail

ENV_FILE="/opt/hopedesign_erp/.env.production"
LOG_DIR="/opt/hopedesign_erp/logs"
LOG_FILE="$LOG_DIR/alerts.log"
STATE_DIR="$LOG_DIR/alert-state"
THROTTLE_SECONDS="${ALERT_THROTTLE_SECONDS:-3600}"

mkdir -p "$LOG_DIR" "$STATE_DIR"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"; }

envget() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r'; }

action="${1:-}"; shift 2>/dev/null || true

if [ "$action" = "clear" ]; then
  key="${1:-}"
  [ -n "$key" ] && rm -f "$STATE_DIR/$(printf '%s' "$key" | tr -c 'A-Za-z0-9._-' '_')"
  log "cleared alert state for key=$key"
  exit 0
fi

if [ "$action" != "send" ]; then
  echo "usage: alert.sh send <SEVERITY> <key> <subject> [body]" >&2
  echo "       alert.sh clear <key>" >&2
  exit 2
fi

severity="${1:-WARN}"
key="${2:-generic}"
subject="${3:-HOPEDESIGN ERP alert}"
body="${4:-}"

api_key="$(envget RESEND_API_KEY)"
from_addr="$(envget RESEND_FROM_EMAIL)"
[ -n "$from_addr" ] || from_addr="$(envget NOTIFICATION_FROM_EMAIL)"
to_addr="$(envget ALERT_EMAIL)"
[ -n "$to_addr" ] || to_addr="$(envget ACME_EMAIL)"

if [ -z "$api_key" ] || [ -z "$from_addr" ] || [ -z "$to_addr" ]; then
  log "ERROR: missing mail config (key/from/to); cannot deliver alert key=$key subject=$subject"
  exit 1
fi

state_file="$STATE_DIR/$(printf '%s' "$key" | tr -c 'A-Za-z0-9._-' '_')"

if [ "${ALERT_FORCE:-0}" != "1" ] && [ -f "$state_file" ]; then
  sent_at="$(stat -c %Y "$state_file" 2>/dev/null || echo 0)"
  age=$(( $(date +%s) - sent_at ))
  if [ "$age" -lt "$THROTTLE_SECONDS" ]; then
    log "throttled (${age}s < ${THROTTLE_SECONDS}s) key=$key severity=$severity"
    exit 0
  fi
fi

payload_file="$(mktemp /tmp/hopedesign-alert.XXXXXX)"
chmod 600 "$payload_file"
export ALERT_PAYLOAD_FILE="$payload_file"
export ALERT_FROM="$from_addr"
export ALERT_TO="$to_addr"
export ALERT_SEV="$severity"
export ALERT_SUBJECT="$subject"
export ALERT_BODY="$body"
export ALERT_HOST="$(hostname)"

if ! python3 - <<'PYEOF'
import json, os
payload = {
    "from": os.environ["ALERT_FROM"],
    "to": [os.environ["ALERT_TO"]],
    "subject": "[%s] %s (%s)" % (os.environ["ALERT_SEV"], os.environ["ALERT_SUBJECT"], os.environ["ALERT_HOST"]),
    "text": os.environ.get("ALERT_BODY", ""),
}
with open(os.environ["ALERT_PAYLOAD_FILE"], "w") as fh:
    json.dump(payload, fh)
PYEOF
then
  rm -f "$payload_file"
  log "ERROR: could not build alert payload key=$key"
  exit 1
fi

response="$(curl -sS -m 25 -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $api_key" \
  -H 'Content-Type: application/json' \
  -w '\n%{http_code}' \
  --data-binary "@$payload_file" 2>&1)"
rm -f "$payload_file"

http_code="$(printf '%s' "$response" | tail -n 1)"
body_out="$(printf '%s' "$response" | sed '$d' | tr -d '\n')"

case "$http_code" in
  2*)
    touch "$state_file"
    log "SENT severity=$severity key=$key to=$to_addr subject=$subject"
    exit 0
    ;;
  *)
    log "ERROR: delivery failed http=$http_code key=$key subject=$subject resp=$body_out"
    exit 1
    ;;
esac
