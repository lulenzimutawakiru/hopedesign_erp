#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="/opt/hopedesign_erp/logs/system-patch.log"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting automated OS security patch..." | tee -a "$LOG_FILE"

# 1. Check pre-patch ERP stack state
echo "Verifying ERP health before patching..." | tee -a "$LOG_FILE"
/opt/hopedesign_erp/deploy/health-check.sh || { echo "Aborting patch: ERP stack unhealthy."; exit 1; }

# 2. Run security upgrades
echo "Applying Ubuntu security updates..." | tee -a "$LOG_FILE"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y --only-upgrade -qq >> "$LOG_FILE" 2>&1

# 3. Clean package cache
apt-get autoremove -y -qq
apt-get clean -qq

# 4. Verify post-patch ERP stack state
echo "Verifying ERP health after patching..." | tee -a "$LOG_FILE"
if ! /opt/hopedesign_erp/deploy/health-check.sh; then
  echo "WARNING: Stack unhealthy post-patch. Attempting automatic stack restart..." | tee -a "$LOG_FILE"
  docker compose -f /opt/hopedesign_erp/docker-compose.yml restart
  sleep 10
  /opt/hopedesign_erp/deploy/health-check.sh
fi

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] System security patching finished." | tee -a "$LOG_FILE"
