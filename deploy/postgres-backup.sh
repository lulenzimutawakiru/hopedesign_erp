#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
BACKUP_DIR="$APP_DIR/backups"
LOG_DIR="$APP_DIR/logs"
ENV_FILE="$APP_DIR/.env.production"
DB_CONTAINER="hopedesign-erp-postgres-1"

# Resolve the live role/database from .env.production exactly like docker
# compose interpolation (${POSTGRES_USER:-hopedesign} / ${POSTGRES_DB:-hopedesign_erp}),
# so backups never break when these are overridden. Neither value is a secret.
env_value() {
  local key="$1" default="$2" raw=""
  if [[ -f "$ENV_FILE" ]]; then
    raw="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  fi
  raw="${raw#\"}"; raw="${raw%\"}"
  raw="${raw#\'}"; raw="${raw%\'}"
  raw="$(printf '%s' "$raw" | tr -d '\r')"
  printf '%s' "${raw:-$default}"
}
DB_USER="$(env_value POSTGRES_USER hopedesign)"
DB_NAME="$(env_value POSTGRES_DB hopedesign_erp)"

DATE=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/cron_db_$DATE.sql.gz"
TMP_FILE="$BACKUP_FILE.tmp"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

echo "[$(date)] Starting PostgreSQL backup (db=$DB_NAME)"
# pg_dump errors go to a log file (never into the dump stream). pipefail turns a
# failed dump into a failed pipeline so a broken backup is never reported as OK.
if ! docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" 2>"$LOG_DIR/pg_backup_last.err" | gzip > "$TMP_FILE"; then
  echo "[$(date)] ERROR: pg_dump failed; refusing to deploy/keep backup. See $LOG_DIR/pg_backup_last.err" >&2
  rm -f "$TMP_FILE"
  exit 1
fi

# Guard against empty/truncated dumps (e.g. wrong DB name reported as success).
if ! gzip -t "$TMP_FILE" 2>/dev/null || [[ $(stat -c %s "$TMP_FILE" 2>/dev/null || echo 0) -lt 1024 ]]; then
  echo "[$(date)] ERROR: produced dump is empty/invalid; keeping no backup." >&2
  rm -f "$TMP_FILE"
  exit 1
fi

mv "$TMP_FILE" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
echo "[$(date)] Backup successfully saved to $BACKUP_FILE"

# Delete cron backups older than 30 days
find "$BACKUP_DIR" -type f -name "cron_db_*.sql.gz" -mtime +30 -delete
