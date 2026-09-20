#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - ship the built web (SPA) image to every peer node that is
# in the production web pool, and recreate that node's web replicas.
#
# Why this exists: the web pool spans nodes. deploy/caddy-live/webpeer*.caddy
# (untracked, node-local on the primary) adds each peer VPS as an extra upstream
# to the `web` reverse_proxy block in deploy/Caddyfile, so Caddy serves public
# HTML from the peer's OWN web replicas, not from this node's. Rebuilding only
# the local replicas therefore leaves the pool split across two bundles, and a
# split pool does not look stale - it *alternates* between builds on every
# reload, which one request can never reveal. That is how on 2026-09-20 a
# rollout finished "healthy" while half of the public responses still carried
# the bundle built at 05:21 that morning.
#
# Nothing else ships an image to the peer: deploy/offsite-backup-sync.sh ships
# only backups. The peer has no git checkout and a locally patched
# docker-compose.prod.yml (it publishes its Caddy on the WireGuard tunnel), so
# syncing the *source tree* there is not safe. Shipping the built image is: the
# peer only ever needs the artifact, and its compose overlay stays untouched
# because `up -d --no-deps web` never recreates the caddy/redis it is not asked
# about.
#
# Usage (on the primary node, from /opt/hopedesign_erp):
#   bash deploy/sync-web-to-peer.sh                 every peer in the web pool
#   bash deploy/sync-web-to-peer.sh 10.77.0.2       one explicit host
#   bash deploy/sync-web-to-peer.sh --help
#
# Exit status: 0 every peer in the pool now serves this node's web image,
#              1 at least one peer could not be brought onto it (the caller
#                must treat that as a failed rollout, not a warning), and
#              0 with a "nothing to sync" log when no peer is in the pool.
#############################################################
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
ENV_FILE="$APP_DIR/.env.production"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/deploy.log"
LIVE_DIR="$APP_DIR/deploy/caddy-live"
COMPOSE_PROJECT="hopedesign-erp"
PEER_SSH_KEY="${PEER_SSH_KEY:-/root/.ssh/id_ed25519}"
PEER_COMPOSE="docker-compose.prod.yml"
# A recreate is retried as a whole (ship, then up) rather than per step: docker
# load is idempotent, so a second attempt after a dropped tunnel is safe.
SYNC_ATTEMPTS="${WEB_SYNC_ATTEMPTS:-3}"
# 24 x 5s = two minutes, matching the local web gate in zero-downtime-deploy.sh.
HEALTH_TRIES="${WEB_SYNC_HEALTH_TRIES:-24}"

SSH_OPTS=(
  -i "$PEER_SSH_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=no
  -o ConnectTimeout=15
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
)

mkdir -p "$LOG_DIR"

log() { echo "[web-sync $(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"; }
fail() { log "ERROR: $*" >&2; exit 1; }

USAGE="usage: bash deploy/sync-web-to-peer.sh [--help] [host ...]

Ships this node's \`web\` image to every peer node in the web pool and recreates
that node's web replicas, then asserts every peer replica runs the same image id
this node runs. With no host argument the peers are read from
$LIVE_DIR/webpeer*.caddy, which is what Caddy itself uses to build the pool.

env:
  PEER_SSH_KEY          ssh key for the peer        (default /root/.ssh/id_ed25519)
  WEB_SYNC_ATTEMPTS     whole-recreate attempts     (default 3)
  WEB_SYNC_HEALTH_TRIES health polls, 5s apart      (default 24)"

# Every `web` replica in this compose project on a node, discovered by compose
# label and never by container name: deploy.replicas decides the count, so a
# hardcoded hopedesign-erp-web-1 would silently ignore the rest of the pool.
web_containers_on() { # $1 = "" (this node) | root@<host>
  local target="$1"
  if [[ -z "$target" ]]; then
    docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter 'label=com.docker.compose.service=web' --format '{{.Names}}' 2>/dev/null || true
  else
    ssh "${SSH_OPTS[@]}" "$target" "docker ps -a --filter 'label=com.docker.compose.project=$COMPOSE_PROJECT' --filter 'label=com.docker.compose.service=web' --format '{{.Names}}'" 2>/dev/null || true
  fi
}

# The image id behind every web replica on a node, one per line. Blank results
# are dropped rather than echoed, so a caller can compare a sorted unique list.
web_image_ids_on() { # $1 = "" (this node) | root@<host>
  local target="$1" c id
  for c in $(web_containers_on "$target"); do
    if [[ -z "$target" ]]; then
      id="$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null || true)"
    else
      id="$(ssh "${SSH_OPTS[@]}" "$target" "docker inspect -f '{{.Image}}' '$c'" 2>/dev/null || true)"
    fi
    [[ -n "$id" ]] && echo "$id"
  done
  return 0
}

is_healthy_on() { # $1 = "" (this node) | root@<host>, $2 = container
  local target="$1" container="$2" status
  if [[ -z "$target" ]]; then
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo missing)"
  else
    status="$(ssh "${SSH_OPTS[@]}" "$target" "docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' '$container'" 2>/dev/null || echo missing)"
  fi
  [[ "$status" == "healthy" ]]
}

