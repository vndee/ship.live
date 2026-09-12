# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/src ./src

ARG RELEASE_VERSION
ARG VCS_REVISION
ARG SCHEMA_VERSION
ARG MAX_SCHEMA_VERSION
ARG TESTED_PREDECESSOR
LABEL org.opencontainers.image.source="https://github.com/vndee/ship.live" \
      org.opencontainers.image.revision="$VCS_REVISION" \
      org.opencontainers.image.version="$RELEASE_VERSION" \
      io.ship-live.schema-version="$SCHEMA_VERSION" \
      io.ship-live.max-schema-version="$MAX_SCHEMA_VERSION" \
      io.ship-live.tested-predecessor="$TESTED_PREDECESSOR"

USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
