#!/usr/bin/env bash
set -euo pipefail

SSH_PORT="2978"
SSHD_DROPIN_DIR="/etc/ssh/sshd_config.d"
SSHD_DROPIN="$SSHD_DROPIN_DIR/10-hopedesign-hardening.conf"

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

# ---------------------------------------------------------------------------
# Retire the bootstrap-era port-22 allowance.
# vps-setup.sh opens 22/tcp defensively, before the custom SSH port is known.
# Once sshd listens *only* on $SSH_PORT that rule is dead weight and pure
# attack surface (ufw has nothing behind it to protect), so close it whenever
# nothing is actually listening on 22.
# ---------------------------------------------------------------------------
if [ "$SSH_PORT" != "22" ] && ! ss -lnt 2>/dev/null | awk '$4 ~ /:22$/ {found=1} END {exit !found}'; then
  for rule in '22/tcp' 'OpenSSH'; do
    ufw --force delete allow "$rule" >/dev/null 2>&1 || true
  done
  echo "Closed stale port 22/tcp allowance (sshd listens on $SSH_PORT only)."
fi

# ---------------------------------------------------------------------------
# sshd hardening.
# Drop-ins are Include'd from sshd_config line 12, and sshd uses the FIRST
# value obtained for any keyword. This file therefore MUST sort before the
# cloud-init drop-in (50-cloud-init.conf ships `PasswordAuthentication yes`),
# which is why it is numbered 10- and not 99-.
# ---------------------------------------------------------------------------
echo "Hardening sshd..."
mkdir -p "$SSHD_DROPIN_DIR"

SSHD_BACKUP=""
if [ -f "$SSHD_DROPIN" ]; then
  SSHD_BACKUP="$(mktemp)"
  cp -p "$SSHD_DROPIN" "$SSHD_BACKUP"
fi

cat > "$SSHD_DROPIN" <<'EOF'
# Managed by deploy/security-hardening.sh - do not edit by hand.
# Numbered 10- so it is read before 50-cloud-init.conf (first value wins).
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 30
EOF
chmod 600 "$SSHD_DROPIN"

# Never restart sshd on an unparseable config - that is how you lock yourself
# out of a remote box. Validate first, and revert on failure.
if ! sshd -t 2>/dev/null; then
  echo "ERROR: resulting sshd config is invalid; reverting drop-in." >&2
  if [ -n "$SSHD_BACKUP" ]; then
    cp -p "$SSHD_BACKUP" "$SSHD_DROPIN"
  else
    rm -f "$SSHD_DROPIN"
  fi
  exit 1
fi

# sshd honours config changes on new connections only, so established sessions
# survive this restart. Ubuntu 24.04 is socket-activated, so ssh.socket must be
# restarted as well or the listener keeps the old config.
systemctl restart ssh 2>/dev/null || true
if systemctl is-active --quiet ssh.socket 2>/dev/null; then
  systemctl restart ssh.socket
fi
[ -n "$SSHD_BACKUP" ] && rm -f "$SSHD_BACKUP"

echo
echo "Effective sshd settings:"
sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication|x11forwarding|maxauthtries|logingracetime)' | sed 's/^/  /'

echo
echo "UFW Firewall Status:"
ufw status verbose
