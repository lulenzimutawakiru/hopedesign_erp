#!/usr/bin/env bash
# Ship backup artifacts off the primary node to the peer node.
#
# Why this exists: every dump used to live only in /opt/hopedesign_erp/backups
# on this host, so a disk failure took the only copy with it. This pushes a
# second copy to the peer over the WireGuard tunnel (10.77.0.2), which runs at
# a different provider, so a provider-level incident cannot destroy both.
set -euo pipefail

BACKUP_DIR="/opt/hopedesign_erp/backups"
LOG_DIR="/opt/hopedesign_erp/logs"
LOG_FILE="$LOG_DIR/offsite-sync.log"
REMOTE_USER="root"
REMOTE_HOST="10.77.0.2"
REMOTE_DIR="/opt/hopedesign_erp/backups"
SSH_KEY="/root/.ssh/id_ed25519"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"
}

SSH_CMD="ssh -i $SSH_KEY -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=3"
REMOTE="$REMOTE_USER@$REMOTE_HOST"

log "Starting offsite backup sync to $REMOTE:$REMOTE_DIR"

# Collect what actually exists. Fail loudly rather than silently shipping
# nothing and reporting success.
shopt -s nullglob
SOURCES=("$BACKUP_DIR"/*.sql.gz "$BACKUP_DIR"/storage_backup_*.tar.gz)
shopt -u nullglob

if [[ ${#SOURCES[@]} -eq 0 ]]; then
  log "ERROR: no backup artifacts found in $BACKUP_DIR; nothing to sync."
  exit 1
fi

log "Found ${#SOURCES[@]} artifact(s) to consider."

if ! $SSH_CMD "$REMOTE" "mkdir -p '$REMOTE_DIR' && chmod 750 '$REMOTE_DIR'"; then
  log "ERROR: peer $REMOTE is unreachable or refused the key; backups remain single-copy."
  exit 1
fi

# --update guards against replacing a newer remote artifact with an older local
# one. Times are preserved; permissions are forced to 600 because production
# data should never be world-readable on the peer either.
if ! rsync -t --update --partial --chmod=F600 -e "$SSH_CMD" "${SOURCES[@]}" "$REMOTE:$REMOTE_DIR/"; then
  log "ERROR: rsync failed; backups may be incomplete on the peer."
  exit 1
fi

# Prove the newest dump really arrived intact: rsync compares size+mtime, which
# cannot catch silent corruption, so compare content digests directly.
NEWEST="$(ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -n 1 || true)"
if [[ -n "$NEWEST" ]]; then
  NAME="$(basename "$NEWEST")"
  LOCAL_MD5="$(md5sum "$NEWEST" | awk '{print $1}')"
  REMOTE_MD5="$($SSH_CMD "$REMOTE" "md5sum '$REMOTE_DIR/$NAME' | awk '{print \$1}'" || true)"
  if [[ "$LOCAL_MD5" != "$REMOTE_MD5" ]]; then
    log "ERROR: checksum mismatch for $NAME (local=$LOCAL_MD5 remote=${REMOTE_MD5:-none})"
    exit 1
  fi
  log "Verified $NAME on peer (md5 $LOCAL_MD5)"
fi

# Peer-side retention, matching the 30-day window used locally.
$SSH_CMD "$REMOTE" "find '$REMOTE_DIR' -maxdepth 1 -type f -name 'cron_db_*.sql.gz' -mtime +30 -delete; find '$REMOTE_DIR' -maxdepth 1 -type f -name 'storage_backup_*.tar.gz' -mtime +30 -delete" || log "WARN: peer-side retention cleanup failed (non-fatal)"

log "Offsite sync completed successfully."
