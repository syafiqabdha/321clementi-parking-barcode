# Coolify Deployment Runbook — 321 Clementi Parking Barcode

- **Issues:** PAN-109 (initial stack + Coolify deployment), PAN-110 (unified NocoDB
  architecture — §4, §7.6)
- **Target:** self-hosted Coolify, Docker Compose runtime, PostgreSQL 16, NocoDB admin UI
  (one centralized instance, external to this stack — §4)
- **Blast radius:** every command below is intended to be run **manually by the systems
  architect**. Nothing in this repository touches live Coolify infrastructure on its own.
- **Host-specific facts for ewsvr-ubuntu — read §7 first.**

## 1. What ships

| Path | Purpose |
|---|---|
| `Dockerfile` | Multi-stage Bun image. Builds the Astro SSR bundle (`@astrojs/node` standalone) and runs `dist/server/entry.mjs`. |
| `docker-compose.yml` | `web` + `db` (PostgreSQL 16) only. NocoDB is **not** part of this stack: the single instance runs as a Coolify service and is bridged onto this stack's network (§4). |
| `docker-compose.verify.yml` | Verification overlay only. **Never deploy this file.** |
| `scripts/verify-container-stack.mjs` | Boots the real stack and drives a full receipt→barcode redemption. |
| `scripts/nocodb-db-roles.sql` | Least-privilege `mall_operations` database role for NocoDB. |
| `scripts/deploy-nocodb-config.sh` | Real NocoDB + privilege verification (see §4). |
| `scripts/postgres-init/10-nocodb-meta.sql` | Creation of the `nocodb_meta` database — **first boot of an empty data directory only**, so it does not exist on ewsvr-ubuntu (§4.3). |

Runtime is **Bun**, not Node: `src/db/connection.ts` uses Bun's built-in SQL client and
`scripts/migrate.ts` imports `SQL` from `bun`. Shipping the migration runner inside the
same image is deliberate — the applied schema can never drift from the code that reads it.

## 2. Pre-flight

1. **Generate secrets** (never commit them; set them in Coolify → Environment):
   ```bash
   openssl rand -hex 32   # PLATE_HMAC_SECRET   (PDPA HMAC pepper)
   openssl rand -hex 32   # ADMIN_API_KEY       (/api/v1/admin/shops)
   openssl rand -hex 24   # MALL_OPS_DB_PASSWORD (NocoDB data-source role)
   ```
   The centralized NocoDB keeps its own secrets (`NC_AUTH_JWT_SECRET`, super-admin
   credentials) in its Coolify service — this repository no longer carries them.
2. **Set `ALLOWED_SITE_DOMAINS`** to every hostname the portal is served from, comma
   separated, no scheme — e.g. `321clementi.pancatz.com`. This is a **build-time** value:
   Astro evaluates its CSRF origin allowlist during `bun run build`, so changing it
   requires a rebuild. Omitting the real hostname makes every form POST fail with
   `403 Cross-site POST form submissions are forbidden`.
3. **Publish no host port for `web` or `db`.** `docker-compose.yml` deliberately has no
   `ports:` mapping on any service: ingress is the Coolify/Traefik proxy's job via the
   domain assigned to the service (Cloudflare Tunnel → Coolify/Traefik → `web:4321`). CI
   enforces this. A published mapping bypasses Traefik and the Tunnel, which drops the
   Cloudflare WAF and strips `cf-connecting-ip` — the header step 4 depends on. The only
   published port in this repository is in `docker-compose.verify.yml`, bound to
   `127.0.0.1` and never deployed. On `ewsvr-ubuntu` that also matters practically: `:4321`
   is already held by another process and `:8080` by `coolify-proxy`, so a published
   mapping there would fail to start and collide — this is one reason the NocoDB UI was
   never published from this stack either (§4).
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
# pins `name: 321clementi-parking`, but Coolify deploys with its own `-p`
# <project>, which **overrides** that field — so on a Coolify host the live
# volume is `<coolify-project>_pgdata` (observed on ewsvr-ubuntu as
# `k5eshqzwnefkjqc0gvbgtph3_pgdata`), not `321clementi-parking_pgdata`. Read the
# name off the running stack instead of guessing it:
#
#   docker inspect <web-or-db-container> \
#     --format '{{index .Config.Labels "com.docker.compose.project"}}'
#   docker volume ls --format '{{.Name}}' | grep '_pgdata$'
#
# If a volume already exists, an earlier run with this project name has already
# initialised and migrated it — production would then start on a database seeded
# by that run. Local verification must use its own project name
# (`scripts/verify-container-stack.mjs` does: `-p 321clementi-parking-verify`).
docker volume ls --format '{{.Name}}' | grep -E '(_pgdata|clementi-parking_pgdata)$' && \
  echo 'ABORT: volume already exists — confirm nothing else uses it, then docker compose -p <its-project> down -v'
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
docker compose ps      # db must report (healthy) first — `web` declares
                       # `depends_on: db: condition: service_healthy`, so if db is
                       # unhealthy `up -d web` aborts with
                       # "dependency failed to start: container … is unhealthy"
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

