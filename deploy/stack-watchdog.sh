#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - STACK WATCHDOG (self-healing)
#
# Installed from cron every 2 minutes via deploy/install-watchdog.sh.
# Blue/green aware:
#   - if the ACTIVE API color dies but the idle color is healthy, it flips
#     Caddy to the idle color (atomic `caddy reload`) - no downtime;
#   - if both API colors are down it recreates them;
#   - missing/unhealthy web/postgres/caddy containers are restarted.
# Safe to run repeatedly.
#############################################################
set -uo pipefail

APP_DIR="/opt/hopedesign_erp"
ENV_FILE="$APP_DIR/.env.production"
COMPOSE_FILE="$APP_DIR/docker-compose.prod.yml"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/watchdog.log"
LIVE_DIR="$APP_DIR/deploy/caddy-live"
ACTIVE_FILE="$LIVE_DIR/active.caddy"
CADDY_CONTAINER="hopedesign-erp-caddy-1"

mkdir -p "$LOG_DIR" "$LIVE_DIR"
now() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[watchdog $(now)] $*" >> "$LOG_FILE"; }

LOCK_FILE="/run/lock/hopedesign-erp-watchdog.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then exit 0; fi

compose=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

status_of() { # $1 = container name
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing
}
current_active() {
  if grep -Eq 'reverse_proxy api-a:4000' "$ACTIVE_FILE" 2>/dev/null; then echo a; return 0; fi
  if grep -Eq 'reverse_proxy api-b:4000' "$ACTIVE_FILE" 2>/dev/null; then echo b; return 0; fi
  echo a
}
write_active() { # $1 = a | b
  cat > "$ACTIVE_FILE" <<EOF
reverse_proxy api-$1:4000 {
	import /etc/caddy/live/options.caddy
}
EOF
}
other_color() { [[ "$1" == "a" ]] && echo b || echo a; }

# 1) Restart obviously dead core containers first (postgres/web/caddy). The
#    API colors are handled below so a healthy idle color can take over.
for c in hopedesign-erp-postgres-1 hopedesign-erp-web-1 "$CADDY_CONTAINER"; do
  s="$(status_of "$c")"
  if [[ "$s" != "healthy" && "$s" != "running" ]]; then
    log "restarting unhealthy container $c ($s)"
    docker restart "$c" >> "$LOG_FILE" 2>&1 || true
    sleep 5
  fi
done

# 2) Evaluate the two API colors.
a_status="$(status_of hopedesign-erp-api-a)"
b_status="$(status_of hopedesign-erp-api-b)"
log "api-a=$a_status api-b=$b_status"
active="$(current_active)"
idle="$(other_color "$active")"

if [[ "$a_status" != "healthy" && "$b_status" != "healthy" ]]; then
  log "CRITICAL: no healthy API color (a=$a_status b=$b_status) - recreating both"
  "${compose[@]}" up -d --no-deps api-a api-b >> "$LOG_FILE" 2>&1 || true
  sleep 10
elif [[ "$a_status" == "healthy" && "$b_status" != "healthy" ]]; then
  if [[ "$active" != "a" ]]; then
    log "api-a healthy while active=$active; flipping b -> a"
    write_active a
    if docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >> "$LOG_FILE" 2>&1; then
      log "flipped active color to api-a"
    else
      log "ERROR: flip to api-a failed; restoring active color"
      write_active b
    fi
  fi
elif [[ "$b_status" == "healthy" && "$a_status" != "healthy" ]]; then
  if [[ "$active" != "b" ]]; then
    log "api-b healthy while active=$active; flipping a -> b"
    write_active b
    if docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >> "$LOG_FILE" 2>&1; then
      log "flipped active color to api-b"
    else
      log "ERROR: flip to api-b failed; restoring active color"
      write_active a
    fi
  fi
fi

# 3) Endpoint gate through Caddy on localhost.
DOMAIN="$(sed -n 's/^DOMAIN=//p' "$ENV_FILE" 2>/dev/null | tail -1)"
if [[ -n "$DOMAIN" && "$DOMAIN" != ":80" ]]; then
  probe="curl -fsS --max-time 10 --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/api/health"
else
  probe="curl -fsS --max-time 10 http://127.0.0.1/api/health"
fi
if ! eval "$probe" >/dev/null 2>&1; then
  log "CRITICAL: API unreachable through Caddy - recreating API colors"
  "${compose[@]}" up -d --no-deps api-a api-b >> "$LOG_FILE" 2>&1 || true
  sleep 10
  if eval "$probe" >/dev/null 2>&1; then
    log "recovery OK"
  else
    log "CRITICAL: still unhealthy after recreate - manual intervention required"
  fi
fi