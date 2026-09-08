#!/bin/sh
set -eu

# Ensure a valid active API target exists before Caddy parses the Caddyfile.
# deploy/zero-downtime-deploy.sh and deploy/stack-watchdog.sh maintain this
# file (gitignored). First boot defaults to the api-a color.
mkdir -p /etc/caddy/live
if [ ! -s /etc/caddy/live/active.caddy ]; then
	cat > /etc/caddy/live/active.caddy <<'EOF'
reverse_proxy api-a:4000 {
	import /etc/caddy/live/options.caddy
}
EOF
fi

exec "$@"