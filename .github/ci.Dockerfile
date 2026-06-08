# Pinned in package.json ("packageManager": "bun@<version>") and passed in by
# the ci-image workflow via --build-arg; the default keeps a standalone build sane.
ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}-debian AS bun
FROM mcr.microsoft.com/playwright:v1.60.0-noble

LABEL org.opencontainers.image.title="covcom/ci"
LABEL org.opencontainers.image.description="cicd e2e testing toolchain for the covcom chat app"
LABEL org.opencontainers.image.authors="https://github.com/xero/covcom/graphs/contributors"
LABEL org.opencontainers.image.documentation="https://github.com/xero/covcom/wiki"
LABEL org.opencontainers.image.url="https://github.com/xero/covcom/actions"
LABEL org.opencontainers.image.source="https://github.com/xero/covcom/blob/main/.github/ci.Dockerfile"
LABEL org.opencontainers.image.licenses="MIT"

# Pull the bun outta the oven
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV PATH="/root/.bun/bin:${PATH}"

# Install dependencies
RUN apt-get update && apt-get install -y curl unzip
RUN bun i -g playwright@1.60.0
RUN playwright install-deps && \
		playwright install chromium firefox webkit

# Webserver for e2e
RUN bun i -g serve

WORKDIR /app
# No CMD required for CI containers as all
# commands run are controlled by workflows
