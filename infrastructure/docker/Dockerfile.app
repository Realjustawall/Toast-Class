ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /work
COPY package.json package-lock.json tsconfig*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN --mount=type=cache,target=/root/.npm npm ci
COPY apps/api/src apps/api/src
COPY packages packages
COPY apps/worker/src apps/worker/src
COPY scripts/migrate*.ts scripts/
COPY scripts/platform-admin.ts scripts/
COPY scripts/bootstrap-admin.ts scripts/
RUN npx tsc -p tsconfig.server.json
RUN npm prune --omit=dev --workspace=apps/api --workspace=apps/worker --include-workspace-root

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /opt/toaster
COPY --from=build /work/node_modules ./node_modules
COPY --from=build /work/build/server ./
COPY packages/database/migrations packages/database/migrations
COPY packages/database/mysql packages/database/mysql
COPY package.json LICENSE ./
RUN mkdir -p /var/lib/toaster/storage && chown node:node /var/lib/toaster/storage
USER node
CMD ["node", "apps/api/src/main.js"]
