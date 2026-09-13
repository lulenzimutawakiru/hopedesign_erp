#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - BLUE/GREEN PRODUCTION ROLLOUT
#
# Run from /opt/hopedesign_erp on the VPS (uses bash arrays - do not use sh):
#   bash deploy/zero-downtime-deploy.sh
#
# Two API colors (api-a, api-b) always run. Caddy routes /api to exactly one
# ACTIVE color via deploy/caddy-live/active.caddy. This script:
#   1. takes a database backup,
#   2. fast-forwards the worktree to origin/main,
#   3. builds fresh api-a/api-b/web/worker images,
#   4. brings up the queue broker (redis) and the background worker,
#   5. recreates ONLY the idle color (the active color keeps serving),
#   6. waits for the new color to become Docker-healthy,
#   7. rebuilds the web (SPA) replicas so the frontend ships with the API,
#   8. atomically flips Caddy to the new color (`caddy reload`),
#   9. health-gates through the public endpoint and flips back on failure.
# The old color is left running so rollback is instant and the next deploy
# rebuilds it.
#############################################################
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
ENV_FILE="$APP_DIR/.env.production"
COMPOSE_FILE="$APP_DIR/docker-compose.prod.yml"
LOG_DIR="$APP_DIR/logs"
LIVE_DIR="$APP_DIR/deploy/caddy-live"
ACTIVE_FILE="$LIVE_DIR/active.caddy"
CADDY_CONTAINER="hopedesign-erp-caddy-1"

cd "$APP_DIR"
mkdir -p "$LOG_DIR" "$LIVE_DIR"

log() { echo "[deploy $(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_DIR/deploy.log"; }

# ---- helpers ---------------------------------------------------------------
current_active() {
  if grep -Eq 'reverse_proxy api-a:4000' "$ACTIVE_FILE" 2>/dev/null; then echo a; return 0; fi
  if grep -Eq 'reverse_proxy api-b:4000' "$ACTIVE_FILE" 2>/dev/null; then echo b; return 0; fi
  echo a
}
write_active() { # $1 = a | b
  local color="$1"
  cat > "$ACTIVE_FILE" <<EOF
reverse_proxy api-$color:4000 {
	import /etc/caddy/live/options.caddy
}
EOF
}
other_color() { # $1 = a | b
  [[ "$1" == "a" ]] && echo b || echo a
}
api_container() { # $1 = a | b
  echo "hopedesign-erp-api-$1"
}
api_healthy() { # $1 = a | b
  local c
  c="$(api_container "$1")"
  [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo missing)" == "healthy" ]]
}
container_healthy() { # $1 = container name
  [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing)" == "healthy" ]]
}
flip_to() { # $1 = target color; reverts to the previous color on reload failure
  local target="$1" prev
  prev="$(current_active)"
  write_active "$target"
  if docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    log "flipped active color: $prev -> $target"
    return 0
  fi
  log "ERROR: caddy reload failed; restoring active color $prev"
  write_active "$prev"
  docker exec "$CADDY_CONTAINER" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  return 1
}

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

OLD_COMMIT="$(git rev-parse HEAD)"
log "== blue/green rollout start =="
log "current commit: ${OLD_COMMIT:0:12}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "ABORT: worktree has uncommitted changes; commit or stash them first."
  exit 1
fi

# 1) Backup first - never roll out on top of the only good copy of the data.
log "[1/8] database backup"
if [[ -x deploy/postgres-backup.sh ]]; then
  ./deploy/postgres-backup.sh || { log "ABORT: pre-deploy backup failed; refusing to deploy."; exit 1; }
else
  log "      (deploy/postgres-backup.sh not found; skipping dump)"
fi

# 2) Update code. deploy/caddy-live/active.caddy is gitignored, so the pull
#    never touches the live target.
log "[2/8] pulling origin/main"
git fetch origin main
git merge --ff-only origin/main

# 3) Build the new images. `worker` shares the api build target, so it is a
#    cached re-tag rather than a second compile - but it must be listed, or the
#    worker service would keep running whatever image it was created with.
log "[3/8] building api-a/api-b/web/worker images"
"${compose[@]}" build api-a api-b web worker

# 4) Broker before colour. The API colors disable their in-process fallback
#    timers the moment they see REDIS_URL, so Redis and the worker have to be
#    running *before* the first new color starts - otherwise scheduled work
#    (report schedules, cron fan-out, the Hikvision drain, EFRIS fiscalization,
#    notification delivery) would go nowhere until the next deploy.
#
#    This runs BEFORE anything is recreated, so a failure here aborts the
#    rollout while the old colors are still up and still running their own
#    timers. That is the last cheap abort point.
log "[4/8] starting the queue broker and background worker"
"${compose[@]}" up -d --no-deps redis
REDIS_OK=0
for _ in $(seq 1 30); do
  if container_healthy hopedesign-erp-redis-1; then REDIS_OK=1; break; fi
  sleep 2
