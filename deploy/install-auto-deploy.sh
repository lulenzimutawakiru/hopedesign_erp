#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP — INSTALL AUTO-DEPLOY CRON
#
#   sh deploy/install-auto-deploy.sh
#
# Idempotent: installs/replaces the auto-deploy cron line, keeps every other
# cron entry intact (the stack watchdog and tunnel-route lines included).
# After this runs once, every push to origin/main is rolled out by the
# blue/green watcher within ~2 minutes — no manual plink step.
#
# Pause without uninstalling:   touch deploy/auto-deploy.disabled
# Resume:                       rm deploy/auto-deploy.disabled
#############################################################
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
SCRIPT="$APP_DIR/deploy/auto-deploy.sh"
LOG_DIR="$APP_DIR/logs"
CRON_LINE="*/2 * * * * $SCRIPT >> $LOG_DIR/cron_autodeploy.log 2>&1"

[[ -x "$SCRIPT" ]] || chmod +x "$SCRIPT"
mkdir -p "$LOG_DIR"

TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -vF "deploy/auto-deploy.sh" > "$TMP" || true
printf '%s\n' "$CRON_LINE" >> "$TMP"
crontab "$TMP"
rm -f "$TMP"

echo "Installed auto-deploy cron:"
crontab -l | grep -F "auto-deploy" || true
