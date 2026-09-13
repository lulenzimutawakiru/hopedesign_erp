#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - STACK WATCHDOG (self-healing)
#
# Installed from cron every 2 minutes via deploy/install-watchdog.sh.
# Blue/green aware:
#   - if the ACTIVE API color dies but the idle color is healthy, it flips
#     Caddy to the idle color (atomic `caddy reload`) - no downtime;
#   - if both API colors are down it recreates them;
#   - missing/unhealthy web/postgres/caddy/redis/worker containers are restarted;
#   - the redis broker and the background worker are reconciled by name, because
#     a container removed outright is invisible to `docker restart`, and losing
#     either of them silently stops every scheduled task (the API colors do not
#     run those timers once REDIS_URL is set).
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
REDIS_CONTAINER="hopedesign-erp-redis-1"
WORKER_CONTAINER="hopedesign-erp-worker-1"
WEB_REPLICAS=2 # keep in sync with docker-compose.prod.yml (web: deploy.replicas)

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
web_containers() { # names of every `web` replica in this compose project
  docker ps -a \
    --filter 'label=com.docker.compose.project=hopedesign-erp' \
    --filter 'label=com.docker.compose.service=web' \
    --format '{{.Names}}' 2>/dev/null || true
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
#    `web` runs WEB_REPLICAS replicas, so they are discovered by compose label
#    rather than hardcoding hopedesign-erp-web-1 - a hardcoded name would
#    silently ignore every replica added by deploy.replicas.
for c in hopedesign-erp-postgres-1 "$REDIS_CONTAINER" "$WORKER_CONTAINER" $(web_containers) "$CADDY_CONTAINER"; do
  s="$(status_of "$c")"
  if [[ "$s" != "healthy" && "$s" != "running" ]]; then
    log "restarting unhealthy container $c ($s)"
    docker restart "$c" >> "$LOG_FILE" 2>&1 || true
    sleep 5
  fi
done

# 1a) Reconcile a missing web replica. A container removed outright is invisible
#     to the restart loop above, and losing one replica would quietly halve the
#     frontend's redundancy.
web_have="$(web_containers | grep -c . || true)"
if [[ "${web_have:-0}" -lt "$WEB_REPLICAS" ]]; then
  log "web replicas below expected (have=${web_have:-0} want=$WEB_REPLICAS) - reconciling"
  "${compose[@]}" up -d --no-deps web >> "$LOG_FILE" 2>&1 || true
  sleep 5
fi

# 1c) Reconcile the queue path. The worker is the only thing that runs the
#     periodic tasks, so a *removed* worker container (not merely an unhealthy
#     one) means report schedules, cron jobs, the Hikvision drain, EFRIS
#     fiscalization and notification delivery have all stopped - and the API
#     colors will not pick them up, because they disable their own fallback
#     timers as soon as REDIS_URL is set. Both are reconciled by name because
#     `docker restart` cannot resurrect a container that no longer exists.
for svc in redis worker; do
  c="hopedesign-erp-$svc-1"
  if [[ -z "$(docker inspect -f '{{.Id}}' "$c" 2>/dev/null)" ]]; then
    log "queue container $c is missing - recreating the $svc service"
    "${compose[@]}" up -d --no-deps "$svc" >> "$LOG_FILE" 2>&1 || true
    sleep 5
  fi
done

# 1d) Report the worker's Redis heartbeat. This is deliberately observational:
#     container health already drives the healing above (the worker's /health
#     returns 503 unless it holds a ready connection AND is consuming), and
#     acting on the heartbeat too would risk a restart loop on a slow boot.
#     The key carries a 90s TTL, so a stale or absent key here is the signal a
#     human needs to know the queue is not moving.
worker_status="$(status_of "$WORKER_CONTAINER")"
if [[ "$worker_status" == "healthy" ]]; then
  hb="$(docker exec "$REDIS_CONTAINER" redis-cli --no-auth-warning EXISTS hopedesign:worker:heartbeat 2>/dev/null || echo unknown)"
  if [[ "$hb" != "1" ]]; then
    log "WARNING: $WORKER_CONTAINER is healthy but its heartbeat key is $hb - the queue may not be draining"
  fi
fi

# 1b) Guard the "zombie edge" failure mode. The caddy container can report
#     healthy (its healthcheck only reads Caddy's own admin API) while being
#     detached from the compose network, so it cannot publish 80/443 or resolve
#     the api-*/web aliases. `docker restart` preserves that broken network
#     config, so recovery has to force-recreate the container.
if [[ -n "$(docker inspect -f '{{.Id}}' "$CADDY_CONTAINER" 2>/dev/null)" ]]; then
  caddy_nets="$(docker inspect -f '{{len .NetworkSettings.Networks}}' "$CADDY_CONTAINER" 2>/dev/null || echo 0)"
  caddy_ports="$(docker port "$CADDY_CONTAINER" 2>/dev/null | wc -l)"
  if [[ "${caddy_nets:-0}" -eq 0 || "${caddy_ports:-0}" -eq 0 ]]; then
    log "CRITICAL: $CADDY_CONTAINER is up but not networked/publishing (networks=$caddy_nets published=$caddy_ports) - force-recreating"
    "${compose[@]}" up -d --no-deps --force-recreate caddy >> "$LOG_FILE" 2>&1 || true
    sleep 10
  fi
fi

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
#    This must prove the ERP API itself is answering - not merely that
#    *something* returns HTTP 200. A stale or foreign listener on 80/443 (for
#    example a leftover host-level reverse proxy serving an unrelated app)
#    would satisfy a bare status check and mask a complete outage, so the
#    response body is asserted against the API's own health payload.
DOMAIN="$(sed -n 's/^DOMAIN=//p' "$ENV_FILE" 2>/dev/null | tail -1)"
if [[ -n "$DOMAIN" && "$DOMAIN" != ":80" ]]; then
  probe_url="https://$DOMAIN/api/health"
  probe=(curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "$probe_url")
else
  probe_url="http://127.0.0.1/api/health"
  probe=(curl -fsS --max-time 10 "$probe_url")
fi

api_healthy() {
  local body
  body="$("${probe[@]}" 2>/dev/null)" || return 1
  printf '%s' "$body" | grep -Eq '"service"[[:space:]]*:[[:space:]]*"hopedesign-erp-api"' || return 1
  printf '%s' "$body" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' || return 1
  return 0
}

if ! api_healthy; then
  log "CRITICAL: ERP API not answering through Caddy at $probe_url (payload assertion failed) - recreating API colors"
  "${compose[@]}" up -d --no-deps api-a api-b >> "$LOG_FILE" 2>&1 || true
  sleep 10
  if api_healthy; then
    log "recovery OK"
  else
    log "CRITICAL: still unhealthy after recreate - manual intervention required"
  fi
fi