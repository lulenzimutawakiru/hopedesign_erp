#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP — INSTALL STACK WATCHDOG CRON
#
#   sh deploy/install-watchdog.sh
#
# Idempotent: installs/replaces the watchdog cron line, keeps every other
# cron entry intact.
#############################################################
set -euo pipefail

APP_DIR="/opt/hopedesign_erp"
SCRIPT="$APP_DIR/deploy/stack-watchdog.sh"
LOG_DIR="$APP_DIR/logs"
CRON_LINE="*/2 * * * * $SCRIPT >> $LOG_DIR/cron_watchdog.log 2>&1"

[[ -x "$SCRIPT" ]] || chmod +x "$SCRIPT"
mkdir -p "$LOG_DIR"

TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -vF "deploy/stack-watchdog.sh" > "$TMP" || true
printf '%s\n' "$CRON_LINE" >> "$TMP"
crontab "$TMP"
rm -f "$TMP"

echo "Installed watchdog cron:"
crontab -l | grep -F "stack-watchdog" || true
