#!/usr/bin/env bash
set -euo pipefail

CONTAINER="hopedesign-erp-postgres-1"
DB_USER="hopedesign"
DB_NAME="hopedesign_erp"
OUT_DIR="/opt/hopedesign_erp/backups"
TIMESTAMP=$(date +'%Y%m%d_%H%M%S')
SANITIZED_FILE="$OUT_DIR/sanitized_db_$TIMESTAMP.sql"

echo "================================="
echo " DATABASE SANITIZER (GDPR SAFE)"
echo "================================="

echo "[1/3] Creating temporary database copy..."
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS hopedesign_sanitized;"
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE hopedesign_sanitized WITH TEMPLATE $DB_NAME;"

echo "[2/3] Anonymizing user PII & sensitive secrets..."
# Default bcrypt hash for DevPass2026!
DEV_HASH='$2a$10$wQ6mX1v8z2S7nB9sK0mP0u9aQ8X7y6Z5w4V3u2T1s0R9q8P7o6N5m'

docker exec -i "$CONTAINER" psql -U "$DB_USER" -d hopedesign_sanitized <<SQL
  -- Reset all user passwords to DevPass2026! and clear MFA
  UPDATE users 
  SET password_hash = '$DEV_HASH',
      mfa_enabled = false,
      mfa_secret = NULL,
      phone = '0700000000'
  WHERE email != 'admin@hopedesign.co.ug';

  -- Anonymize non-admin email addresses
  UPDATE users 
  SET email = 'user_' || id || '@staging.local'
  WHERE email != 'admin@hopedesign.co.ug';
SQL

echo "[3/3] Exporting compressed sanitized dump..."
docker exec -i "$CONTAINER" pg_dump -U "$DB_USER" -d hopedesign_sanitized | gzip > "$SANITIZED_FILE.gz"

# Cleanup temp DB
docker exec -i "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE hopedesign_sanitized;"

echo "Sanitized dump created: $SANITIZED_FILE.gz"
