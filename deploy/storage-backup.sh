#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/hopedesign_erp/backups"
STORAGE_DIR="/opt/hopedesign_erp/storage"
TIMESTAMP=$(date +'%Y-%m-%d_%H-%M-%S')
OUT_FILE="$BACKUP_DIR/storage_backup_$TIMESTAMP.tar.gz"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting storage backup..."
if [ -d "$STORAGE_DIR" ]; then
  tar -czf "$OUT_FILE" -C "$STORAGE_DIR" .
  echo "Storage backup created: $OUT_FILE"
  find "$BACKUP_DIR" -type f -name "storage_backup_*.tar.gz" -mtime +14 -delete
else
  echo "Storage directory $STORAGE_DIR not found, skipping."
fi
