#!/usr/bin/env bash
set -euo pipefail

CONTAINER="hopedesign-erp-postgres-1"
DB_USER="hopedesign"
DB_NAME="hopedesign_erp"
LOG_FILE="/opt/hopedesign_erp/logs/db-maintenance.log"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting database optimization..." | tee -a "$LOG_FILE"

echo "Running VACUUM ANALYZE..." | tee -a "$LOG_FILE"
docker exec -i "$CONTAINER" vacuumdb -U "$DB_USER" -d "$DB_NAME" --analyze --verbose >> "$LOG_FILE" 2>&1

echo "Database size after optimization:" | tee -a "$LOG_FILE"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT pg_size_pretty(pg_database_size('$DB_NAME')) AS db_size;" | tee -a "$LOG_FILE"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Database optimization complete." | tee -a "$LOG_FILE"
