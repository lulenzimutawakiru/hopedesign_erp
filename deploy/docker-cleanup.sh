#!/usr/bin/env bash
#
# Weekly Docker garbage collection.
#
# Deliberately NOT `docker system prune --volumes`, which is what this used to
# be. Three reasons, all specific to how this stack is deployed:
#
#   * `--volumes` deletes anonymous volumes. Every volume in this stack is
#     named, so today that would be a no-op - but it is one accidental unnamed
#     volume away from destroying data, and nothing here needs it.
#   * A bare `docker system prune` also removes every STOPPED container. The
#     blue/green rollout deliberately leaves the previous API color running so
#     a rollback is instant, so stopped containers are left alone.
#   * It drops the whole build cache. The rollback path rebuilds from that
#     cache, and a cold rebuild on this 1-vCPU box takes minutes - exactly when
#     a rollback needs to be fast. The cache is bounded instead of cleared.
#
# Images in use by any container (running or stopped) are never removed -
# `docker image prune` skips them - which is what keeps the idle blue/green
# color's image around for an instant rollback.
set -euo pipefail

LOG_TS="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

echo "[$LOG_TS] Docker garbage collection starting..."

# Dangling (untagged, unreferenced) images only. Tagged images that are simply
# not running - the idle API color's, for instance - are kept.
echo "[$LOG_TS] removing dangling images..."
docker image prune -f

# Bound the build cache rather than deleting it, so a rollback rebuild stays
# warm. 2 GB is comfortably under the ~38 GB free on this host.
echo "[$LOG_TS] trimming build cache to 2GB..."
docker builder prune -f --reserved-space 2GB

# Networks no container is attached to. The compose `internal` bridge is in
# use, so it is never touched.
echo "[$LOG_TS] removing unused networks..."
docker network prune -f

echo "[$LOG_TS] Docker garbage collection complete."
docker system df