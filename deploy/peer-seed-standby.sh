#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Seed the peer node's STREAMING STANDBY from the primary's Postgres.
#
# Run this ON THE PEER (the second VPS). It is idempotent-by-refusal: it will
# not touch a pgdata-dr volume that already holds a cluster unless you pass
# --force, because a stray re-run against a live standby is how you turn a
# 223 MB base backup into a fresh, empty, WRONG database that is still
# streaming happily. The only safe way to re-seed is to drop the volume.
#
#   deploy/peer-seed-standby.sh            # seed if empty, refuse if not
#   deploy/peer-seed-standby.sh --check    # report state, change nothing
#   deploy/peer-seed-standby.sh --force    # wipe-and-reseed (asks for consent)
#
# Prereqs already in place on the primary:
#   pg_hba.conf  host replication replicator 10.77.0.0/24 scram-sha-256
#   role replicator  (rolreplication, rolcanlogin)
#   slot peer1       (physical, inactive, never used)
# ---------------------------------------------------------------------------
set -euo pipefail

PRIMARY_HOST="${PRIMARY_HOST:-10.77.0.1}"
PRIMARY_PORT="${PRIMARY_PORT:-9101}"
SLOT="${SLOT:-peer1}"
VOLUME="${VOLUME:-hopedesign-erp_pgdata-dr}"
IMAGE="${IMAGE:-postgres:16-alpine}"
REPL_ENV="${REPL_ENV:-/opt/hopedesign_erp/deploy/replication.env}"
MOUNT=/var/lib/postgresql/data

MODE=seed
case "${1:-}" in
  --check) MODE=check ;;
  --force) MODE=force ;;
  "") : ;;
  *) echo "usage: $0 [--check|--force]" >&2; exit 2 ;;
esac

log() { printf '[seed-standby] %s\n' "$*"; }
die() { printf '[seed-standby] FATAL: %s\n' "$*" >&2; exit 1; }

# --- 1. credentials -------------------------------------------------------
[ -r "$REPL_ENV" ] || die "$REPL_ENV not readable. Copy it from the primary first."
# shellcheck disable=SC1090
. "$REPL_ENV"
: "${REPLICATION_USER:?REPLICATION_USER missing from $REPL_ENV}"
: "${REPLICATION_PASSWORD:?REPLICATION_PASSWORD missing from $REPL_ENV}"

# --- 2. reachability ------------------------------------------------------
if ! timeout 8 bash -c "cat < /dev/null > /dev/tcp/$PRIMARY_HOST/$PRIMARY_PORT" 2>/dev/null; then
  die "primary Postgres bridge $PRIMARY_HOST:$PRIMARY_PORT unreachable (is wg0 up, and pgbridge running on the primary?)"
fi
log "primary bridge $PRIMARY_HOST:$PRIMARY_PORT reachable"

# --- 3. what is in the volume right now -----------------------------------
docker volume inspect "$VOLUME" >/dev/null 2>&1 || {
  if [ "$MODE" = check ]; then log "volume $VOLUME: does not exist"; exit 0; fi
  log "creating volume $VOLUME"
  docker volume create "$VOLUME" >/dev/null
}

# A cluster is "present" if PG_VERSION exists. Use the postgres image itself for
# inspection so we do not depend on busybox/alpine being pulled on this node.
have_cluster() {
  docker run --rm -v "$VOLUME:/d" --entrypoint sh "$IMAGE" -c 'test -s /d/PG_VERSION' >/dev/null 2>&1
}

if have_cluster; then
  VER="$(docker run --rm -v "$VOLUME:/d" --entrypoint sh "$IMAGE" -c 'cat /d/PG_VERSION' 2>/dev/null || echo '?')"
  log "volume $VOLUME already holds a Postgres cluster (PG_VERSION=$VER)"
  if [ "$MODE" = check ]; then exit 0; fi
  if [ "$MODE" != force ]; then
    log "refusing to re-seed. Re-run with --force only after confirming this standby is expendable."
    exit 0
  fi
  log "--force: DESTROYING the existing standby cluster in $VOLUME"
  docker run --rm -v "$VOLUME:/d" --entrypoint sh "$IMAGE" -c 'rm -rf /d/* /d/.[!.]*' >/dev/null
