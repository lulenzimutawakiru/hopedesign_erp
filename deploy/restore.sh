#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/hopedesign_erp/backups"
CONTAINER="hopedesign-erp-postgres-1"
DB_USER="hopedesign"
DB_NAME="hopedesign_erp"

echo "================================="
echo " ERP DATABASE RESTORE UTILITY"
echo "================================="

if [ -z "${1:-}" ]; then
  echo "Available backups in $BACKUP_DIR:"
  ls -lh "$BACKUP_DIR"/*.sql.gz 2>/dev/null || { echo "No backups found!"; exit 1; }
  echo ""
  read -r -p "Enter backup filename (or full path): " RESTORE_FILE
else
  RESTORE_FILE="$1"
fi

if [ ! -f "$RESTORE_FILE" ] && [ -f "$BACKUP_DIR/$RESTORE_FILE" ]; then
  RESTORE_FILE="$BACKUP_DIR/$RESTORE_FILE"
fi

if [ ! -f "$RESTORE_FILE" ]; then
  echo "Error: Backup file $RESTORE_FILE does not exist."
  exit 1
fi

echo "WARNING: This will overwrite data in '$DB_NAME' with '$RESTORE_FILE'."
read -r -p "Are you sure you want to proceed? (type 'YES'): " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Restore canceled."
  exit 0
fi

echo "[1/3] Creating safety pre-restore backup..."
/opt/hopedesign_erp/deploy/postgres-backup.sh || true

echo "[2/3] Dropping active database connections..."
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true

echo "[3/3] Restoring database dump..."
if [[ "$RESTORE_FILE" == *.gz ]]; then
  gunzip -c "$RESTORE_FILE" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"
else
  cat "$RESTORE_FILE" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"
fi

echo "Database restore completed successfully."
