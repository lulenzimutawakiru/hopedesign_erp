#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP - put the built WEB and API images on every peer node in the
# production pool, then recreate that node's copies of both.
#
# Renamed from deploy/sync-web-to-peer.sh on 2026-09-26.
#
# Why the rename: the old script was named for `web` and shipped only `web`.
# That was survivable while the peer was a frontend cache and nothing else, and
# it stopped being survivable the moment the peer's Caddy was found serving
# /api from the peer's OWN api-a/api-b (the peer's
# deploy/caddy-live/active.caddy is `reverse_proxy api-b:4000`). From the
# moment DNS points at the peer, the peer answers the whole product, not just
# the SPA - and its API image was built 2026-09-19T08:34Z, seven days and
# several merged features behind the primary (the routing update/delete and the
# BOM edit/delete of that same morning among them). No frontend can paper that
# over. Nobody re-reads a file called "sync-web" looking for a missing API, so
# the name is the reason that gap outlived a week of green rollouts. One script
# moves both services now, and both are asserted by image id.
#
# Why an image and not the source tree: the peer has no git checkout and a
# locally patched docker-compose.prod.yml (it publishes its Caddy on the
# WireGuard tunnel and points its api colors at the primary's postgres/redis),
# so syncing source there is not safe. Shipping the built image is: the peer
# only ever needs the artifact, and `up -d --no-deps` never touches the caddy,
# redis or postgres it was not asked about.
#
# What is deliberately NOT shipped:
#   * `worker` - profile-gated `data-primary-only` so scheduled work (invoices,
#     backups, email, the Hikvision drain, EFRIS) runs exactly once
#     cluster-wide. The peer therefore has no worker, and those jobs stop if
#     the primary dies until one is selected. That is a decision, not an
#     oversight.
#   * postgres/redis - the peer's copies are the failover story, not a mirror
#     of the primary's. See deploy/docker-compose.peer-failover.yml.
#
# Both API colours are shipped as their own tags. They legitimately differ from
# each other right after a rollout (blue-green recreates only the idle colour
# before the flip, so the previously-active colour is still on the previous
# build), so the check is "the peer's api-a matches this node's api-a and the
# peer's api-b matches this node's api-b" rather than "both are one image".
# The consequence to know: a peer that takes over immediately after a rollout
# serves whichever colour its own Caddy points at, which may be one build
# behind this node. That is a build, not a feature gap, and the next rollout
# converges it.
#
# Usage (on the primary node, from /opt/hopedesign_erp):
#   bash deploy/sync-images-to-peer.sh               every peer in the pool
#   bash deploy/sync-images-to-peer.sh 10.77.0.2     one explicit host
#   bash deploy/sync-images-to-peer.sh --help
#
# Exit status: 0 every peer in the pool now serves these images,
#              1 at least one peer could not be brought onto them (the caller
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
# Only reached if a container predates the compose config-files label.
PEER_COMPOSE_FALLBACK="$APP_DIR/docker-compose.prod.yml"
# Everything the peer must run to answer for this node. `worker` is listed
# nowhere on purpose - see the header.
SYNC_SERVICES=(web api-a api-b)
# A recreate is retried as a whole (ship, then up) rather than per step: docker
# load is idempotent, so a second attempt after a dropped tunnel is safe.
SYNC_ATTEMPTS="${SYNC_ATTEMPTS:-${WEB_SYNC_ATTEMPTS:-3}}"
# The SPA is ready in seconds; the API inherits a 120s health start_period, so
# its gate is the local rollout's own 60 x 5s = 300s. WEB_SYNC_* are honoured
# for callers that still set the old names.
WEB_HEALTH_TRIES="${SYNC_HEALTH_TRIES:-${WEB_SYNC_HEALTH_TRIES:-24}}"
API_HEALTH_TRIES="${API_SYNC_HEALTH_TRIES:-60}"

SSH_OPTS=(
  -i "$PEER_SSH_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=no
  -o ConnectTimeout=15
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
)

mkdir -p "$LOG_DIR"

log() { echo "[image-sync $(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"; }
fail() { log "ERROR: $*" >&2; exit 1; }

USAGE="usage: bash deploy/sync-images-to-peer.sh [--help] [host ...]

Ships this node's web and api images to every peer node in the pool and
recreates that node's replicas of each, then asserts per service that every
peer replica runs the same image id this node runs for that service. With no
host argument the peers are read from $LIVE_DIR/webpeer*.caddy, which is what
Caddy itself uses to build the pool.

