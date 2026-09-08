#!/usr/bin/env bash
set -euo pipefail

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Pruning unused Docker containers, networks, and dangling images..."
docker system prune -f --volumes
