# Coolify Deployment Runbook — 321 Clementi Parking Barcode

- **Issue:** PAN-109
- **Target:** self-hosted Coolify, Docker Compose runtime, PostgreSQL 16, NocoDB admin UI
- **Blast radius:** every command below is intended to be run **manually by the systems
  architect**. Nothing in this repository touches live Coolify infrastructure on its own.
- **Host-specific facts for ewsvr-ubuntu — read §7 first.**

## 1. What ships

| Path | Purpose |
|---|---|
| `Dockerfile` | Multi-stage Bun image. Builds the Astro SSR bundle (`@astrojs/node` standalone) and runs `dist/server/entry.mjs`. |
| `docker-compose.yml` | `web` + `db` (PostgreSQL 16) + `nocodb` (optional profile). |
| `docker-compose.verify.yml` | Verification overlay only. **Never deploy this file.** |
| `scripts/verify-container-stack.mjs` | Boots the real stack and drives a full receipt→barcode redemption. |
| `scripts/nocodb-db-roles.sql` | Least-privilege `mall_operations` database role for NocoDB. |
| `scripts/deploy-nocodb-config.sh` | Real NocoDB + privilege verification (see §4). |
| `scripts/postgres-init/10-nocodb-meta.sql` | First-boot creation of the `nocodb_meta` database. |

Runtime is **Bun**, not Node: `src/db/connection.ts` uses Bun's built-in SQL client and
`scripts/migrate.ts` imports `SQL` from `bun`. Shipping the migration runner inside the
same image is deliberate — the applied schema can never drift from the code that reads it.

## 2. Pre-flight

1. **Generate secrets** (never commit them; set them in Coolify → Environment):
   ```bash
   openssl rand -hex 32   # PLATE_HMAC_SECRET   (PDPA HMAC pepper)
   openssl rand -hex 32   # ADMIN_API_KEY       (/api/v1/admin/shops)
   openssl rand -hex 32   # NC_AUTH_JWT_SECRET  (NocoDB session tokens)
   openssl rand -hex 24   # MALL_OPS_DB_PASSWORD (NocoDB data-source role)
   ```
2. **Set `ALLOWED_SITE_DOMAINS`** to every hostname the portal is served from, comma
   separated, no scheme — e.g. `321clementi.pancatz.com`. This is a **build-time** value:
   Astro evaluates its CSRF origin allowlist during `bun run build`, so changing it
   requires a rebuild. Omitting the real hostname makes every form POST fail with
   `403 Cross-site POST form submissions are forbidden`.
3. **Leave `WEB_HOST_PORT` unset on Coolify.** Publishing a host port bypasses Traefik and
   the Cloudflare Tunnel; let the Coolify proxy own ingress for the assigned domain
   (Cloudflare Tunnel → Coolify/Traefik → `web:4321`).
4. **Cloudflare Tunnel and client IPs:** `getClientIp()` prefers `cf-connecting-ip`, which
   Cloudflare sets on every proxied request, so the 3-per-5-minute rate limiter buckets
   real shoppers. Only if that header is absent does it fall back to the rightmost
   `x-forwarded-for` entry — which is Traefik's own address, collapsing every shopper into
   one bucket. Keep the app behind the Cloudflare Tunnel, and verify the header before
   opening a promotion window.

## 3. Deploy

```bash
# 1. Build + start the database
docker compose up -d db
docker compose exec db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# 2. Apply migrations 0001–0005 from inside the runtime image
docker compose run --rm web bun run db:migrate
docker compose run --rm web bun run db:status      # expect 5 APPLIED / 0 PENDING

# 3. Post-migration hardening (idempotent, safe to re-run)
# 0004 adds the 10-digit voucher CHECK constraint as NOT VALID so it does not scan a
# large pool at migration time. Validate it once legacy rows are clean:
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'ALTER TABLE voucher_pool VALIDATE CONSTRAINT ck_voucher_pool_voucher_code_numeric_10;'

# 4. Least-privilege role for the NocoDB data source
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v mall_ops_password="$MALL_OPS_DB_PASSWORD" \
  -v mall_ops_db="$POSTGRES_DB" \
  -f - < scripts/nocodb-db-roles.sql

# 5. Start the application
docker compose up -d web
docker compose ps      # web must report (healthy)
```

### Rollback

```bash
docker compose run --rm web bun run db:rollback    # reverts the single latest migration
docker compose up -d --force-recreate web          # or pin IMAGE_TAG to the previous build
```

Verified behaviour of `db:rollback` on `0005`:

- `scripts/migrate.ts` runs each migration inside `sql.begin(...)`, so a failing rollback
  is **atomic** — `schema_migrations` still records 0005 and no column is left half-altered.
  Confirmed: with two plate-less redemptions on the same day, the rollback aborts on
  `could not create unique index "uq_redemption_vehicle_daily" … (SG-UNKNOWN, <date>) is
  duplicated` and the database is unchanged.