## 4. NocoDB — one centralized instance, bridged onto the application network

**One NocoDB, not two.** The mall-management UI is the pre-existing Coolify service
`nocodb` (container `nocodb-fbvelpdaf5kwl9im9qyr4i4u`, project `main`) at
`https://nocodb.pancatz.com`. The `nocodb` service profile, its `nocodb-data` volume and
its `NC_*` variables were **removed from `docker-compose.yml`** (PAN-110): deploying them
would stand up a second admin UI over the same tables, double the memory footprint and
split mall management across two bases with two sets of credentials. Everything
NocoDB-side — `NC_AUTH_JWT_SECRET`, `NC_SITE_URL`, the super-admin bootstrap — now belongs
to that Coolify service, not to this repository.

`db` publishes no host port (§2 step 3), so the data source is reachable **only over a
shared Docker network**. The parameters below work only after the bridge in §4.2 is in
place; without it, the connection fails with `ECONNREFUSED 127.0.0.1:5432`.

### 4.1 Data source parameters

NocoDB → **New base** → **New data source** → PostgreSQL, then map the fields exactly:

| NocoDB UI field | Value |
|---|---|
| **Host** | `db` |
| **Port** | `5432` |
| **Database** | `clementi_redemption` |
| **Schema** | `public` |
| **User** | `mall_operations` |
| **Password** | the provisioned `MALL_OPS_DB_PASSWORD` (§3 step 4) |

- `db` is the compose service name, resolved by Docker's embedded DNS on the `clementi`
  network. It is **not** `localhost`, not `127.0.0.1`, and not the NocoDB Coolify service
  alias. A data source created with an empty Host silently defaults to `127.0.0.1` and
  fails with `ECONNREFUSED 127.0.0.1:5432` — the exact symptom recorded during the PAN-109
  deployment verification.
- Leave **SSL off**. The connection never leaves the Docker bridge network.
- **User is `mall_operations`, never `POSTGRES_USER`.** The role and its column-level
  grants come from §3 step 4; do not create a role through the NocoDB form.
- The password is a secret: it is typed into the NocoDB form and read from the operator's
  vault or environment. It is never committed and never written into this document.
- Tables to link: `shops`, `voucher_pool`, `redemption_logs`.

### 4.2 Bridging the centralized NocoDB onto the application network

Both containers have to sit on one Docker network: `db` publishes no host port (§2 step 3)
and `Host = db` is a compose service name, resolved by Docker's embedded DNS — only a shared
network knows that name.

**Measured on ewsvr-ubuntu (read-only, 2026-09-24).** The application containers sit on *two*
networks, and both carry the `db` / `web` aliases:

| Network | What it is |
|---|---|
| `k5eshqzwnefkjqc0gvbgtph3` | Coolify's per-resource network for this stack. Created before the current containers and **not** recreated when they are (verified: network created 19:15 +08, containers 19:37 +08). |
| `k5eshqzwnefkjqc0gvbgtph3_clementi` | The compose file's `clementi` network, prefixed with the project name Coolify passed via `-p`. Becomes `321clementi-parking_clementi` at the next deploy — see below. |

The NocoDB container is attached to Coolify's resource network, so the bridge already works on
that host:

```console
$ docker exec nocodb-fbvelpdaf5kwl9im9qyr4i4u sh -c 'getent hosts db; nc -z -w 3 db 5432 && echo reachable'
172.24.0.3        db  db
reachable
```

