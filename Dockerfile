FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
RUN npm install --global npm@11.6.2

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/copy-maplibre-worker.mjs ./scripts/copy-maplibre-worker.mjs
RUN npm ci
COPY . .
ENV TRAVELCANARY_RUNTIME=local LOCAL_CONDITIONS_ENABLED=true
RUN npm run build

FROM base
ENV NODE_ENV=production TRAVELCANARY_RUNTIME=local TRAVELCANARY_PRIVATE_DATA_DIR=/data/private TRAVELCANARY_PUBLIC_DATA_DIR=/data/public TRAVELCANARY_CACHE_DIR=/data/cache LOCAL_CONDITIONS_ENABLED=true PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/private /data/public /data/cache && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["npm", "run", "start:container"]
