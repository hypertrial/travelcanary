FROM node:24.19.0-bookworm-slim AS base
RUN npm install --global npm@11.6.2

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/copy-maplibre-worker.mjs ./scripts/copy-maplibre-worker.mjs
RUN npm ci
COPY . .
ENV TRAVELCANARY_RUNTIME=local NEXT_PUBLIC_CATALOG_VERSION=3 NEXT_PUBLIC_DATA_MODE=live LOCAL_CONDITIONS_ENABLED=true
RUN npm run build

FROM base
ENV NODE_ENV=production TRAVELCANARY_RUNTIME=local TRAVELCANARY_DATA_DIR=/data NEXT_PUBLIC_CATALOG_VERSION=3 NEXT_PUBLIC_DATA_MODE=live LOCAL_CONDITIONS_ENABLED=true PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["npm", "run", "start:selfhost"]