env:
  PEER_SSH_KEY          ssh key for the peer        (default /root/.ssh/id_ed25519)
  SYNC_ATTEMPTS         whole-recreate attempts     (default 3)
  SYNC_HEALTH_TRIES     web health polls, 5s apart  (default 24)
  API_SYNC_HEALTH_TRIES api health polls, 5s apart  (default 60)"

# Every replica of one service in this compose project on a node, discovered by
# compose label and never by container name: deploy.replicas decides the count,
# so a hardcoded hopedesign-erp-web-1 would silently ignore the rest of the pool.
containers_on() { # $1 = "" (this node) | root@<host>, $2 = service
  local target="$1" service="$2"
  if [[ -z "$target" ]]; then
    docker ps -a --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" --filter "label=com.docker.compose.service=$service" --format '{{.Names}}' 2>/dev/null || true
  else
    ssh "${SSH_OPTS[@]}" "$target" "docker ps -a --filter 'label=com.docker.compose.project=$COMPOSE_PROJECT' --filter 'label=com.docker.compose.service=$service' --format '{{.Names}}'" 2>/dev/null || true
  fi
}

# The image id behind every replica of a service on a node, one per line. Blank
# results are dropped rather than echoed, so a caller can compare sorted uniques.
image_ids_on() { # $1 = "" (this node) | root@<host>, $2 = service
  local target="$1" service="$2" c id
  for c in $(containers_on "$target" "$service"); do
    if [[ -z "$target" ]]; then
      id="$(docker inspect -f '{{.Image}}' "$c" 2>/dev/null || true)"
    else
      id="$(ssh "${SSH_OPTS[@]}" "$target" "docker inspect -f '{{.Image}}' '$c'" 2>/dev/null || true)"
    fi
    [[ -n "$id" ]] && echo "$id"
  done
  return 0
}

# `running` is accepted alongside `healthy` because not every service carries a
# HEALTHCHECK; a crash-looping container reports `restarting` either way, which
# is the failure this gate exists to catch.
is_healthy_on() { # $1 = "" (this node) | root@<host>, $2 = container
  local target="$1" container="$2" status
  if [[ -z "$target" ]]; then
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo missing)"
  else
    status="$(ssh "${SSH_OPTS[@]}" "$target" "docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' '$container'" 2>/dev/null || echo missing)"
  fi
  [[ "$status" == "healthy" || "$status" == "running" ]]
}

health_tries_for() { # $1 = service
  case "$1" in
    web) echo "$WEB_HEALTH_TRIES" ;;
    *)   echo "$API_HEALTH_TRIES" ;;
  esac
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

# Recreate one service on a peer, through the exact compose file list that
# service was created with. Read off the running container's own label rather
# than assumed: the peer's api colours come from docker-compose.prod.yml PLUS
# deploy/docker-compose.peer.yml, and the peer.yml half is what points them at
# the primary's postgres/redis over the tunnel. Recreating them from prod.yml
# alone would quietly repoint them at the peer's own local database - a
# different deployment, not a stale one.
recreate_remote() { # $1 = host, $2 = service
  local host="$1" service="$2"
  ssh "${SSH_OPTS[@]}" "root@$host" 'bash -s' <<REMOTE
set -euo pipefail
cd $APP_DIR
first="\$(docker ps -a --filter 'label=com.docker.compose.project=$COMPOSE_PROJECT' --filter 'label=com.docker.compose.service=$service' --format '{{.Names}}' | head -n1)"
if [[ -z "\$first" ]]; then echo "no $service container to recreate" >&2; exit 1; fi
files="\$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "\$first" 2>/dev/null || true)"
if [[ -z "\$files" ]]; then files="$PEER_COMPOSE_FALLBACK"; fi
args=()
IFS=',' read -r -a parts <<< "\$files"
for f in "\${parts[@]}"; do args+=( -f "\$f" ); done
echo "recreating $service from \${args[*]}"
docker compose "\${args[@]}" --env-file .env.production up -d --no-deps --no-build --force-recreate $service
REMOTE
}

