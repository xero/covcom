# ── Stage 1: build web client ──────────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /build

# Install workspace dependencies needed for the web build.
COPY package.json bun.lock* ./
COPY lib/package.json ./lib/
COPY web/package.json ./web/
COPY server/package.json ./server/

# Stub cli so bun workspace resolution succeeds without installing cli's devDeps
RUN mkdir -p cli && echo '{"name":"@covcom/cli","private":true}' > cli/package.json
RUN bun i --ignore-scripts

# Copy source
COPY lib/ ./lib/
COPY web/ ./web/

# Build web clinet
RUN bun run --cwd web build

# ── Stage 2: final image ───────────────────────────────────────────────────
FROM caddy:2-alpine AS covcom
FROM oven/bun:1

# Setup
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
RUN mkdir -p /etc/caddy /data /config
WORKDIR /app

# Server
COPY server/package.json server/bun.lock* ./server/
RUN cd server && bun i --frozen-lockfile
COPY server/ ./server/

# Web client dist (built in stage 1)
COPY --from=builder /build/web/dist ./web/dist/

# Entrypoint
COPY docker/entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Open Ports
EXPOSE 443 80

ENTRYPOINT ["./entrypoint.sh"]
