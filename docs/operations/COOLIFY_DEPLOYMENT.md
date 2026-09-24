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
3. **Publish no host port for `web` or `nocodb`.** `docker-compose.yml` deliberately has no
   `ports:` mapping on either service: ingress is the Coolify/Traefik proxy's job via the
   domain assigned to the service (Cloudflare Tunnel → Coolify/Traefik → `web:4321`). CI
   enforces this. A published mapping bypasses Traefik and the Tunnel, which drops the
   Cloudflare WAF and strips `cf-connecting-ip` — the header step 4 depends on. The only
   published port in this repository is in `docker-compose.verify.yml`, bound to
   `127.0.0.1` and never deployed. On `ewsvr-ubuntu` that also matters practically: `:4321`
   is already held by another process and `:8080` by `coolify-proxy`, so a published
   mapping there would fail to start and collide.
4. **Cloudflare Tunnel and client IPs:** `getClientIp()` prefers `cf-connecting-ip`, which
   Cloudflare sets on every proxied request, so the 3-per-5-minute rate limiter buckets
   real shoppers. Only if that header is absent does it fall back to the rightmost
   `x-forwarded-for` entry, which a direct caller fully controls — so anyone able to reach
   the host's `:80`/`:443` directly could bypass the redemption rate limit entirely. Keep
   the app behind the Tunnel, and confirm the host firewall blocks inbound `80`/`443` (and
   `8080`) on the machine's public/Tailscale interfaces. On `ewsvr-ubuntu`, Coolify's
   Traefik publishes all three on every interface, so that guarantee is the firewall's to
   provide, not the compose file's.

## 3. Deploy

```bash
# 1. Build + start the database
#
# First, confirm the project has no pre-existing volume. `docker-compose.yml`
# pins `name: 321clementi-parking`, so any earlier run (including a verification
# run) that used this project name has already initialised and migrated
# `321clementi-parking_pgdata` — production would then start on a database
# seeded by a smoke test. Verification must use its own project name
# (`scripts/verify-container-stack.mjs` does: `-p 321clementi-parking-verify`).
docker volume ls --format '{{.Name}}' | grep '^321clementi-parking_' && \
  echo 'ABORT: volume already exists — confirm nothing else uses it, then docker compose -p 321clementi-parking down -v'
docker compose up -d db
docker compose exec db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# 2. Apply migrations 0001–0005 from inside the runtime image
docker compose run --rm web bun run db:migrate
docker compose run --rm web bun run db:status      # expect 5 APPLIED / 0 PENDING

# 3. Post-migration hardening (idempotent, safe to re-run)
# 0004 adds the 10-digit voucher CHECK constraint as NOT VALID so it does not scan a
# large pool at migration time. Validate it once legacy rows are clean. This takes
# SHARE UPDATE EXCLUSIVE: concurrent reads and writes keep flowing and only competing
# DDL blocks, so it is safe to run online — do it in the same window as go-live, since
# until it runs the pool's numeric invariant is unproven.
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'ALTER TABLE voucher_pool VALIDATE CONSTRAINT ck_voucher_pool_voucher_code_numeric_10;'

# 4. Least-privilege role for the NocoDB data source
# The password is exported in the operator's own shell and passed by NAME
# (`-e VAR` with no value), so no argv anywhere carries it — neither the host's
# `docker compose exec` nor the container's `psql`. scripts/nocodb-db-roles.sql
# reads it with \getenv. Never inline the value: `-v mall_ops_password=…` puts it
# in `ps aux` for every local user, and in shell history.
export MALL_OPS_DB_PASSWORD="$(openssl rand -hex 24)"   # or read it from your vault
docker compose exec -T -e MALL_OPS_DB_PASSWORD db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
       -v mall_ops_db="$POSTGRES_DB" -f - < scripts/nocodb-db-roles.sql

# 5. Start the application
docker compose up -d web
docker compose ps      # web must report (healthy)

# 6. Post-deploy smoke test through the PUBLIC hostname — do this before announcing.
# The CSRF origin gate compares `Origin` against the origin Astro derives from
# x-forwarded-proto / x-forwarded-host / Host — the protocol counts. cloudflared
# reaches Traefik over plain HTTP (http://localhost:80, see §7.5), so if the app ends
# up seeing `http` while the shopper's browser sends `https://…`, every same-site form
# POST is rejected with `403 Cross-site POST form submissions are forbidden`.
# ALLOWED_SITE_DOMAINS only widens which *hostnames* are accepted; it cannot make a
# protocol mismatch pass. This check is what proves the chain end to end.
#
# Send it as FORM data, exactly as the portal does: Astro's origin gate applies only to
# form-like content types, so a JSON POST sails straight past the very check this
# exercises.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://<production-hostname>/api/v1/redemptions" \
  -H "Origin: https://<production-hostname>" \
  -F 'shopId=1' -F 'receiptNumber=SMOKE-TEST'
