#!/bin/sh
# AccuWeb Linux VPS bootstrap: Docker Engine + Compose plugin + firewall.
# Run as root on Ubuntu/Debian (most AccuWeb Linux VPS images):
#   curl -fsSL … | sh    OR   sudo sh deploy/vps-setup.sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo sh deploy/vps-setup.sh)" >&2
  exit 1
fi

. /etc/os-release
echo "[vps] OS=$ID $VERSION_ID"

export DEBIAN_FRONTEND=noninteractive

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg ufw
  if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/$ID/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
elif command -v dnf >/dev/null 2>&1; then
  dnf -y install dnf-plugins-core curl
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo || true
  dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "Unsupported distro. Install Docker CE manually, then re-run compose." >&2
  exit 1
fi

systemctl enable --now docker

# AccuWeb images sometimes ship Apache/nginx on 80/443. Docker Caddy needs those ports.
# Stop each unit on its own — a missing apache2/httpd must not skip nginx.
for svc in apache2 nginx httpd; do
  systemctl disable --now "$svc" 2>/dev/null || true
done

# AccuWeb often moves SSH off 22 (this host uses 2978). Opening only 22 would lock us out.
SSH_PORT="$(awk '/^[Pp]ort[[:space:]]+[0-9]+/{print $2}' /etc/ssh/sshd_config 2>/dev/null | tail -1)"
if [ -z "$SSH_PORT" ] && [ -d /etc/ssh/sshd_config.d ]; then
  SSH_PORT="$(awk '/^[Pp]ort[[:space:]]+[0-9]+/{print $2}' /etc/ssh/sshd_config.d/*.conf 2>/dev/null | tail -1)"
fi
if [ -z "$SSH_PORT" ]; then
  SSH_PORT="$(ss -tlnp 2>/dev/null | awk '/sshd/{print $4}' | sed 's/.*://' | head -1)"
fi
SSH_PORT="${SSH_PORT:-22}"

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH || true
  ufw allow 22/tcp
  if [ "$SSH_PORT" != "22" ]; then
    ufw allow "${SSH_PORT}/tcp"
  fi
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw --force enable || true
  ufw status
fi

docker --version
docker compose version
echo "[vps] Docker is ready. Next:"
echo "  1. Point your domain A record at this VPS public IP"
echo "  2. cd into the app directory"
echo "  3. node deploy/generate-env.mjs --domain hopedesign.jorlentech.com --email admin@hopedesign.jorlentech.com --seed"
echo "  4. docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build"
