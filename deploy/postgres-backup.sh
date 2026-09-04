#!/bin/bash
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
BACKUP_DIR="$APP_DIR/backups"
LOG_DIR="$APP_DIR/logs"

DB_CONTAINER="hopedesign-erp-postgres-1"
DB_USER="hopedesign"
DB_NAME="hopedesign_erp"

DATE=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/cron_db_$DATE.sql.gz"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

echo "[$(date)] Starting PostgreSQL backup..."
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"
echo "[$(date)] Backup successfully saved to $BACKUP_FILE"

# Delete cron backups older than 30 days
find "$BACKUP_DIR" -type f -name "cron_db_*.sql.gz" -mtime +30 -delete
