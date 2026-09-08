#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
ENV_FILE="$APP_DIR/.env.production"
LOG_FILE="$APP_DIR/logs/db-maintenance.log"
CONTAINER="hopedesign-erp-postgres-1"

# Resolve live role/database from .env.production (mirrors compose interpolation).
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
DB_NAME="$(env_value POSTGRES_DB hopedesign)"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting database optimization..." | tee -a "$LOG_FILE"

echo "Running VACUUM ANALYZE..." | tee -a "$LOG_FILE"
docker exec -i "$CONTAINER" vacuumdb -U "$DB_USER" -d "$DB_NAME" --analyze --verbose >> "$LOG_FILE" 2>&1

echo "Database size after optimization:" | tee -a "$LOG_FILE"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT pg_size_pretty(pg_database_size('$DB_NAME')) AS db_size;" | tee -a "$LOG_FILE"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Database optimization complete." | tee -a "$LOG_FILE"
