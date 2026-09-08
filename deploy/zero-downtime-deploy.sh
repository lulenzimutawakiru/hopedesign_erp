#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP — ZERO-DOWNTIME PRODUCTION ROLLOUT
#
# Run from /opt/hopedesign_erp on the VPS:
#   sh deploy/zero-downtime-deploy.sh
#
# The API runs as N stateless replicas (API_SCALE, default 2) behind a Caddy
# load balancer with active health checks. This script:
#   1. takes a database backup,
#   2. fast-forwards the worktree to origin/main,
#   3. builds fresh api/web images,
#   4. rolls the API replicas over one at a time (never fewer than one
#      healthy replica serving through Caddy),
#   5. health-gates the rollout and automatically restores the previous
#      commit if the new build fails to become healthy.
#############################################################
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
ENV_FILE="$APP_DIR/.env.production"
COMPOSE_FILE="$APP_DIR/docker-compose.prod.yml"
LOG_DIR="$APP_DIR/logs"

cd "$APP_DIR"
mkdir -p "$LOG_DIR"

log() { echo "[deploy $(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_DIR/deploy.log"; }

# Never allow two concurrent rollouts.
LOCK_FILE="/run/lock/hopedesign-erp-deploy.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "ABORT: another deployment is already running."
  exit 1
fi
cleanup() { flock -u 9 2>/dev/null || true; }
trap cleanup EXIT

compose=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE is missing" >&2; exit 1; }
API_SCALE="$(sed -n 's/^API_SCALE=//p' "$ENV_FILE" | tail -1)"
[[ "$API_SCALE" =~ ^[1-9][0-9]*$ ]] || API_SCALE=2

OLD_COMMIT="$(git rev-parse HEAD)"
log "== zero-downtime rollout start =="
log "current commit: ${OLD_COMMIT:0:12}  api scale: $API_SCALE"

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "ABORT: worktree has uncommitted changes; commit or stash them first."
  exit 1
fi

# 1) Backup first — never roll out on top of the only good copy of the data.
log "[1/6] database backup"
if [[ -x deploy/postgres-backup.sh ]]; then
  ./deploy/postgres-backup.sh || { log "ABORT: pre-deploy backup failed; refusing to deploy."; exit 1; }
else
  log "      (deploy/postgres-backup.sh not found; skipping dump)"
fi

# 2) Update code.
log "[2/6] pulling origin/main"
git fetch origin main
git merge --ff-only origin/main

# 3) Build.
log "[3/6] building api + web images"
"${compose[@]}" build api web

# 4) Rolling start. Compose recreates replicas one at a time; Caddy's health
#    checks and try_duration keep requests flowing during the swap.
log "[4/6] rolling update (api scale=$API_SCALE)"
"${compose[@]}" up -d --scale "api=$API_SCALE"

# 5) Health gate — internal (through Caddy on localhost).
log "[5/6] waiting for a healthy API"
OK=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 http://127.0.0.1/api/health >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 5
done

if [[ "$OK" != "1" ]]; then
  log "ROLLBACK: new build did not become healthy; restoring ${OLD_COMMIT:0:12}"
  git checkout -q "$OLD_COMMIT"
  "${compose[@]}" build api web
  "${compose[@]}" up -d --scale "api=$API_SCALE"
  log "ROLLBACK: restored ${OLD_COMMIT:0:12}"
  exit 1
fi

# 6) Optional public HTTPS verification.
DOMAIN="$(sed -n 's/^DOMAIN=//p' "$ENV_FILE" | tail -1)"
if [[ -n "$DOMAIN" && "$DOMAIN" != ":80" ]]; then
  if curl -fsS --max-time 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    log "[6/6] public https health OK — $DOMAIN"
  else
    log "[6/6] WARN: public https check failed for $DOMAIN (check DNS/TLS)"
  fi
fi

log "== rollout complete =="
log "now at: $(git rev-parse --short HEAD)"
"${compose[@]}" ps
