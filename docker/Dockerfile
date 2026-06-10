# build stage: web client
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

# Copy source (web/build.ts imports the shared codegen from scripts/)
COPY lib/ ./lib/
COPY web/ ./web/
COPY scripts/ ./scripts/

# Build web client (single inlined index.html, strict-CSP friendly)
RUN bun run --cwd web build

# final image
FROM caddy:2-alpine AS caddy
FROM oven/bun:1

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
RUN mkdir -p /etc/caddy /data /config
# Point Caddy's storage at the mounted volumes so ACME certs/account survive
# restarts (the official caddy image sets these; the bun base does not).
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
WORKDIR /app

# Server + its workspace dependency (@covcom/lib -> leviathan-crypto).
# Install from the workspace root with every workspace manifest present so the
# frozen lockfile validates; --production drops devDeps (no vite/eslint/playwright
# leak into the runtime image).
COPY package.json bun.lock* ./
COPY lib/package.json ./lib/
COPY web/package.json ./web/
COPY cli/package.json ./cli/
COPY server/package.json ./server/
RUN bun i --production --frozen-lockfile --ignore-scripts
COPY lib/ ./lib/
COPY server/ ./server/

# Web client dist (built in stage 1)
COPY --from=builder /build/web/dist ./web/dist/

COPY docker/entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 443 80

ENTRYPOINT ["./entrypoint.sh"]