The data source in §4.1 can therefore be created today. Run the steps below when it is
missing — a new host, a recreated Coolify resource, or a container that lost the attachment:

```bash
# 1. Which network(s) the application containers are on
docker inspect db-k5eshqzwnefkjqc0gvbgtph3-113702503873 \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# k5eshqzwnefkjqc0gvbgtph3 k5eshqzwnefkjqc0gvbgtph3_clementi

# 2. Bridge NocoDB onto this stack's own, pinned network name
docker network connect 321clementi-parking_clementi nocodb-fbvelpdaf5kwl9im9qyr4i4u
# rollback:  docker network disconnect 321clementi-parking_clementi nocodb-fbvelpdaf5kwl9im9qyr4i4u

# 3. Prove it, then press Test connection in the data-source dialog
docker inspect nocodb-fbvelpdaf5kwl9im9qyr4i4u \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker exec nocodb-fbvelpdaf5kwl9im9qyr4i4u sh -c 'getent hosts db; nc -z -w 3 db 5432 && echo reachable'
```

A `psql` probe from inside the `db` container proves nothing: `postgres:16-alpine` ships
`trust` for loopback *inside* that container (§8), so the check has to come from NocoDB
itself or from another container on the network.

**Why the name is pinned.** Coolify runs this stack with its own `-p <resource-uuid>`, which
overrides the `name:` at the top of the compose file — that is why the compose network was
named `k5eshqzwnefkjqc0gvbgtph3_clementi`, a name no document or script can rely on and which
changes whenever the Coolify resource is recreated. `networks.clementi.name` is now a literal
`321clementi-parking_clementi`, and a literal `name:` wins over `-p`. It is deliberately
**not** an environment variable: Coolify's environment panel would then be a live knob on the
production network name, and CI can only assert the default.

The mirror-image consequence is that `-p` alone no longer isolates the verification stack, so
`docker-compose.verify.yml` pins the same network to `321clementi-parking-verify_clementi`
itself. That keeps §5's command safe exactly as written, and CI asserts **both** names.

At the next deploy of this stack the compose network is created under the new name and the
old one is left empty. Containers also rejoin Coolify's resource network, so a bridge made
there — as on this host — keeps working; re-check step 3 after any redeploy that changes the
resource, and redo step 2 if it comes back empty. The `pgdata` volume name is deliberately
**not** pinned, so the database volume and its data are untouched by the rename.

**Persisting it.** `docker network connect` attaches to a *container*, and Coolify recreates
the NocoDB container on every redeploy of that service, so a manual attach is lost. Persist
it in the NocoDB service's own compose definition (Coolify → project `main` → service
`nocodb` → configuration/compose editor) by declaring this stack's network as external and
listing it on the service:

```yaml
services:
  nocodb:
    networks: [default, clementi-app]

networks:
  clementi-app:
    external: true
    name: 321clementi-parking_clementi
```

Deploy the application stack first — an `external` network must already exist or the
NocoDB service's own deploy fails — then redeploy NocoDB and repeat step 3. **This edit has
not been executed on ewsvr-ubuntu yet**: the first redeploy after it is the verification,
and membership should be re-checked after any redeploy of either stack.

### 4.3 `nocodb_meta` — keep NocoDB's metadata out of the application schema

`nocodb_meta` is a **separate database** in the application PostgreSQL instance, created by
`scripts/postgres-init/10-nocodb-meta.sql`. No service in this repository uses it any more —
the centralized instance keeps its own metadata store — but it is retained because an
instance pointed *here* must never use `clementi_redemption` as its metadata store. Pointed
at the application database, NocoDB materialises ~140 `nc_*` tables plus
`xc_knex_migrationsv0` into `public`, mixed in with the redemption tables, listed as linked
tables, and carried in every `pg_dump` of production data.

**It does not exist on ewsvr-ubuntu.** That script only runs on an *empty* data directory, and
this deployment's `db` container logs `PostgreSQL Database directory appears to contain a
database; Skipping initialization`:

```console
$ docker exec db-k5eshqzwnefkjqc0gvbgtph3-113702503873 \
    psql -U "$POSTGRES_USER" -d postgres -Atc "SELECT datname FROM pg_database ORDER BY 1"
