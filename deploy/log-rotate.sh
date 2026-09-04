#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="/opt/hopedesign_erp/logs"

echo "================================="
echo " LOG ROTATION & CLEANUP"
echo "================================="

echo "Truncating Docker container log files..."
CONTAINER_LOGS=$(find /var/lib/docker/containers/ -type f -name "*-json.log" 2>/dev/null || true)
for log in $CONTAINER_LOGS; do
  echo "Truncating $log"
  truncate -s 0 "$log"
done

echo "Cleaning application logs older than 14 days in $LOG_DIR..."
find "$LOG_DIR" -type f -name "*.log" -mtime +14 -exec rm -f {} \;

echo "Current disk usage of log directory:"
du -sh "$LOG_DIR"
