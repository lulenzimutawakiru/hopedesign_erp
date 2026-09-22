#!/usr/bin/env bash
# Silent-failure tripwire for the ERP stack.
#
# Two jobs:
#   1. Liveness - prove the scheduler and the scheduled work are still alive.
#      A cron that stopped firing looks exactly like "everything is fine"
#      unless something asserts otherwise. That is how a 34h backup gap went
#      unnoticed on 2026-09-19.
#   2. Tripwire - scan NEW lines of the ops logs for CRITICAL/ERROR/WARN and
#      mail them. Any script that fails loudly in its log now also fails loudly
#      in your inbox, without having to edit that script.
#
# Runs every 10 minutes. Alerts are throttled per-issue by alert.sh, so a
# persistent problem mails once an hour rather than every 10 minutes.
#
# First sight of a log file only records a baseline offset and stays silent:
# alerting on months of historical lines would be a mail bomb. Likewise there
# is a hard per-cycle cap, so a log that suddenly goes mad cannot flood you.
set -uo pipefail

APP_DIR="/opt/hopedesign_erp"
LOG_DIR="$APP_DIR/logs"
SELF_LOG="$LOG_DIR/alert-tripwire.log"
STATE_DIR="$LOG_DIR/alert-state"
ALERT="$APP_DIR/deploy/alert.sh"

mkdir -p "$STATE_DIR"

HEARTBEAT_MAX_MINUTES="${HEARTBEAT_MAX_MINUTES:-90}"   # catchup cron runs every 30m
DRTEST_MAX_HOURS="${DRTEST_MAX_HOURS:-30}"             # dr-test cron runs daily 03:30
MAX_ALERTS_PER_CYCLE="${MAX_ALERTS_PER_CYCLE:-10}"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" >> "$SELF_LOG"; }

# Fingerprint the *condition*, not the log line.
#
# A raw line carries a timestamp, a byte count, a duration and sometimes a
# date-stamped file name, so one recurring failure produced a different
# dedupe key on every cycle - and every new key is a new email. On
# 2026-09-22 the self-recovering offsite-sync warning alone minted 6 fresh
# keys inside a single cycle. Stripping the volatile tokens collapses every
# repetition of one problem onto one key, so alert.sh's own throttle takes
# over instead of the tripwire inventing a brand-new alert each time.
normalize() {
  printf '%s' "$1" \
    | sed -E \
        -e 's/\[[0-9]{4}-[0-9]{2}-[0-9]{2}[^]]*\]//g' \
        -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}([T_][0-9:.-]+)?/<ts>/g' \
        -e 's/[0-9]+(\.[0-9]+)?(ms|s|m|h|d|B|KB|MB|GB)\b/<n>\2/g' \
        -e 's/[0-9]+/<n>/g' \
    | tr -s ' '
}

notify() { # severity key subject body
  "$ALERT" send "$1" "$2" "$3" "$4" >/dev/null 2>&1 || log "alert.sh failed for key=$2"
}
resolve() { # key - condition gone
  "$ALERT" clear "$1" >/dev/null 2>&1 || true
}

fail=0

# ---------- 1. Liveness ----------
if systemctl is-active --quiet cron 2>/dev/null; then
  resolve cron-inactive
else
  notify CRITICAL cron-inactive "cron is not running" \
    "The cron daemon on $(hostname) is not active. Every scheduled job - nightly backups, the 30-minute backup catch-up, the watchdog, the DR test - has stopped, and nothing is self-healing until this is restored."
  fail=1
fi

HB_FILE="$LOG_DIR/cron_backup_catchup.log"
if [ -f "$HB_FILE" ]; then
  hb_last="$(grep 'heartbeat' "$HB_FILE" 2>/dev/null | tail -n 1 | sed -n "s/^\[\([^]]*\)\].*/\1/p")"
  if [ -n "$hb_last" ]; then
    hb_epoch="$(date -u -d "$hb_last" +%s 2>/dev/null || echo 0)"
    if [ "$hb_epoch" -gt 0 ]; then
      hb_age_min=$(( ( $(date +%s) - hb_epoch ) / 60 ))
      if [ "$hb_age_min" -gt "$HEARTBEAT_MAX_MINUTES" ]; then
        notify CRITICAL backup-heartbeat-stale "backup catch-up has not run in ${hb_age_min}m" \
          "The backup catch-up job writes a heartbeat every 30 minutes and the newest one is ${hb_age_min} minutes old (limit ${HEARTBEAT_MAX_MINUTES}m). The safety net that covers a missed nightly backup is itself not running. Last heartbeat: $hb_last"
        fail=1
      else
        resolve backup-heartbeat-stale
      fi
    fi
  else
    notify WARN backup-heartbeat-missing "no backup heartbeat found" \
      "Could not find any heartbeat line in $HB_FILE, so the backup catch-up job may never have completed a cycle."
    fail=1
  fi