clementi_redemption
postgres
template0
template1
```

There is no `nocodb_meta` — the only application database is `clementi_redemption`. Treat it
as something to create **by hand** if a NocoDB is ever pointed at this instance, not as
something already there:

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
  -c 'CREATE DATABASE nocodb_meta;'          # run once — it errors if the database already exists
```

The contamination guard it protects is currently intact — measured on the same instance,
`clementi_redemption.public` holds **zero** `nc_*` / `xc_knex*` tables, so nothing has to be
cleaned up. If NocoDB was ever pointed at the application database (or is again):

```bash
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  DO \$\$ DECLARE r RECORD; BEGIN
    FOR r IN SELECT tablename FROM pg_tables
             WHERE schemaname='public' AND (tablename LIKE 'nc\_%' OR tablename LIKE 'xc\_knex%')
    LOOP EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename); END LOOP;
  END \$\$;"
```

### 4.4 Linking the tables

The NocoDB instance runs as `mall_operations`, so it can only see the four application
tables — everything else in the schema is invisible to it.

1. Sign in to the centralized instance at `https://nocodb.pancatz.com` and create a base
   named **321 Clementi Mall Management**.
2. Add a data source of type PostgreSQL with exactly the fields in §4.1 — `db` / `5432` /
   `clementi_redemption` / `public`, credentials `mall_operations` / `$MALL_OPS_DB_PASSWORD`.
   The bridge in §4.2 has to be in place first, or the UI's **Test connection** fails with
   `ECONNREFUSED 127.0.0.1:5432`.
3. NocoDB introspects the source; `shops`, `voucher_pool` and `redemption_logs` are
   auto-linked. Confirm with (the script runs from the host, so it takes the
   loopback-mapped port from the verification overlay — see §5):
   ```bash
   NOCODB_URL=https://nocodb.pancatz.com XC_TOKEN=<token> \
   MALL_OPS_DATABASE_URL="postgresql://mall_operations:$MALL_OPS_DB_PASSWORD@127.0.0.1:15432/${POSTGRES_DB}" \
     ./scripts/deploy-nocodb-config.sh
   ```

### 4.5 Why the permissions live in PostgreSQL, not NocoDB

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
# No network variable is needed or wanted here: docker-compose.verify.yml pins
# `networks.clementi.name` to 321clementi-parking-verify_clementi, which is what keeps this
# throwaway database off the production network (`-p` alone cannot — a literal `name:` wins
# over it). CI asserts both network names.
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

- **Coolify environment variables must be filled in the resource's panel.** `docker-compose.yml`
  deliberately uses no `${VAR:?message}` "required" syntax, because Coolify substitutes that
  message text as the *value* when the variable is unset rather than aborting the deploy. That is
  exactly how the first production deploy ran with `POSTGRES_USER="POSTGRES_USER is required"`,
  which made the `db` healthcheck evaluate to
  `pg_isready -U POSTGRES_USER is required -d …` and fail with
  `pg_isready: error: too many command-line arguments (first is "is")` — the deployment then died
  at `up -d` with `dependency failed to start: container … is unhealthy`. Two things now prevent a
  repeat: the healthcheck expands `$$POSTGRES_USER` / `$$POSTGRES_DB` **inside the container** and
  quotes them, so host-side interpolation can never break it; and an unset variable becomes a
  default or empty value instead of the message text. A first boot with the wrong values still
  poisons `pgdata` — `POSTGRES_USER` and `POSTGRES_DB` are only read by `initdb`, so a volume
  created during a bad deploy keeps the wrong role and database names permanently. If a deploy
  failed this way, delete the volume (`docker volume rm <project>_pgdata`, or Coolify → Storages)
  before retrying; a plain re-deploy reuses the poisoned data directory.