# Peer hosts that Caddy is actually pooling into the web upstreams, read from
# the same import the Caddyfile uses. A hostname upstream is kept as written.
peer_hosts() {
  local f files=()
  shopt -s nullglob
  files=("$LIVE_DIR"/webpeer*.caddy)
  shopt -u nullglob
  for f in "${files[@]}"; do
    sed -n 's/^[[:space:]]*to[[:space:]]\+\([A-Za-z0-9._-]\+\):.*/\1/p' "$f"
  done | sort -u
}

sync_peer() { # $1 = host, $2 = image reference to ship
  local host="$1" ref="$2" target="root@$host" attempt names ok c
  for attempt in $(seq 1 "$SYNC_ATTEMPTS"); do
    log "shipping $ref to $host (attempt $attempt/$SYNC_ATTEMPTS)"
    # Streamed end to end: neither node needs room for a second copy of the
    # tarball. gzip -1 because the link is a WireGuard tunnel over the public
    # internet and image layers are already compressed - pushing quickly beats
    # squeezing harder.
    if ! docker save "$ref" | gzip -1 | ssh "${SSH_OPTS[@]}" "$target" 'gunzip | docker load'; then
      log "  $host: could not load the image"
      continue
    fi
    if ! ssh "${SSH_OPTS[@]}" "$target" "cd $APP_DIR && docker compose -f $PEER_COMPOSE --env-file .env.production up -d --no-deps --no-build --force-recreate web"; then
      log "  $host: could not recreate the web service"
      continue
    fi
    names="$(web_containers_on "$target")"
    if [[ -z "$names" ]]; then
      log "  $host: no $COMPOSE_PROJECT web containers found after the recreate"
      continue
    fi
    ok=0
    for _ in $(seq 1 "$HEALTH_TRIES"); do
      ok=1
      for c in $names; do
        if ! is_healthy_on "$target" "$c"; then ok=0; break; fi
      done
      [[ "$ok" == "1" ]] && break
      sleep 5
    done
    if [[ "$ok" != "1" ]]; then
      log "  $host: web replicas did not become healthy within $((HEALTH_TRIES * 5))s"
      continue
    fi
    return 0
  done
  return 1
}

for arg in "$@"; do
  case "$arg" in
    -h|--help) echo "$USAGE"; exit 0 ;;
    -*) fail "unknown argument: $arg" ;;
  esac
done

if [[ $# -gt 0 ]]; then
  PEERS=("$@")
else
  mapfile -t PEERS < <(peer_hosts)
fi

if [[ ${#PEERS[@]} -eq 0 ]]; then
  log "no peer node is in the web pool (no $LIVE_DIR/webpeer*.caddy); nothing to sync"
  exit 0
fi

LOCAL_CONTAINERS="$(web_containers_on '')"
[[ -n "$LOCAL_CONTAINERS" ]] || fail "no $COMPOSE_PROJECT web container on this node; cannot tell which bundle the pool should serve."
LOCAL_FIRST="$(echo "$LOCAL_CONTAINERS" | head -n 1)"
REF="$(docker inspect -f '{{.Config.Image}}' "$LOCAL_FIRST" 2>/dev/null || true)"
LOCAL_IDS="$(web_image_ids_on '' | sort -u)"
[[ -n "$REF" && -n "$LOCAL_IDS" ]] || fail "could not resolve the image behind $LOCAL_FIRST."
# A service with a `build:` section and no explicit `image:` key is referenced
# untagged by some compose versions, and docker save needs a tag that resolves.
if ! docker image inspect "$REF" >/dev/null 2>&1 && docker image inspect "$REF:latest" >/dev/null 2>&1; then
  REF="$REF:latest"
fi
if [[ "$(echo "$LOCAL_IDS" | grep -c . || true)" != "1" ]]; then
  fail "this node's own web replicas already disagree about their image ($(echo "$LOCAL_IDS" | tr '\n' ' ')); recreate them before syncing peers."
fi
log "this node serves $REF ($LOCAL_IDS)"

RC=0
for host in "${PEERS[@]}"; do
  if ! sync_peer "$host" "$REF"; then
    log "FAIL $host is still not serving the new bundle"
    RC=1
    continue
  fi
  PEER_IDS="$(web_image_ids_on "root@$host" | sort -u)"
  if [[ "$PEER_IDS" != "$LOCAL_IDS" ]]; then
    log "FAIL $host runs [$(echo "$PEER_IDS" | tr '\n' ' ')] but this node runs $LOCAL_IDS"
    RC=1
    continue
  fi
  # Count replicas, not distinct image ids: the assertion above has already
  # proved every replica agrees, so they all collapse into one unique id and a
  # `sort -u | grep -c .` would report 1 even when the pool runs several.
  PEER_REPLICAS="$(web_containers_on "root@$host" | grep -c . || true)"
  log "ok   $host serves $LOCAL_IDS across $PEER_REPLICAS web replica(s)"
done

if [[ "$RC" != "0" ]]; then
  log "== web sync INCOMPLETE: at least one node in the pool is not on this node's bundle =="
  exit 1
fi

log "== web sync complete: this node plus ${#PEERS[@]} peer node(s) on $LOCAL_IDS =="
