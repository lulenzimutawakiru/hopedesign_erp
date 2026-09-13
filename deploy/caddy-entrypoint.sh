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

# Optional public site for the availability monitor.
#
# Gated on KUMA_DOMAIN rather than always-on because ACME can only issue for a
# name that already resolves to this host: emitting the block before the DNS
# record exists would make Caddy fail validation forever and log an error on
# every retry. Left unset (the default) the monitor stays tunnel-only; set it
# once the A record is live and the next reload publishes it over TLS.
if [ -n "${KUMA_DOMAIN:-}" ]; then
	cat > /etc/caddy/live/uptime.caddy <<EOF
${KUMA_DOMAIN} {
	encode gzip zstd

	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}

	@https protocol https
	header @https Strict-Transport-Security "max-age=15552000; includeSubDomains"

	# Kuma keeps its own login; Caddy only terminates TLS in front of it.
	# X-Frame-Options is deliberately not set here because Kuma renders parts
	# of its own dashboard in frames.
	reverse_proxy uptime-kuma:3001
}
EOF
	echo "[caddy] uptime-kuma site enabled for ${KUMA_DOMAIN}"
else
	echo "# uptime-kuma site disabled: KUMA_DOMAIN unset" > /etc/caddy/live/uptime.caddy
fi

exec "$@"