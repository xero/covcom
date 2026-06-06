#!/bin/sh
set -e

if [ -z "$DOMAIN" ]; then
	echo "ERROR: DOMAIN env var is required" >&2
	exit 1
fi

# For localhost (and any address with an explicit port), force HTTP-only so
# Caddy does not attempt TLS certificate provisioning.
case "$DOMAIN" in
	localhost|localhost:*|127.0.0.1|127.0.0.1:*)
		SITE_ADDR="http://${DOMAIN}"
		;;
	*)
		SITE_ADDR="${DOMAIN}"
		;;
esac

cat > /etc/caddy/Caddyfile <<EOF
${SITE_ADDR} {
	# Clickjacking protection: frame-ancestors is ignored in the SPA's <meta>
	# CSP, so enforce the equivalent as a real response header here.
	header X-Frame-Options "DENY"
	@ws path /ws
	handle @ws {
		reverse_proxy localhost:${PORT:-3000}
	}
	handle {
		root * /app/web/dist
		file_server
		try_files {path} /index.html
	}
}
EOF

caddy run --config /etc/caddy/Caddyfile &

exec bun run /app/server/src/index.ts
