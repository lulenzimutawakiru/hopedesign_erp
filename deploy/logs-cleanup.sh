#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/opt/hopedesign_erp/logs"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Truncating container logs and cleaning log directory..."
find /var/lib/docker/containers/ -type f -name "*-json.log" -exec truncate -s 0 {} + 2>/dev/null || true
find "$LOG_DIR" -type f -name "*.log" -mtime +14 -delete 2>/dev/null || true