- The `0005` down migration backfills NULL plates with the single placeholder
  `SG-UNKNOWN`, then recreates a UNIQUE index on `(vehicle_plate, receipt_date)`. Any two
  same-day plate-less redemptions therefore make 0005 un-rollbackable until those rows are
  reconciled. Treat 0005 as forward-only once plate-less redemptions exist in volume.

## 4. NocoDB connection parameters and table linkage

| Setting | Value |
|---|---|
| NocoDB metadata store (`NC_DB`) | `pg://db:5432?u=$POSTGRES_USER&p=$POSTGRES_PASSWORD&d=nocodb_meta` |
| Data source (the application DB) | host `db`, port `5432`, database `$POSTGRES_DB`, schema `public` |
| Data source role | `mall_operations` — **not** `POSTGRES_USER` |
| `NC_ALLOW_LOCAL_EXTERNAL_DBS` | `true` (required: the data source is on the private compose network) |
| `NC_SITE_URL` | `https://nocodb.pancatz.com` |
| `NC_AUTH_JWT_SECRET` | required, `openssl rand -hex 32` |
| Tables to link | `shops`, `voucher_pool`, `redemption_logs` |

`nocodb_meta` is a **separate database** on the same PostgreSQL 16 instance. Pointed at the
application database, NocoDB materialises ~140 `nc_*` tables plus `xc_knex_migrationsv0`
into `public`, mixed in with the redemption tables, listed as linked tables, and carried in
every `pg_dump` of production data. If NocoDB was ever pointed at the application database:

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  DO \$\$ DECLARE r RECORD; BEGIN
    FOR r IN SELECT tablename FROM pg_tables
             WHERE schemaname='public' AND (tablename LIKE 'nc\_%' OR tablename LIKE 'xc\_knex%')
    LOOP EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename); END LOOP;
  END \$\$;"
```

### Linking the tables

The NocoDB instance runs as `mall_operations`, so it can only see the four application
tables — everything else in the schema is invisible to it.

1. Sign in to NocoDB and create a base named **321 Clementi Mall Management**.
2. Add a data source of type PostgreSQL with the parameters above, credentials
   `mall_operations` / `$MALL_OPS_DB_PASSWORD`, schema `public`.
3. NocoDB introspects the source; `shops`, `voucher_pool` and `redemption_logs` are
   auto-linked. Confirm with:
   ```bash
   NOCODB_URL=https://nocodb.pancatz.com XC_TOKEN=<token> \
   MALL_OPS_DATABASE_URL=postgresql://mall_operations:$MALL_OPS_DB_PASSWORD@db:5432/$POSTGRES_DB \
     ./scripts/deploy-nocodb-config.sh
   ```

### Why the permissions live in PostgreSQL, not NocoDB

NocoDB CE has table-level permissions but no column-level write denial, so it cannot stop a
mall-management user — or a leaked NocoDB data-source credential — from rewriting
`vehicle_plate_hash`, flipping a voucher `status`, or editing a redemption row. PostgreSQL
column privileges can, so `scripts/nocodb-db-roles.sql` grants:

- `SELECT` on `shops`, `voucher_pool`, `redemption_logs`, `redemption_audit_logs`
- `INSERT/UPDATE/DELETE` on `shops`, with UPDATE restricted to the ticket-deck columns
- `INSERT (voucher_code, barcode_format, status, batch_id)` on `voucher_pool` — CSV batch
  intake can add inventory but cannot pre-set `vehicle_plate_hash`, `allocated_at` or
  `redeemed_at`
- no `UPDATE`/`DELETE` on `voucher_pool`, `redemption_logs` or `redemption_audit_logs`

Verified end to end through the NocoDB API on NocoDB 2026.09.0: creating a voucher row
succeeds, while flipping its `status` and writing `vehicle_plate_hash` both fail with
`ERR_DATABASE_OP_FAILED` / SQLSTATE `42501`.

## 5. Verification

```bash
# Full stack: builds the image, boots PostgreSQL 16 + web, applies migrations,
# then drives a real receipt -> voucher -> barcode redemption and a duplicate rejection.
bun scripts/verify-container-stack.mjs

# NocoDB integration + least-privilege negative tests (see script header for env vars)
NOCODB_URL=https://nocodb.pancatz.com \
XC_TOKEN=<nocodb-api-token> \
MALL_OPS_DATABASE_URL=postgresql://mall_operations:$MALL_OPS_DB_PASSWORD@db:5432/$POSTGRES_DB \
  ./scripts/deploy-nocodb-config.sh