- **Neither healthcheck can detect wrong database credentials — verify with the app after deploying.**
  `pg_isready` only asks whether the server accepts connections, and it does not authenticate.
  The `db` container cannot check credentials either: the official `postgres:16-alpine` image
  ships `trust` in `pg_hba.conf` for `local`, `127.0.0.1/32` and `::1/128`, with `scram-sha-256`
  only for other hosts — so any probe running *inside* that container (including `psql`) is
  trusted regardless of the password. And the `web` healthcheck is liveness-only by design: a
  DB-backed probe would fail on a fresh volume until `db:migrate` has run, and Coolify deploys
  with a single `up -d`. Net effect: an empty `POSTGRES_PASSWORD` is refused loudly by postgres on
  a *fresh* volume, but on an *existing* volume postgres ignores the variable entirely, both
  containers report healthy, and every DB-backed request returns 500. So after deploying, confirm
  the app can actually read the database:

  ```bash
  docker compose exec web sh -c 'wget -q -O - http://127.0.0.1:4321/api/v1/shops | head -c 120'
  ```

  `{"success":true,…}` means the credentials work; `{"success":false,"error":"INTERNAL_ERROR"}`
  means the app cannot read the database even though both containers say healthy. A cleaner fix,
  worth doing separately: have `web` run `db:migrate` on start (or as a Coolify pre-deployment
  command) and then make its healthcheck DB-backed.
- **A `POSTGRES_PASSWORD` containing `@`, `:` or `/` breaks the constructed `DATABASE_URL`.** Those
  characters must be percent-encoded. Use an alphanumeric password (e.g. `openssl rand -hex 32`),
  or set `DATABASE_URL` explicitly in the panel — the compose value is only a default
  (`${DATABASE_URL:-…}`), so an explicit override now wins.
- **`PLATE_HMAC_SECRET` is currently vestigial.** No application code reads it (`git grep
  PLATE_HMAC_SECRET -- src/` is empty; only the verification script sets a dummy value) — vehicle
  plates were dropped from the schema in migration 0005. It is kept so existing `.env` files and
  the documented panel values stay valid, and it is no longer required for the app to boot.
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

**Do not start a second NocoDB.** `docker-compose.yml` no longer defines one (PAN-110) —
the Coolify service at `https://nocodb.pancatz.com` is the only instance, and the app stack
is reached over a shared Docker network instead (§4.2).

**Measured network and volume facts** (read-only, 2026-09-24 — re-check rather than assume):

