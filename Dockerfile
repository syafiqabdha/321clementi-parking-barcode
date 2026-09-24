# 321 Clementi Parking Barcode — production image
#
# Deliberately no `# syntax=docker/dockerfile:1` directive and no BuildKit-only
# features (RUN --mount, heredocs), so the image builds on hosts that only ship
# the classic builder — e.g. `DOCKER_BUILDKIT=0 docker build`.

# Runtime is Bun, not Node:
#   * src/db/connection.ts uses Bun's built-in SQL client (`require('bun')`),
#     which cannot resolve on Node.
#   * scripts/migrate.ts imports `SQL` from 'bun'. Running the migration runner
#     from this same image is what keeps the applied schema and the app runtime
#     from drifting apart.
#
# Build produces a self-contained Astro SSR server (dist/server/entry.mjs) via
# the @astrojs/node standalone adapter — see DEPLOY_TARGET in astro.config.mjs.
# ---------------------------------------------------------------------------

ARG BUN_IMAGE=oven/bun:1.3.13-alpine

FROM ${BUN_IMAGE} AS base
WORKDIR /app
ENV CI=1

# --- dependency layers (cached unless the lockfile changes) -----------------
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS prod-deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
# DEPLOY_TARGET selects the Astro adapter (node standalone → dist/server).
# ALLOWED_SITE_DOMAINS is baked in because Astro's CSRF origin allowlist is
# evaluated at build time — rebuild to change it.
ENV DEPLOY_TARGET=node \
    NODE_ENV=production
ARG ALLOWED_SITE_DOMAINS=""
ENV ALLOWED_SITE_DOMAINS=${ALLOWED_SITE_DOMAINS}
RUN bun run build

# --- runtime ----------------------------------------------------------------
FROM base AS runtime
LABEL org.opencontainers.image.title="321clementi-parking-barcode" \
      org.opencontainers.image.description="321 Clementi receipt-to-barcode parking redemption portal (Astro SSR on Bun)" \
      org.opencontainers.image.source="https://github.com/syafiqabdha/321clementi-parking-barcode"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY --from=build /app/dist ./dist
# Migrations + runner ship in the image so `docker compose run --rm web bun run
# db:migrate` applies exactly the schema this build was compiled against.
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts

USER bun
EXPOSE 4321

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:${PORT}/ || exit 1

CMD ["bun", "./dist/server/entry.mjs"]
