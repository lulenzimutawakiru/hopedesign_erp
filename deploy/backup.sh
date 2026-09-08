#!/bin/sh
# Dump the production Postgres volume to ./backups/hopedesign-YYYYMMDD-HHMM.sql.gz
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STAMP="$(date +%Y%m%d-%H%M)"
mkdir -p backups
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip > "backups/hopedesign-$STAMP.sql.gz"
echo "Wrote backups/hopedesign-$STAMP.sql.gz"
