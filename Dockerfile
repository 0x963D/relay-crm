FROM node:24.14.0-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN npm install --global pnpm@11.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/package.json
COPY packages/store/package.json packages/store/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate && pnpm build

FROM build AS maintenance
ENV NODE_ENV=production
USER node
CMD ["node", "--import", "tsx", "apps/web/scripts/demo-resetter.ts"]

FROM base AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/scripts/demo-start.ts ./apps/web/scripts/demo-start.ts
COPY --from=build --chown=node:node /app/apps/web/src/server/client-address.ts /app/apps/web/src/server/connection-context.ts /app/apps/web/src/server/env-file.ts ./apps/web/src/server/
USER node
CMD ["node", "apps/web/scripts/demo-start.ts"]
