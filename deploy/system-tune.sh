#!/usr/bin/env bash
#############################################################
# HOPE DESIGN ERP — HOST PERFORMANCE/RELIABILITY TUNING
#
#   sh deploy/system-tune.sh
#
# Idempotent kernel/network tuning suitable for a single-node
# Docker ERP host (web + API replicas + Postgres). Safe to re-run.
#############################################################
set -euo pipefail

if [[ "$(id -u)" != "0" ]]; then
  echo "ERROR: run as root" >&2
  exit 1
fi

CONF=/etc/sysctl.d/99-hopedesign-erp.conf

cat > "$CONF" <<'EOF'
# Hope Design ERP host tuning — single-node Docker + Postgres.
vm.swappiness=10
vm.dirty_ratio=15
vm.dirty_background_ratio=5
net.core.somaxconn=1024
net.ipv4.ip_local_port_range=1024 65535
net.ipv4.tcp_max_syn_backlog=2048
net.ipv4.tcp_tw_reuse=1
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_keepalive_time=60
net.ipv4.tcp_keepalive_intvl=10
net.ipv4.tcp_keepalive_probes=6
fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=1024
EOF

sysctl --system >/dev/null

echo "Applied $CONF:"
sysctl vm.swappiness net.core.somaxconn net.ipv4.ip_local_port_range net.ipv4.tcp_fin_timeout 2>/dev/null
