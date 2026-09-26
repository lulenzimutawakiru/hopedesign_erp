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

# Tunnel ingress routes get their own, weekly, line. deploy/tunnel-ingress.sh
# reconciles the whole hostname -> origin table in deploy/tunnel-routes.txt, and
# in api mode that reconcile is a PUT of the entire rule set. Running it from
# the watchdog's */2 line would issue ~720 writes a day to change a table that
# moves a handful of times a year, so it runs once a week instead: enough to
# heal a node that was rebuilt or restored from backup, and a no-op (one GET
# and a compare) whenever the routes already match.
# --only-if-configured makes a node that was never given
# deploy/tunnel-ingress.env exit 0 in silence rather than log and email a
# misconfiguration it does not have.
TUNNEL_SCRIPT="$APP_DIR/deploy/tunnel-ingress.sh"
TUNNEL_CRON_LINE="17 4 * * 0 $TUNNEL_SCRIPT --only-if-configured >> $LOG_DIR/cron_tunnel.log 2>&1"

[[ -x "$SCRIPT" ]] || chmod +x "$SCRIPT"
mkdir -p "$LOG_DIR"

TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -vF "deploy/stack-watchdog.sh" | grep -vF "deploy/tunnel-ingress.sh" > "$TMP" || true
printf '%s\n' "$CRON_LINE" >> "$TMP"

# Only schedule the tunnel line on a host that actually has the script, so a
# node still mid-setup does not mail a bash "no such file" every Sunday.
if [[ -f "$TUNNEL_SCRIPT" ]]; then
  [[ -x "$TUNNEL_SCRIPT" ]] || chmod +x "$TUNNEL_SCRIPT"
  printf '%s\n' "$TUNNEL_CRON_LINE" >> "$TMP"
fi

crontab "$TMP"
rm -f "$TMP"

echo "Installed watchdog cron:"
crontab -l | grep -F "stack-watchdog" || true
echo "Installed tunnel-route cron:"
crontab -l | grep -F "tunnel-ingress" || echo "  (skipped - $TUNNEL_SCRIPT is not present on this host)"
