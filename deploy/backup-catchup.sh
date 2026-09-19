#!/usr/bin/env bash
# Safety net for the nightly backup.
#
# The 02:00 cron does nothing at all if the host is down at that moment, and
# nothing tells anyone afterwards. That is exactly what happened on
# 2026-09-19: the box was offline overnight, the run was skipped, and there was
# no database dump for ~34 hours until it was noticed by hand.
#
# This runs at boot and every 30 minutes. It fills the gap if the newest dump
# is stale, refreshes stale storage archives, and always pushes a second copy
# off this host.
#
# Every cycle writes a heartbeat line, so "the cron stopped firing" can never
# again look the same as "everything is fine".
set -euo pipefail

BACKUP_DIR="/opt/hopedesign_erp/backups"
LOG_DIR="/opt/hopedesign_erp/logs"
LOG_FILE="$LOG_DIR/cron_backup_catchup.log"
DEPLOY_DIR="/opt/hopedesign_erp/deploy"
POSTGRES_CONTAINER="hopedesign-erp-postgres-1"

MAX_DB_AGE_HOURS=20
MAX_STORAGE_AGE_HOURS=30
LOG_MAX_LINES=2000

mkdir -p "$LOG_DIR"

# Writes only to the log file (never stdout) so the cron redirect and this
# function cannot produce duplicate lines in the same file.
log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"
}

# Keep the log from growing without bound; the weekly logs-cleanup cron does
# not know about this file.
trim_log() {
  local lines
  lines="$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)"
  if (( lines > LOG_MAX_LINES )); then
    tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "$LOG_FILE.tmp"
    mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
}

age_hours() {
  local file="$1" mtime
  mtime="$(stat -c %Y "$file" 2>/dev/null || echo 0)"
  echo $(( ($(date +%s) - mtime) / 3600 ))
}

DB_ACTION="fresh"
STORAGE_ACTION="fresh"
SYNC_STATUS="ok"

# A backup attempt during boot storm would just fail noisily. Wait for the next
# cycle instead of reporting a false alarm.
if ! docker inspect -f '{{.State.Health.Status}}' "$POSTGRES_CONTAINER" 2>/dev/null | grep -q healthy; then
  log "Postgres is not healthy yet; deferring to the next cycle."
  trim_log
  exit 0
fi

NEWEST="$(ls -t "$BACKUP_DIR"/cron_db_*.sql.gz 2>/dev/null | head -n 1 || true)"

if [[ -n "$NEWEST" ]]; then
  AGE="$(age_hours "$NEWEST")"
  if (( AGE >= MAX_DB_AGE_HOURS )); then
    log "Newest dump $(basename "$NEWEST") is ${AGE}h old (limit ${MAX_DB_AGE_HOURS}h); running an out-of-schedule backup."
    DB_ACTION="stale-${AGE}h"
  fi
else
  log "No database dump found at all; running a backup."
  DB_ACTION="missing"
fi

if [[ "$DB_ACTION" != "fresh" ]]; then
  if "$DEPLOY_DIR/postgres-backup.sh" >>"$LOG_FILE" 2>&1; then
    log "Catch-up database backup succeeded."
    DB_ACTION="recovered"
  else
    log "ERROR: catch-up database backup failed; see $LOG_FILE and $LOG_DIR/pg_backup_last.err"
    DB_ACTION="failed"
  fi
fi

NEWEST_STORAGE="$(ls -t "$BACKUP_DIR"/storage_backup_*.tar.gz 2>/dev/null | head -n 1 || true)"
if [[ -n "$NEWEST_STORAGE" ]]; then
  AGE="$(age_hours "$NEWEST_STORAGE")"
  if (( AGE >= MAX_STORAGE_AGE_HOURS )); then
    log "Newest storage archive is ${AGE}h old (limit ${MAX_STORAGE_AGE_HOURS}h); refreshing."
    STORAGE_ACTION="stale-${AGE}h"
  fi
else
  log "No storage archive found at all; creating one."
  STORAGE_ACTION="missing"
fi

if [[ "$STORAGE_ACTION" != "fresh" ]]; then
  if "$DEPLOY_DIR/storage-backup.sh" >>"$LOG_FILE" 2>&1; then
    STORAGE_ACTION="refreshed"
  else
    log "WARN: storage backup failed"
    STORAGE_ACTION="failed"
  fi
fi

# Always leave a second copy off this host. This also self-heals a missed or
# failed sync without needing anyone to notice.
if ! "$DEPLOY_DIR/offsite-backup-sync.sh" >>"$LOG_FILE" 2>&1; then
  log "WARN: offsite sync FAILED; backups are single-copy until it succeeds."
  SYNC_STATUS="FAILED"
fi

log "heartbeat db=${DB_ACTION} storage=${STORAGE_ACTION} offsite=${SYNC_STATUS}"
trim_log

if [[ "$SYNC_STATUS" != "ok" ]]; then
  exit 1
fi
exit 0
