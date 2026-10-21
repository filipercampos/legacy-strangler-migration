# syntax=docker/dockerfile:1.7

# One image, several processes: the ECS task definition picks the command
#   node dist/gateway/main.js | dist/billing/main.js | dist/sync/main.js <cdc|backfill|reverse|parity>
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3400 3402
# tini forwards SIGTERM so Nest shutdown hooks run and the sync loop finishes its batch.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/gateway/main.js"]