sync_service_to_peer() { # $1 = host, $2 = service, $3 = image reference to ship
  local host="$1" service="$2" ref="$3" attempt names ok c tries
  tries="$(health_tries_for "$service")"
  for attempt in $(seq 1 "$SYNC_ATTEMPTS"); do
    log "shipping $service ($ref) to $host (attempt $attempt/$SYNC_ATTEMPTS)"
    # Streamed end to end: neither node needs room for a second copy of the
    # tarball. gzip -1 because the link is a WireGuard tunnel over the public
    # internet and image layers are already compressed - pushing quickly beats
    # squeezing harder.
    if ! docker save "$ref" | gzip -1 | ssh "${SSH_OPTS[@]}" "root@$host" 'gunzip | docker load'; then
      log "  $host: could not load the $service image"
      continue
    fi
    if ! recreate_remote "$host" "$service"; then
      log "  $host: could not recreate $service"
      continue
    fi
    names="$(containers_on "root@$host" "$service")"
    if [[ -z "$names" ]]; then
      log "  $host: no $service container found after the recreate"
      continue
    fi
    ok=0
    for _ in $(seq 1 "$tries"); do
      ok=1
      for c in $names; do
        if ! is_healthy_on "root@$host" "$c"; then ok=0; break; fi
      done
      [[ "$ok" == "1" ]] && break
      sleep 5
    done
    if [[ "$ok" != "1" ]]; then
      log "  $host: $service replicas did not become healthy within $((tries * 5))s"
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
  log "no peer node is in the pool (no $LIVE_DIR/webpeer*.caddy); nothing to sync"
  exit 0
fi

# Resolve, once, what this node is serving for each service. A service with a
# `build:` section and no explicit `image:` key is referenced untagged by some
# compose versions, and docker save needs a tag that resolves.
declare -A LOCAL_REFS=() LOCAL_IDS=()
for svc in "${SYNC_SERVICES[@]}"; do
  names="$(containers_on '' "$svc")"
  [[ -n "$names" ]] || fail "no $COMPOSE_PROJECT $svc container on this node; cannot tell which image the pool should serve."
  first="$(echo "$names" | head -n 1)"
  ref="$(docker inspect -f '{{.Config.Image}}' "$first" 2>/dev/null || true)"
  ids="$(image_ids_on '' "$svc" | sort -u)"
  [[ -n "$ref" && -n "$ids" ]] || fail "could not resolve the image behind $first."
  if ! docker image inspect "$ref" >/dev/null 2>&1 && docker image inspect "$ref:latest" >/dev/null 2>&1; then
    ref="$ref:latest"
  fi
  if [[ "$(echo "$ids" | grep -c . || true)" != "1" ]]; then
    fail "this node's own $svc replicas already disagree about their image ($(echo "$ids" | tr '\n' ' ')); recreate them before syncing peers."
  fi
  LOCAL_REFS[$svc]="$ref"
  LOCAL_IDS[$svc]="$ids"
  log "this node serves $svc $ref ($ids)"
done

RC=0
for host in "${PEERS[@]}"; do
  NODE_OK=1
  for svc in "${SYNC_SERVICES[@]}"; do
    if [[ -z "$(containers_on "root@$host" "$svc")" ]]; then
      log "WARN $host runs no $svc container; skipping it (it cannot answer for $svc if this node dies)"
      continue
    fi
    if ! sync_service_to_peer "$host" "$svc" "${LOCAL_REFS[$svc]}"; then
      log "FAIL $host is still not serving this node's $svc image"
      NODE_OK=0
      continue
    fi
    PEER_IDS="$(image_ids_on "root@$host" "$svc" | sort -u)"
    if [[ "$PEER_IDS" != "${LOCAL_IDS[$svc]}" ]]; then
      log "FAIL $host runs $svc [$(echo "$PEER_IDS" | tr '\n' ' ')] but this node runs ${LOCAL_IDS[$svc]}"
      NODE_OK=0
      continue
    fi
    # Count replicas, not distinct image ids: the assertion above has already
    # proved every replica agrees, so they all collapse into one unique id and a
    # `sort -u | grep -c .` would report 1 even when the pool runs several.
    PEER_REPLICAS="$(containers_on "root@$host" "$svc" | grep -c . || true)"
    log "ok   $host serves $svc ${LOCAL_IDS[$svc]} across $PEER_REPLICAS replica(s)"
  done
  [[ "$NODE_OK" == "1" ]] || RC=1
done

if [[ "$RC" != "0" ]]; then
  log "== image sync INCOMPLETE: at least one node in the pool is not on this node's images =="
  exit 1
fi

log "== image sync complete: this node plus ${#PEERS[@]} peer node(s) on ${SYNC_SERVICES[*]} =="