| Fact | Value |
|---|---|
| Live compose project | `k5eshqzwnefkjqc0gvbgtph3` — Coolify passes it as `-p`, which overrides the compose file's `name:` |
| Application containers | `web-k5eshqzwnefkjqc0gvbgtph3-113702492093` (`321clementi-parking-web:local`), `db-k5eshqzwnefkjqc0gvbgtph3-113702503873` (`postgres:16-alpine`) |
| Their networks | `k5eshqzwnefkjqc0gvbgtph3` (Coolify's resource network, older than the containers) **and** `k5eshqzwnefkjqc0gvbgtph3_clementi` (the compose network); both alias `db` / `web` |
| Database volume | `k5eshqzwnefkjqc0gvbgtph3_pgdata` — **not** `321clementi-parking_pgdata`, which is why §3 step 1 reads the name off the running stack |
| NocoDB container networks | `fbvelpdaf5kwl9im9qyr4i4u`, `ynerrvhzq9y5gmgnagzld6j8`, `k5eshqzwnefkjqc0gvbgtph3` — attachment to the last one is what makes `db` resolve (§4.2; reachability verified with `nc -z db 5432`) |
| Retired hostname | `321clementi-nocodb.pancatz.com` still resolves (Cloudflare `104.21.12.97` / `172.67.194.8`) and returns HTTP **404** at the edge, while no wildcard record exists under `pancatz.com` — a leftover record to delete (§7.6) |

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
(`321clementi-parking-verify`, override with `VERIFY_PROJECT`), and `docker-compose.verify.yml`
pins its network to `321clementi-parking-verify_clementi` — both are needed, because a literal
`name:` beats `-p` and `-p` alone would put the throwaway database on the production network.
Its `down -v` teardown removes only that project's volumes, so it cannot touch the live
`pgdata` volume. Earlier revisions of this runbook recommended it here without that isolation —
it shared the production project name and would have deleted the deployed database. It now
refuses to start if `VERIFY_PROJECT` names the production project.

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

### 7.6 Retiring the duplicate NocoDB hostname — Cloudflare Tunnel and Coolify cleanup

Nothing in this repository references `321clementi-nocodb.pancatz.com`, but a duplicate
NocoDB stood up during PAN-109 can leave artefacts behind on the host side, and each one is
a second route into the same database. Check and remove all three:

1. **Cloudflare Tunnel public hostname.** The tunnel on this host is
   `cloudflared-i8lsm19arq8z3g2lnpwi8nhx`. Measured state: `321clementi-nocodb.pancatz.com`
   resolves to Cloudflare (`104.21.12.97` / `172.67.194.8`) and answers HTTP **404** at the
   edge, while `zzz-nonexistent-pan110.pancatz.com` does not resolve at all — so there is no
   wildcard record hiding this, the record is real and stale. In the Cloudflare dashboard →
   **Zero Trust → Networks → Tunnels → that tunnel → Public Hostnames**, delete any
   `321clementi-nocodb.pancatz.com` entry (which removes its proxied DNS record). Confirm:
   ```bash
   dig +short 321clementi-nocodb.pancatz.com     # expect no A/AAAA/CNAME
   curl -s -o /dev/null -w '%{http_code}\n' https://321clementi-nocodb.pancatz.com/   # expect a DNS failure
   ```
2. **Coolify domain assignment.** If project `main`'s `nocodb` service — or the application
   service — carries an extra domain for that hostname, remove it in the service's
   **Domains** field. Traefik keeps serving a hostname for as long as the label exists, even
   with the tunnel rule deleted.
3. **Coolify magic variables.** Coolify auto-generates `SERVICE_FQDN_NOCODB` /
   `SERVICE_URL_NOCODB` for a service that exposes a port. A stale entry in the
   application's environment panel re-creates the domain on the next redeploy, so delete
   both there if present.

Before deleting anything, confirm the *live* instance still answers — this cleanup must not
touch `nocodb.pancatz.com`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://nocodb.pancatz.com/api/v1/health   # expect 200
```

`docs/operations/SHOP_MANAGEMENT_SOP.md` sends mall staff to `https://nocodb.pancatz.com`
only, so no runbook or SOP points at the retired hostname once this cleanup is done.

## 8. Security posture — accepted trade-offs

Reviewed in the PAN-109 security review; recorded so the next operator does not have to
re-litigate them.

| Item | Posture |
|---|---|
| Host port exposure | None. No service in `docker-compose.yml` (`web`, `db`) publishes a host port; the CI guard fails the build if that regresses. |
| Container hardening | `web` runs non-root with `cap_drop: [ALL]` and `no-new-privileges`; `db` keeps the stock `postgres:16-alpine` posture. Both cap `json-file` logs at 10 MB × 3 so a colocated stack cannot fill the host disk. The NocoDB container belongs to another Coolify service and is outside this file's scope. |
| NocoDB image | Not part of this stack: the single instance is the Coolify service `nocodb`. The least-privilege boundary was verified against NocoDB **2026.09.0**, so re-run `scripts/deploy-nocodb-config.sh` (§5) after any upgrade of that service — an unreviewed release could change the data-source behaviour the grants were calibrated against. |
| NocoDB network attachment | The centralized NocoDB is attached to this stack's `clementi` network (§4.2) and reaches `db:5432` as `mall_operations`. It is the only non-stack container on that network, and app ingress stays Traefik-only. |
| Secret handling | No secret is passed as an argv value anywhere in this runbook; the role-provisioning password reaches `psql` on stdin (§3 step 4). |
| DB authentication | `postgres:16-alpine` ships `trust` for loopback **inside** the `db` container and `scram-sha-256` for everything else, so `web` and the bridged NocoDB container are password-authenticated over the compose network. Consequence: `docker compose exec db psql -U mall_operations …` succeeds with no password, so it cannot be used to test the role's password — connect from another container on the `clementi` network instead. Verified: correct password accepted, wrong password returns `FATAL: password authentication failed`. |
| NocoDB admin trust | `NC_ALLOW_LOCAL_EXTERNAL_DBS=true` on the centralized NocoDB service is what permits the private-network data source in §4.1; if **Test connection** is refused for a private host, that setting is the first thing to check. It also lets a NocoDB super-admin point a new source at arbitrary private hosts from inside the compose network. Accepted: NocoDB admins are trusted mall-operations staff. |
| Rate-limiter buckets | In-process `Map`s — they reset on restart/redeploy and are not shared across replicas. Correct for the single `web` replica this stack defines; horizontal scaling needs a shared store first. |
| `ALLOWED_SITE_DOMAINS` scope | The production image trusts exactly the hostnames in this variable plus `localhost`/`127.0.0.1`. The `*.vercel.app` wildcard is only compiled in when `DEPLOY_TARGET=vercel`. |

