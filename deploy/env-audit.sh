#!/usr/bin/env bash
set -euo pipefail

PROD_ENV="/opt/hopedesign_erp/.env.production"
EXAMPLE_ENV="/opt/hopedesign_erp/.env.example"
ERRORS=0

echo "================================="
echo " CONFIGURATION & DRIFT AUDIT"
echo "================================="

# 1. File existence
if [ ! -f "$PROD_ENV" ]; then
  echo "FAIL: $PROD_ENV does not exist!"
  exit 1
fi

# 2. Permission check
PERMS=$(stat -c "%a" "$PROD_ENV")
if [ "$PERMS" != "600" ]; then
  echo "WARNING: $PROD_ENV permissions are $PERMS (Should be 600). Fixing..."
  chmod 600 "$PROD_ENV"
else
  echo "OK: $PROD_ENV permission is strict (600)."
fi

# 3. Missing keys check
if [ -f "$EXAMPLE_ENV" ]; then
  echo "Auditing environment variable drift against .env.example..."
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    
    KEY=$(echo "$line" | cut -d '=' -f 1)
    if ! grep -q "^${KEY}=" "$PROD_ENV"; then
      echo "DRIFT DETECTED: Key '$KEY' is in .env.example but missing in .env.production!"
      ERRORS=$((ERRORS + 1))
    fi
  done < "$EXAMPLE_ENV"
fi

if [ "$ERRORS" -eq 0 ]; then
  echo "SUCCESS: Configuration audit passed with 0 drift errors."
else
  echo "FAILURE: Found $ERRORS drift issue(s) in environment files."
  exit 1
fi