done
if [[ "$REDIS_OK" != "1" ]]; then
  log "ABORT: redis did not become healthy; no color has been recreated, so the running deployment is untouched."
  "${compose[@]}" logs --tail 40 redis 2>&1 | tee -a "$LOG_DIR/deploy.log" || true
  exit 1
fi
log "      redis is healthy"

"${compose[@]}" up -d --no-deps --force-recreate worker
WORKER_OK=0
for _ in $(seq 1 24); do
  if container_healthy hopedesign-erp-worker-1; then WORKER_OK=1; break; fi
  sleep 5
done
if [[ "$WORKER_OK" != "1" ]]; then
  # Not fatal: the worker retries its own connection, and an unhealthy worker
  # only delays background work, which deploy/stack-watchdog.sh keeps chasing.
  # Aborting here would leave the *old* worker image in place for no gain.
  log "WARNING: worker is not healthy yet; continuing (watchdog will reconcile it)"
  "${compose[@]}" logs --tail 40 worker 2>&1 | tee -a "$LOG_DIR/deploy.log" || true
else
  log "      worker is healthy"
fi

# 5) Recreate ONLY the idle color; the active color keeps serving.
ACTIVE="$(current_active)"
IDLE="$(other_color "$ACTIVE")"
log "[5/8] active=$ACTIVE idle=$IDLE - recreating idle color with the new image"
"${compose[@]}" up -d --no-deps --force-recreate "api-$IDLE"

# 6) Wait for the idle color to become healthy before it ever sees traffic.
log "[6/8] waiting for api-$IDLE to become healthy"
IDLE_OK=0
for _ in $(seq 1 60); do
  if api_healthy "$IDLE"; then IDLE_OK=1; break; fi
  sleep 5
done
if [[ "$IDLE_OK" != "1" ]]; then
  log "ROLLBACK: new api-$IDLE failed to become healthy; keeping active=$ACTIVE"
  "${compose[@]}" ps
  exit 1
fi
log "      api-$IDLE is healthy"

# 6) The SPA ships from the `web` service (deploy.replicas: 2), so every replica
#    is recreated here. Doing it before the flip means the new frontend never
#    runs against an API that is missing its routes, and the deploy can never
#    finish with a stale bundle. The gate requires EVERY replica to be healthy -
#    accepting one would let Caddy keep load-balancing to a stale frontend.
log "[7/8] rebuilding the web (SPA) containers"
"${compose[@]}" up -d --no-deps --force-recreate web
WEB_CONTAINERS="$(docker ps -a \
  --filter 'label=com.docker.compose.project=hopedesign-erp' \
  --filter 'label=com.docker.compose.service=web' \
  --format '{{.Names}}' 2>/dev/null || true)"
WEB_OK=0
for _ in $(seq 1 24); do
  all_web_ok=1
  for c in $WEB_CONTAINERS; do
    if ! container_healthy "$c"; then all_web_ok=0; break; fi
  done
  if [[ -n "$WEB_CONTAINERS" && "$all_web_ok" == "1" ]]; then WEB_OK=1; break; fi
  sleep 5
done
if [[ "$WEB_OK" != "1" ]]; then
  log "ABORT: web container(s) did not become healthy; the API is still on $ACTIVE and untouched."
  "${compose[@]}" ps
  exit 1
fi
log "      web is healthy"

# 8) Atomic flip + public health gate.
log "[8/8] flipping Caddy to api-$IDLE"
if ! flip_to "$IDLE"; then
  log "ABORT: flip failed; active color restored to $ACTIVE"
  exit 1
fi

DOMAIN="$(sed -n 's/^DOMAIN=//p' "$ENV_FILE" | tail -1)"
probe_health() {
  if [[ -n "$DOMAIN" && "$DOMAIN" != ":80" ]]; then
    curl -fsS --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" >/dev/null 2>&1
  else
    curl -fsS --max-time 5 http://127.0.0.1/api/health >/dev/null 2>&1
  fi
}
log "      health-gating the flipped color"
OK=0
for _ in $(seq 1 24); do
  if probe_health; then OK=1; break; fi
  sleep 5
done

if [[ "$OK" != "1" ]]; then
  log "ROLLBACK: api-$IDLE unhealthy through Caddy; flipping back to $ACTIVE"
  if flip_to "$ACTIVE"; then
    log "ROLLBACK: active color restored to $ACTIVE"
  fi
  exit 1
fi

log "== rollout complete =="
log "active color: api-$IDLE  now at: $(git rev-parse --short HEAD)"
"${compose[@]}" ps