# Expect 400/409/422 — the request reached the handler and the payload was rejected.
# 403 means the origin gate fired: fix the proxy per §7.5, not the app config.
# Never use a real receipt number here: a 201 is a live redemption.
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

**For 0005 the pre-committed recovery path is an image revert, not `db:rollback`.** Because
the rollback can legitimately fail for data reasons, do not leave that decision to be made
live: pin `IMAGE_TAG` to the previous build and recreate `web`. Use `db:rollback` for
0001–0004, which have no data-dependent failure mode.

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
#
# The database publishes no host port, so the probes need the loopback-only mapping
# the verification overlay adds — the deployable stack is deliberately unreachable
# from the host:
#
#   docker compose -p 321clementi-parking-verify \
#     -f docker-compose.yml -f docker-compose.verify.yml up -d db
#
# Percent-encode reserved characters in the password (@ : / %) — the script decodes
# each URI component before handing it to psql.
NOCODB_URL=https://nocodb.pancatz.com \
XC_TOKEN=<nocodb-api-token> \
MALL_OPS_DATABASE_URL="postgresql://mall_operations:${MALL_OPS_DB_PASSWORD}@127.0.0.1:15432/${POSTGRES_DB}" \
  ./scripts/deploy-nocodb-config.sh
#
# The script splits that URL itself and passes the password to psql through the
# environment (native mode) or stdin (docker mode) — never as a psql argv value, so
# it does not appear in `ps -ef`. The docker fallback uses `--network host` and
# therefore needs a Linux Docker host; on Docker Desktop, run the script where psql
# is available instead.

# Application test suite (unchanged, must stay green)
bun install --frozen-lockfile && bun run typecheck && bun test
```

`scripts/deploy-nocodb-config.sh` exits non-zero on any failed check. It runs every database
probe inside `BEGIN … ROLLBACK`, so it is idempotent and leaves no probe voucher in the live
pool.

## 6. Known caveats

- **The bot-challenge gate has been removed.** `POST /api/v1/redemptions` no longer reads
  `cf-turnstile-response`, and the portal never rendered the Turnstile widget anyway — the
  server required a token no client could supply, so every production submission failed with
  `BOT_CHALLENGE_FAILED`. Both Turnstile variables are now inert; the earlier "set both keys
  or every redemption fails" caveat no longer applies. What remains of Gate 1 is the honeypot
  and the 1500ms timing gate (both server-side), plus the per-IP rate limit (3 per 5 min). Do
  not restore the server-side check on its own: without the client widget every submission
  fails again.
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

Run these against the **deployed** stack:

```bash
# 1. n8n itself is up
curl -s -o /dev/null -w '%{http_code}\n' https://n8n.pancatz.com/healthz

# 2. the app container can reach the verifier URL it was configured with
docker exec <web-container-name> wget -q -S -O /dev/null "$N8N_RECEIPT_VERIFIER_URL" 2>&1 | head -3

# 3. the deployed redemption path through the public hostname. Non-destructive: a
#    receipt that cannot be verified is rejected before any voucher is consumed.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "https://<production-hostname>/api/v1/redemptions" \
  -H 'Content-Type: application/json' -H "Origin: https://<production-hostname>" \
  --data '{"receiptNumber":"SMOKE-TEST","shopId":1}'
# Expect 400/409/422 — anything but 403 (CSRF) and anything but 201.
```

`scripts/verify-container-stack.mjs` is a **throwaway-stack** check, not a health check for the
deployed services. It is safe to run on this host: it runs under its own compose project
(`321clementi-parking-verify`, override with `VERIFY_PROJECT`) and its `down -v` teardown removes
only that project's volumes, so it cannot touch the live `pgdata` / `nocodb-data`. Earlier
revisions of this runbook recommended it here without that isolation — it shared the production
project name and would have deleted the deployed database. It now refuses to start if
`VERIFY_PROJECT` names the production project.

### 7.5 The CSRF origin gate needs the proxy to present `https` (launch blocker)

**Symptom.** Once the portal is live, every redemption is rejected with
`403 Cross-site POST form submissions are forbidden`, while `curl` from the host and the
container stack check both look healthy.

**Cause (measured on this host).** Every cloudflared ingress rule points at
`http://localhost:80`, and this cloudflared runs with `network_mode: host`, so Traefik
receives a plain-HTTP request from a *local* source. Traefik honours inbound
`X-Forwarded-*` only from trusted sources:

