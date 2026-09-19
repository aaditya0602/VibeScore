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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/backend ./backend
COPY --from=build /app/collector ./collector
COPY --from=build /app/web ./web
COPY --from=build /app/scripts ./scripts

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "backend/src/server.ts"]