# Application test suite (unchanged, must stay green)
bun install --frozen-lockfile && bun run typecheck && bun test
```

`scripts/deploy-nocodb-config.sh` exits non-zero on any failed check. It runs every database
probe inside `BEGIN … ROLLBACK`, so it is idempotent and leaves no probe voucher in the live
pool.

## 6. Known caveats

- **Turnstile fails closed.** With `CLOUDFLARE_TURNSTILE_SECRET_KEY` unset in production,
  every redemption is rejected with `BOT_CHALLENGE_FAILED`. Set both Turnstile keys.
- **Prerender regression guard.** If `output: 'server'` or the adapter is ever removed from
  `astro.config.mjs`, `astro build` silently prerenders the API routes and ships empty
  response bodies. `scripts/verify-container-stack.mjs` fails loudly on that.
- **`db:status` prints a localised date string** (`Thu Sep 24 2026 … (Malaysia Time)`) rather
  than ISO-8601, because the runner interpolates the driver's `Date` object directly. Cosmetic.
- **BuildKit.** This host has no `docker buildx`; the Dockerfile intentionally avoids
  BuildKit-only syntax so `DOCKER_BUILDKIT=0 docker build .` works. `docker compose build`
  needs BuildKit — use `docker build` on such a host.

## 7. Live execution on ewsvr-ubuntu — verified host facts

Read this before running §3. Everything below was observed read-only on the target host
(10.1.0.99 / Tailscale 100.67.166.37) on 2026-09-24; no live resource was created, modified
or restarted.

### 7.1 What already runs there

| Container | Image | Role |
|---|---|---|
| `coolify` / `coolify-db` / `coolify-redis` / `coolify-realtime` / `coolify-sentinel` | — | Coolify control plane, UI on `localhost:8000` |
| `coolify-proxy` | Coolify Traefik | Public ingress on `:80` / `:443` / `:8080` |
| `cloudflared-i8lsm19arq8z3g2lnpwi8nhx` | `cloudflare/cloudflared:latest` | Cloudflare Tunnel terminating into Traefik |
| `nocodb-fbvelpdaf5kwl9im9qyr4i4u` | `nocodb/nocodb` | **Existing** NocoDB — Coolify service `nocodb`, project `main`, alias `nocodb`, served at `https://nocodb.pancatz.com` (HTTP 200) |
| `n8n-ynerrvhzq9y5gmgnagzld6j8` | `n8nio/n8n` | Existing n8n — service `n8n`, project `main`, alias `n8n`, `https://n8n.pancatz.com` (HTTP 200) |
| `postgresql-ynerrvhzq9y5gmgnagzld6j8` | `postgres:17-alpine` (17.11) | **n8n's own database** (`POSTGRES_DB=n8n`) |

**Do not reuse `postgresql-…` for this application.** It is PostgreSQL **17** and carries
n8n's data. The issue calls for a dedicated PostgreSQL 16 container, which is what the `db`
service in `docker-compose.yml` provides.

**Do not start a second NocoDB.** The `nocodb` profile in `docker-compose.yml` is for hosts
without one. Here, point the existing Coolify service at the new database instead (§4).

### 7.2 The application hostname does not exist yet

`321clementi.pancatz.com` does not resolve, and no tunnel hostname currently answers for it.
**Decide the production hostname before building the image** — `ALLOWED_SITE_DOMAINS` is
evaluated at build time, so a hostname chosen afterwards forces a rebuild. Then add the
Cloudflare Tunnel hostname → Coolify domain for the `web` service.

### 7.3 n8n routing for local event callbacks

`http://n8n:5678/healthz` returns **HTTP 200** from a container attached to the Coolify
project network `ynerrvhzq9y5gmgnagzld6j8` (the network carrying `coolify-proxy`, `n8n`,
`postgresql`, `nocodb`). Two options for `N8N_RECEIPT_VERIFIER_URL`:

- **Public (default, zero coupling):** `https://n8n.pancatz.com/webhook/<path>` — verified
  reachable, but the request hairpins out to Cloudflare and back.
- **Internal (lower latency, coupled):** attach the web container to the project network and
  use `http://n8n:5678/webhook/<path>`:

  ```bash
  docker network connect ynerrvhzq9y5gmgnagzld6j8 <web-container-name>
  # rollback:  docker network disconnect ynerrvhzq9y5gmgnagzld6j8 <web-container-name>
  ```

  A `docker network connect` does not survive a Coolify redeploy (the container is
  recreated), and the network name is Coolify-generated — if the n8n service is ever
  recreated, re-check `docker inspect <n8n> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'`.

**Dead configuration.** `PUBLIC_REDEMPTION_WEBHOOK_URL` and `N8N_WEBHOOK_URL` are read by no
code path in this repository — the portal makes no browser-to-n8n call, and all verification
runs server-side in the Astro API routes. Only `N8N_RECEIPT_VERIFIER_URL` (n8n override) and
`GEMINI_API_KEY` affect receipt verification. Keep them set for documentation value, but do
not treat them as a routing requirement.

### 7.4 Verifying webhook routing end to end

```bash
# 1. n8n itself is up
curl -s -o /dev/null -w '%{http_code}\n' https://n8n.pancatz.com/healthz

# 2. the app container can reach the verifier URL it was configured with
docker exec <web-container-name> wget -q -S -O /dev/null "$N8N_RECEIPT_VERIFIER_URL" 2>&1 | head -3

# 3. the redemption path with a mock verifier still allocates a voucher
bun scripts/verify-container-stack.mjs
```

