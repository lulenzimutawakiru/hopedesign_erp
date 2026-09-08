#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="/opt/hopedesign_erp/backups"
TEST_CONTAINER="erp-postgres-dr-test"
LOG_FILE="/opt/hopedesign_erp/logs/dr-test.log"
TEST_PORT="5433"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting Automated Disaster Recovery Test..." | tee -a "$LOG_FILE"

# Find latest database dump
LATEST_DUMP=$(ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -n 1 || true)

if [ -z "$LATEST_DUMP" ]; then
  echo "ERROR: No backup files (.sql.gz) found in $BACKUP_DIR" | tee -a "$LOG_FILE"
  exit 1
fi

echo "Testing backup file: $LATEST_DUMP" | tee -a "$LOG_FILE"

# Cleanup function for ephemeral container
cleanup() {
  echo "Tearing down temporary validation container..." | tee -a "$LOG_FILE"
  docker stop "$TEST_CONTAINER" >/dev/null 2>&1 || true
  docker rm "$TEST_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Spin up ephemeral container
echo "[1/4] Launching ephemeral PostgreSQL container on port $TEST_PORT..." | tee -a "$LOG_FILE"
docker run --name "$TEST_CONTAINER" \
  -e POSTGRES_USER=dr_tester \
  -e POSTGRES_PASSWORD=dr_password \
  -e POSTGRES_DB=hopedesign_erp_dr \
  -p "$TEST_PORT":5432 \
  -d postgres:15-alpine >/dev/null

# Wait for DB readiness
until docker exec "$TEST_CONTAINER" pg_isready -U dr_tester -d hopedesign_erp_dr >/dev/null 2>&1; do
  sleep 1
done

# 2. Restore Dump
echo "[2/4] Restoring backup dump into temporary instance..." | tee -a "$LOG_FILE"
gunzip -c "$LATEST_DUMP" | docker exec -i "$TEST_CONTAINER" psql -U dr_tester -d hopedesign_erp_dr >/dev/null 2>&1

# 3. Run Integrity Assertion Query
echo "[3/4] Running schema & data integrity assertions..." | tee -a "$LOG_FILE"
USER_COUNT=$(docker exec -i "$TEST_CONTAINER" psql -U dr_tester -d hopedesign_erp_dr -t -c "SELECT COUNT(*) FROM users;" | xargs)

if [ "$USER_COUNT" -gt 0 ]; then
  echo "SUCCESS: Disaster recovery verification passed! Found $USER_COUNT users in restored backup." | tee -a "$LOG_FILE"
else
  echo "FAILURE: Database restored but users table is empty!" | tee -a "$LOG_FILE"
  exit 1
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] DR Test Completed Successfully." | tee -a "$LOG_FILE"