fi

[ "$MODE" = check ] && { log "volume $VOLUME is empty - ready to seed"; exit 0; }

# --- 4. ownership ---------------------------------------------------------
# Docker named volumes start root-owned. Postgres in this image runs as uid 70,
# and pg_basebackup must be able to create files here.
log "setting ownership on $VOLUME"
docker run --rm -v "$VOLUME:/d" --entrypoint sh "$IMAGE" -c 'chown 70:70 /d && chmod 700 /d'

# --- 5. base backup -------------------------------------------------------
# -X stream  -> ship the WAL the backup needs alongside it, so the result is
#               immediately consistent and does not need a separate wal archive.
# -S peer1   -> reserve WAL on the primary for the gap between this backup and
#               the standby starting. Without it the first start after any
#               primary restart fails with "requested WAL segment has already
#               been removed".
# -R         -> write standby.signal + a primary_conninfo into the data dir,
#               so the cluster comes up in recovery instead of as a new master.
log "pg_basebackup of $PRIMARY_HOST:$PRIMARY_PORT -> $VOLUME (this is ~223 MB)"
docker run --rm \
  --user 70:70 \
  -e PGPASSWORD="$REPLICATION_PASSWORD" \
  -v "$VOLUME:$MOUNT" \
  --entrypoint pg_basebackup \
  "$IMAGE" \
  -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPLICATION_USER" \
  -D "$MOUNT" -Fp -Xs -P -R -S "$SLOT"

# --- 6. pin primary_conninfo ---------------------------------------------
# -R drops the password out of primary_conninfo and into a passfile in the
# postgres user's HOME (/var/lib/postgresql), which is NOT the mounted volume -
# so the credential would evaporate the first time the container is recreated
# and the standby would silently stop replicating. Write it explicitly instead.
# postgresql.auto.conf is read last, so this overrides what -R wrote.
log "pin primary_conninfo (password included, mode 0600, inside the volume)"
CONF="$(mktemp)"
chmod 600 "$CONF"
cat > "$CONF" <<EOF
# Managed by deploy/peer-seed-standby.sh - do not edit by hand.
primary_conninfo = 'host=$PRIMARY_HOST port=$PRIMARY_PORT user=$REPLICATION_USER password=$REPLICATION_PASSWORD application_name=peer-standby'
primary_slot_name = '$SLOT'
EOF

# The bind mount lands OUTSIDE the volume (at /seed-auto.conf, i.e. the
# container's writable layer) so the secret is never left behind in a data
# directory that gets tarred into a backup.
docker run --rm \
  -v "$VOLUME:$MOUNT" \
  -v "$CONF:/seed-auto.conf:ro" \
  --entrypoint sh "$IMAGE" -c '
    cp /seed-auto.conf "'"$MOUNT"'/postgresql.auto.conf" &&
    chown 70:70 "'"$MOUNT"'/postgresql.auto.conf" &&
    chmod 600 "'"$MOUNT"'/postgresql.auto.conf" &&
    touch "'"$MOUNT"'/standby.signal" &&
    chown 70:70 "'"$MOUNT"'/standby.signal"
  '
rm -f "$CONF"

# --- 7. report ------------------------------------------------------------
log "seed complete. volume $VOLUME:"
docker run --rm -v "$VOLUME:/d" --entrypoint sh "$IMAGE" -c \
  'ls -A /d | head -30; echo "standby.signal: $(test -f /d/standby.signal && echo present || echo MISSING)"'
log "next: docker compose -f docker-compose.prod.yml -f deploy/docker-compose.peer.yml -f deploy/docker-compose.peer-replica.yml --env-file .env.production up -d data-dr redis"