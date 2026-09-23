FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY backend ./backend
COPY collector ./collector
COPY web ./web
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production \
    PORT=8787 \
    VIBESCORE_DATA_DIR=/data

WORKDIR /app

# Litestream replicates the SQLite file to S3-compatible storage (e.g. Backblaze B2)
# so data survives Render free-tier restarts, which have no persistent disk.
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL -o /tmp/litestream.tar.gz \
       "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
    && echo "${LITESTREAM_SHA256}  /tmp/litestream.tar.gz" | sha256sum -c - \
    && tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz litestream \
    && rm /tmp/litestream.tar.gz \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/backend ./backend
COPY --from=build /app/collector ./collector
COPY --from=build /app/web ./web
COPY --from=build /app/scripts ./scripts
COPY litestream.yml ./litestream.yml
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data \
    && chown -R node:node /app /data \
    && chmod +x /usr/local/bin/docker-entrypoint.sh
USER node

EXPOSE 8787

ENTRYPOINT ["docker-entrypoint.sh"]
