#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/hopedesign_erp/backups"
LOG_DIR="/opt/hopedesign_erp/logs"
# Uploads live in the compose-managed named volume (mounted at /data/uploads in
# both API colors). Snapshot from whichever API color is currently running so
# the backup works even in the middle of a blue/green rollout.
VOLUME_MOUNT="/data/uploads"
API_CONTAINER=""
for candidate in hopedesign-erp-api-a hopedesign-erp-api-b; do
  if docker ps --format '{{.Names}}' | grep -qx "$candidate"; then
    API_CONTAINER="$candidate"
    break
  fi
done
if [[ -z "$API_CONTAINER" ]]; then
  echo "ERROR: no running API container found; cannot snapshot uploads volume." >&2
  exit 1
fi
TIMESTAMP=$(date +'%Y-%m-%d_%H-%M-%S')
OUT_FILE="$BACKUP_DIR/storage_backup_$TIMESTAMP.tar.gz"
TMP_FILE="$BACKUP_DIR/.storage_backup_$TIMESTAMP.tmp"

mkdir -p "$BACKUP_DIR" "$LOG_DIR"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting storage backup (volume mount $VOLUME_MOUNT in $API_CONTAINER)"
if docker exec "$API_CONTAINER" tar -czf - -C "$VOLUME_MOUNT" . > "$TMP_FILE" 2>"$LOG_DIR/storage_backup_last.err"; then
  if gzip -t "$TMP_FILE" 2>/dev/null && [[ $(stat -c %s "$TMP_FILE" 2>/dev/null || echo 0) -ge 50 ]]; then
    mv "$TMP_FILE" "$OUT_FILE"
    chmod 600 "$OUT_FILE"
    echo "Storage backup created: $OUT_FILE"
    find "$BACKUP_DIR" -type f -name "storage_backup_*.tar.gz" -mtime +14 -delete
  else
    echo "ERROR: storage archive empty/invalid; keeping no backup." >&2
    rm -f "$TMP_FILE"
    exit 1
  fi
else
  echo "ERROR: storage tar failed; see $LOG_DIR/storage_backup_last.err" >&2
  rm -f "$TMP_FILE"
  exit 1
fi