else
  notify CRITICAL backup-heartbeat-missing "backup catch-up log is missing" \
    "$HB_FILE does not exist, so the backup safety net is not running."
  fail=1
fi

DR_FILE="$LOG_DIR/dr-test.log"
if [ -f "$DR_FILE" ]; then
  dr_age_h=$(( ( $(date +%s) - $(stat -c %Y "$DR_FILE") ) / 3600 ))
  if [ "$dr_age_h" -gt "$DRTEST_MAX_HOURS" ]; then
    notify WARN dr-test-stale "disaster-recovery test has not run in ${dr_age_h}h" \
      "The restore test writes to $DR_FILE and it is ${dr_age_h}h old (limit ${DRTEST_MAX_HOURS}h). Backups are not currently being proven restorable."
    fail=1
  else
    resolve dr-test-stale
  fi
else
  notify WARN dr-test-missing "disaster-recovery test log is missing" \
    "$DR_FILE does not exist, so backups are not being proven restorable."
  fail=1
fi

# ---------- 2. Tripwire ----------
alerts_sent=0

scan_log() { # $1 = absolute path
  local file="$1" name offset_file offset size line hash key
  [ -f "$file" ] || return 0
  name="$(printf '%s' "$file" | tr -c 'A-Za-z0-9._-' '_')"
  offset_file="$STATE_DIR/offset-$name"
  size="$(stat -c %s "$file" 2>/dev/null || echo 0)"

  if [ ! -f "$offset_file" ]; then
    printf '%s' "$size" > "$offset_file"
    log "baselined $(basename "$file") at byte $size (no historical alerts)"
    return 0
  fi

  offset="$(cat "$offset_file" 2>/dev/null || echo 0)"
  case "$offset" in ''|*[!0-9]*) offset=0 ;; esac

  # Log rotated/truncated - rebaseline silently.
  if [ "$offset" -gt "$size" ]; then
    printf '%s' "$size" > "$offset_file"
    log "rebaselined $(basename "$file") after rotation (size $size)"
    return 0
  fi

  if [ "$size" -gt "$offset" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in
        *CRITICAL*|*ERROR*|*FAILED*|*WARN*|*critical*|*error*|*failed*|*warn*)
          if [ "$alerts_sent" -ge "$MAX_ALERTS_PER_CYCLE" ]; then
            log "suppressed further alerts from $(basename "$file") (cycle cap $MAX_ALERTS_PER_CYCLE reached)"
            break
          fi
          hash="$(normalize "$file$line" | md5sum | cut -c1-12)"
          case "$line" in
            *CRITICAL*|*critical*|*ERROR*|*error*|*FAILED*|*failed*) severity=CRITICAL ;;
            *) severity=WARN ;;
          esac
          notify "$severity" "log-$hash" "log alert in $(basename "$file")" \
"$(basename "$file") reported a problem on $(hostname).

$line

Full log: $file"
          alerts_sent=$(( alerts_sent + 1 ))
          ;;
      esac
    done < <(tail -c +"$((offset + 1))" "$file" 2>/dev/null)
  fi
  printf '%s' "$size" > "$offset_file"
}

# alerts.log is deliberately EXCLUDED here. alert.sh appends "SENT severity=..."
# lines to it, and those match the WARN/CRITICAL patterns below - scanning it
# makes the tripwire alert on itself, every single cycle, forever.
for f in "$LOG_DIR/cron_backup_catchup.log" \
         "$LOG_DIR/watchdog.log" \
         "$LOG_DIR/dr-test.log" \
         "$LOG_DIR/offsite-sync.log" \
         "$LOG_DIR/cron_watchdog.log"; do
  scan_log "$f"
done

log "cycle complete liveness_failures=$fail tripwire_alerts=$alerts_sent"
exit 0
