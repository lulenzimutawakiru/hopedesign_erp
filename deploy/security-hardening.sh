#!/usr/bin/env bash
set -euo pipefail

SSH_PORT="2978"

echo "================================="
echo " FIREWALL & SECURITY HARDENING"
echo "================================="

echo "Configuring UFW Firewall..."
ufw default deny incoming
ufw default allow outgoing

# Allow custom SSH port
ufw allow "$SSH_PORT"/tcp comment "Custom SSH"

# Allow Web traffic
ufw allow 80/tcp comment "Caddy HTTP"
ufw allow 443/tcp comment "Caddy HTTPS"

echo "Enabling UFW..."
ufw --force enable

echo "UFW Firewall Status:"
ufw status verbose
