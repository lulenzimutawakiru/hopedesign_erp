#!/bin/bash
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
BACKUP_DIR="$APP_DIR/backups"
DATE=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="$BACKUP_DIR/cron_storage_$DATE.tar.gz"

mkdir -p "$BACKUP_DIR"

if [ -d "$APP_DIR/storage" ]; then
    echo "[$(date)] Backing up storage directory..."
    tar -czf "$BACKUP_FILE" -C "$APP_DIR" storage
    echo "[$(date)] Storage backup created: $BACKUP_FILE"

    # Delete storage backups older than 30 days
    find "$BACKUP_DIR" -type f -name "cron_storage_*.tar.gz" -mtime +30 -delete
fi
