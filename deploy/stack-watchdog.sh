#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP — STACK WATCHDOG (self-healing)
#
# Installed from cron every 2 minutes via deploy/install-watchdog.sh.
# Restarts containers that are missing/unhealthy and recreates the stack if
# the public health endpoint stops answering. Safe to run repeatedly.
#############################################################
set -uo pipefail

APP_DIR="/opt/hopedesign_erp"
ENV_FILE="$APP_DIR/.env.production"
COMPOSE_FILE="$APP_DIR/docker-compose.prod.yml"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/watchdog.log"

mkdir -p "$LOG_DIR"
now() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[watchdog $(now)] $*" >> "$LOG_FILE"; }

LOCK_FILE="/run/lock/hopedesign-erp-watchdog.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then exit 0; fi

compose=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

status_of() { # $1 = container name
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing
}

need_recreate=0

# api replicas: at least one must be healthy/running.
api_ok=0
for c in hopedesign-erp-api-1 hopedesign-erp-api-2; do
  s="$(status_of "$c")"
  if [[ "$s" == "healthy" || "$s" == "running" ]]; then api_ok=1; fi
done
if [[ "$api_ok" != "1" ]]; then
  log "CRITICAL: no healthy API replica"
  need_recreate=1
fi

# postgres / web / caddy
for c in hopedesign-erp-postgres-1 hopedesign-erp-web-1 hopedesign-erp-caddy-1; do
  s="$(status_of "$c")"
  if [[ "$s" != "healthy" && "$s" != "running" ]]; then
    log "unhealthy container $c ($s) — restarting"
    docker restart "$c" >> "$LOG_FILE" 2>&1 || need_recreate=1
    sleep 3
  fi
done

# Endpoint gate through Caddy on localhost.
if ! curl -fsS --max-time 10 http://127.0.0.1/api/health >/dev/null 2>&1; then
  log "CRITICAL: http://127.0.0.1/api/health unreachable"
  need_recreate=1
fi

if [[ "$need_recreate" == "1" ]]; then
  API_SCALE="$(sed -n 's/^API_SCALE=//p' "$ENV_FILE" 2>/dev/null | tail -1)"
  [[ "$API_SCALE" =~ ^[1-9][0-9]*$ ]] || API_SCALE=2
  log "recreating stack (api scale=$API_SCALE)"
  "${compose[@]}" up -d --scale "api=$API_SCALE" >> "$LOG_FILE" 2>&1 || true
  sleep 10
  if curl -fsS --max-time 10 http://127.0.0.1/api/health >/dev/null 2>&1; then
    log "recovery OK"
  else
    log "CRITICAL: still unhealthy after recreate — manual intervention required"
  fi
fi