```console
$ docker inspect coolify-proxy --format '{{join .Args "\n"}}' | grep forwardedHeaders
--entrypoints.http.forwardedHeaders.trustedIPs=173.245.48.0/20,103.21.244.0/22,…
```

Those are Cloudflare's *public* egress ranges. cloudflared connects from the host itself,
so its forwarded headers are ignored and Traefik re-derives the scheme from its own
connection → `X-Forwarded-Proto: http` → the app builds `http://<host>` → the browser's
`https://<host>` Origin never matches → 403. Note there is no `…https.forwardedHeaders…`
arg, and none is needed while the tunnel dials the http entrypoint.

Measured against the built server, form-encoded POST as the portal sends it:

| Origin | X-Forwarded-Proto | Result |
| --- | --- | --- |
| `https://host` | `https` | reaches the handler (400 `MISSING_RECEIPT`) |
| `https://host` | `http` | **403** |
| `http://host` | `http` | reaches the handler |
| `https://evil.example` | `https` | 403 — the allowlist holds |
| absent | absent | 403 |

**Fix — pick one, then re-run §3 step 6.**

- **A. Trust the tunnel's local source on the http entrypoint** (smallest change). Add the
  address Traefik actually sees for cloudflared to that entrypoint's trusted list, next to
  Cloudflare's ranges. In Coolify this is the proxy's `forwardedHeaders.trustedIPs` — the
  `coolify-proxy` arg quoted above. `127.0.0.1/32` and the docker bridge gateway of
  Traefik's `coolify` network (e.g. `10.0.1.1`) cover the two ways a host-network client
  reaches a published port; confirm which appears in Traefik's access log for
  `<production-hostname>` and trust that one.
- **B. Make the tunnel speak TLS to Traefik.** Add an ingress rule with
  `service: https://localhost:443` and
  `originRequest: {originServerName: <production-hostname>, noTLSVerify: false}`; Traefik
  then terminates real HTTPS and sets `X-Forwarded-Proto: https` itself. Requires a
  certificate for the hostname to exist first — it does not yet (§7.2), so A is the
  pragmatic path.

Do **not** use `forwardedHeaders.insecure=true`. It trusts `X-Forwarded-*` from every
client, letting a direct caller forge both `X-Forwarded-Proto` **and** the
`CF-Connecting-IP` that `src/utils/rate-limiter.ts` keys on (§8) — that silently disables
the per-IP rate limit.

Until step 6 returns a non-403, the application is unusable from the portal: do not
announce the deployment.

## 8. Security posture — accepted trade-offs

Reviewed in the PAN-109 security review; recorded so the next operator does not have to
re-litigate them.

| Item | Posture |
|---|---|
| Host port exposure | None. `web` and `nocodb` publish nothing; the CI port-exposure guard fails the build if that regresses. |
| Container hardening | `web` runs non-root with `cap_drop: [ALL]` and `no-new-privileges`; `nocodb` gets `no-new-privileges` only — upstream runs it as root and its startup has not been audited for capability requirements. Both cap `json-file` logs at 10 MB × 3 so a colocated stack cannot fill the host disk. |
| NocoDB image | Pinned to `nocodb/nocodb:2026.09.0` — the release the least-privilege boundary was calibrated against. |
| Secret handling | No secret is passed as an argv value anywhere in this runbook; the role-provisioning password reaches `psql` on stdin (§3 step 4). |
| DB authentication | `postgres:16-alpine` ships `trust` for loopback **inside** the `db` container and `scram-sha-256` for everything else, so `web` and `nocodb` are password-authenticated over the compose network. Consequence: `docker compose exec db psql -U mall_operations …` succeeds with no password, so it cannot be used to test the role's password — connect from another container on the `clementi` network instead. Verified: correct password accepted, wrong password returns `FATAL: password authentication failed`. |
| NocoDB admin trust | `NC_ALLOW_LOCAL_EXTERNAL_DBS=true` is required for the private-network data source. It also lets a NocoDB super-admin point a new source at arbitrary private hosts from inside the compose network. Accepted: NocoDB admins are trusted mall-operations staff. |
| Rate-limiter buckets | In-process `Map`s — they reset on restart/redeploy and are not shared across replicas. Correct for the single `web` replica this stack defines; horizontal scaling needs a shared store first. |
| `ALLOWED_SITE_DOMAINS` scope | The production image trusts exactly the hostnames in this variable plus `localhost`/`127.0.0.1`. The `*.vercel.app` wildcard is only compiled in when `DEPLOY_TARGET=vercel`. |

