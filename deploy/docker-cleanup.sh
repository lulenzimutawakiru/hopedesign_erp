#!/bin/bash
set -euo pipefail

echo "[$(date)] Starting Docker space reclamation..."
# Prune stopped containers, unused networks, and dangling/unused images
docker system prune -af --volumes --filter "until=168h"
echo "[$(date)] Docker cleanup completed successfully."o
