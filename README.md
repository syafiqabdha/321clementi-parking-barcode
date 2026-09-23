# 321 Clementi Smart Parking Barcode Redemption Engine

Autonomous receipt-to-barcode parking redemption engine for **321 Clementi Mall**, Singapore. Replaces physical Customer Service counter operations with a frictionless, self-service mobile web portal.

---

## Brand & Visual Identity
- **Design System Specification:** [`docs/design/design.md`](./docs/design/design.md)
- **Primary Brand Asset:** [`docs/design/assets/logo.png`](./docs/design/assets/logo.png)
- **Core Brand Color:** Clementi Crimson (`#ED1651`)
- **Typography:** Montserrat (Headings) / Inter (Body)

---

## System Architecture

```
[Shopper Phone] ──► [Mobile Web Portal (Astro 5 + Canvas Code 128)]
                           │
                           │ POST /api/v1/redemptions
                           ▼
          [n8n Automation Engine (n8n.pancatz.com)]
           ├── 1. Fast Gate: 12:00–15:00 SGT Weekdays only
           ├── 2. Fast Gate: Plain-text Cross-border Plate Canonicalization
           ├── 3. Deduplication: 1 redemption per plate + receipt daily
           ├── 4. Gemini 1.5 Flash Vision: Min $30 spend & date check
           └── 5. PostgreSQL: Atomic FIFO Voucher Allocation (SKIP LOCKED)
                           │
                           ▼
          [PostgreSQL 16] ◄── (Admin UI) ──► [NocoDB (nocodb.pancatz.com)]
           • voucher_pool (Code 128 codes)      • CSV Voucher Batch Upload
           • redemption_logs (Audit records)    • Customer Service Search
           • shops (merchant registry)          • Claim History & Unclaim
```

---

## Features

- **Instant barcode generation** — Code 128 rendered client-side via `jsbarcode`; zero server round-trip for display
- **Client-side barcode download** — Offline saving utility that allows shoppers to download the rendered Code 128 voucher image
- **Plain-text plate canonicalization** — NFKC normalization and whitespace stripping accommodates Singapore, Malaysian, and commercial plates without false rejections
- **AI receipt verification** — Gemini 1.5 Flash Vision confirms minimum $30 spend and same-day date on uploaded receipts
- **Receipt deduplication** — Cryptographic hash prevents the same receipt being redeemed twice across different plates
- **Anti-bot rate limiting** — IP + plate-based rate limiter with sliding window (configurable burst/refill)
- **Operating hours gate** — Hard rejection outside 12:00–15:00 SGT on weekdays
- **Screen wake lock** — Barcode modal requests wake lock so the display stays on at the gantry scanner
- **Claim history & unclaim** — Shoppers can view past redemptions and unclaim within the allowable state machine window
- **Admin endpoints** — Authenticated `POST`/`PATCH`/`DELETE /api/v1/admin/shops` with timing-safe API key verification for merchant directory maintenance

---

## API Reference

Full OpenAPI 3.1 specification: [`docs/openapi.yaml`](./docs/openapi.yaml)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/redemptions` | Submit receipt + plate for voucher redemption |
| `GET` | `/api/v1/redemptions/history` | Fetch claim history for a plate (`?plate=...`) |
| `POST` | `/api/v1/redemptions/unclaim` | Unclaim a voucher (state-machine gated) |
| `GET` | `/api/v1/shops` | List registered merchant shops (`?eligible_only=false` for all) |
| `POST` | `/api/v1/admin/shops` | Admin: create a new merchant shop |
| `PATCH` | `/api/v1/admin/shops` | Admin: update an existing shop |
| `DELETE` | `/api/v1/admin/shops` | Admin: remove a shop |

---

## Database Schema

Five PostgreSQL 16 migrations under `migrations/`:

| Migration | Description |
|-----------|-------------|
| `0001` | `voucher_pool` + `redemption_logs` — core FIFO voucher reservation and audit trail |
| `0002` | `shops` table + unclaim support columns on `redemption_logs` |
| `0003` | Receipt hash deduplication index + AI verification result columns |
| `0004` | Enforce 10-digit numeric codes check constraint |
| `0005` | Shift tracking from vehicle plate to receipt number |

Run migrations:

```bash
bun run db:migrate   # apply all pending up migrations
bun run db:rollback  # roll back the latest migration
bun run db:status    # show applied / pending state
```

---

## Project Documentation
- [Project Roadmap](./docs/project-management/ROADMAP.md)
- [Sprint Plan](./docs/project-management/SPRINT_PLAN.md)
- [Brand Identity & Design System](./docs/design/design.md)
- [OpenAPI Specification](./docs/openapi.yaml)
- [ADR-001: Plate History, Unclaim & Shop Selection](./docs/adr/ADR-001-plate-history-unclaim-shop-selection.md)
- [Shop Management SOP](./docs/operations/SHOP_MANAGEMENT_SOP.md)
- [Security Audit Report](./docs/security/SECURITY_AUDIT_REPORT.md)

---

## Quick Start (Local Development)

**Prerequisites:** Bun ≥ 1.1, PostgreSQL 16

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in NODE_ENV, DATABASE_URL, ADMIN_API_KEY, GEMINI_API_KEY,
# PLATE_HMAC_SECRET, Cloudflare Turnstile keys, and n8n URLs
# See the "Environment Variables" table under Deployment for full details

# 3. Apply database migrations
bun run db:migrate

# 4. Start the development server
bun run dev
```

The portal is available at `http://localhost:4321`.

---

## Testing

402 tests across 19 test files, executed with Bun's built-in test runner:

```bash
bun test
```

| Test File | Coverage Area |
|-----------|---------------|
| `mod19.test.ts` | (Deprecated) LTA MOD-19 plate checksum validation (replaced by plain-text canonicalization) |
| `plate-normalization.test.ts` | Plain-text plate canonicalization (NFKC, whitespace stripping) |
| `operating-hours-gate.test.ts` | 12:00–15:00 SGT weekday operating hours gate |
| `concurrency-leakage.test.ts` | Atomic FIFO voucher allocation & concurrency safety |
| `migrations.test.ts` | Up/down migration idempotency & schema correctness |
| `receipt-validation.test.ts` | AI receipt verification (min spend, date, deduplication) |
| `plate-normalization.test.ts` | Singapore plate format normalisation edge cases |
| `rate-limiter.test.ts` | Anti-bot sliding window rate limiter |
| `shop-id-resolution.test.ts` | Slug-based shop ID resolution |
| `shops-seed.test.ts` | Merchant shop seed data integrity |
| `unclaim-state-machine.test.ts` | Claim unclaim state machine transitions |
| `crypto.test.ts` | Cryptographic utilities (timing-safe comparison, hashing) |
| `security-fixes-pan83.test.ts` | Security hardening: SEC-01 through SEC-04 |
| `frontend-pan78.test.ts` | Frontend UX rule enforcement |
| `wake-lock-pan82.test.ts` | Screen wake lock barcode modal behaviour |

---

## Deployment & Infrastructure

### Production Deployment (Vercel)
The portal is deployed to Vercel as an **on-demand rendered Astro 5 app** using the
[`@astrojs/vercel`](https://docs.astro.build/en/guides/integrations-guide/vercel/) adapter
(`output: 'server'` in [`astro.config.mjs`](./astro.config.mjs)). `vercel.json` carries the
build/install commands, the `sin1` (Singapore) function region, and the security/caching headers.

- `/api/v1/**` — five request-time handlers bundled into a single Vercel Function (`_render`), with the `postgres` npm driver talking to PostgreSQL 16.
- `/` — prerendered to a static file and served from the CDN (`export const prerender = true` in `src/pages/index.astro`).
- Functions are pinned to `sin1`; keep the database in Singapore (or `ap-southeast-1`) to avoid cross-region latency.

Deployment is driven by Vercel's Git integration: pull requests get preview URLs, `main` deploys to production. `vercel.json` deliberately omits `outputDirectory` — the adapter writes the Build Output API v3 tree to `.vercel/output`, and declaring `dist` there makes Vercel serve the stale static build instead of the functions.

#### Environment Variables

Copy `.env.example` to `.env` and populate every variable before running the application. All variables are **required** unless marked optional. On Vercel, set these under **Project → Settings → Environment Variables** for the Production (and Preview) environments.

| Variable | Required | Context | Description | Example / How to Obtain |
|---|---|---|---|---|
| `NODE_ENV` | Optional | Backend | Node runtime environment for optimisations. Set to `production` on Vercel — several gates (`verifyReceipt`, `verifyTurnstileToken`) fail closed only when this is `production`. | `production` |
| `DATABASE_URL` | ✅ | Backend / Migrations | PostgreSQL 16 connection URI used by the app server and `bun run db:migrate`. **Must be network-reachable from Vercel** — `localhost` will not work. Use a managed endpoint or a transaction-mode pooler (Supabase `:6543`, Neon pooled, PgBouncer). | `postgresql://user:***@host:5432/clementi_redemption` |
| `TEST_DATABASE_URL` | ✅ | CI / Local Tests | Separate PostgreSQL URI for the isolated test database (never the production DB). Not needed on Vercel. | `postgresql://postgres:***@localhost:55432/test_clementi` |
| `PG_POOL_MAX` | Optional | Backend | Connections per function instance. Defaults to `1` on Vercel (every warm instance holds its own pool, so a larger value multiplies connections against Postgres). | `1` |
| `PG_IDLE_TIMEOUT` | Optional | Backend | Seconds before an idle pooled connection is closed. Default `20`. | `20` |
| `PG_CONNECT_TIMEOUT` | Optional | Backend | Seconds to wait for a new connection. Default `10`. | `10` |
| `PG_PREPARE` | Optional | Backend | Set `true` **only** for direct/session-mode endpoints. Must stay `false` (the default) behind a transaction-mode pooler, which cannot keep prepared statements alive between queries. | `false` |
| `PG_SSL` | Optional | Backend | Force TLS when `DATABASE_URL` carries no `sslmode=` parameter. | `true` |
| `PG_SSL_NO_VERIFY` | Optional | Backend | Skip certificate verification — self-signed certificates only. | `false` |
| `PUBLIC_REDEMPTION_WEBHOOK_URL` | ⚠️ Unused | Frontend (public) | Declared for the n8n receipt workflow, but **no source file reads it** — receipt verification runs server-side via `GEMINI_API_KEY` / `N8N_RECEIPT_VERIFIER_URL`. Safe to omit. | `https://n8n.pancatz.com/webhook/clementi-redemption` |
| `N8N_WEBHOOK_URL` | ✅ | Backend | Server-side n8n webhook URL for internal API-to-n8n calls. Usually the same as `PUBLIC_REDEMPTION_WEBHOOK_URL`; keep separate for network-internal routing. | `https://n8n.pancatz.com/webhook/clementi-redemption` |
| `PLATE_HMAC_SECRET` | ✅ | Backend (PII) | 64-character cryptographically random hex secret used as HMAC-SHA256 pepper for vehicle plate hashing (PDPA compliance, SEC-05). Generate with: `openssl rand -hex 32` | `a0b1c2d3...` (64 hex chars) |
| `ADMIN_API_KEY` | ✅ | Backend | Bearer token / API key for admin endpoints (`/api/v1/admin/shops`). Compared with constant-time `timingSafeEqual` (SEC-04). Generate with: `openssl rand -hex 32` | `your-secret-admin-key` |
| `GEMINI_API_KEY` | ✅ | Backend | Google Gemini 1.5 Flash API key for AI receipt OCR verification (minimum $30 spend + date check). Obtain from [Google AI Studio](https://aistudio.google.com/app/apikey). `verifyReceipt()` returns `503 VERIFIER_UNAVAILABLE` when this and `N8N_RECEIPT_VERIFIER_URL` are both unset in production. | `AIza...` |
| `CLOUDFLARE_TURNSTILE_SECRET_KEY` | ⚠️ See note | Backend | Server-side Turnstile secret for bot protection. **Leave unset until the browser widget is wired** — no widget renders `cf-turnstile-response`, so with this set every redemption is rejected `400 BOT_CHALLENGE_FAILED`. The gate is skipped entirely when the variable is absent. | `0x4AAAAAAA...` |
| `PUBLIC_TURNSTILE_SITE_KEY` | ⚠️ Unused | Frontend (public) | Declared for the Turnstile widget, but no source file reads it. See the note on the secret key above. | `0x4AAAAAAA...` |
| `NOCODB_URL` | ✅ | Admin / DevOps | Base URL of the NocoDB instance used by mall management staff to update the `shops` table and by `deploy-nocodb-config.sh` for health checks. Must be `https://`. | `https://nocodb.pancatz.com` |
| `N8N_RECEIPT_VERIFIER_URL` | Optional | Backend | If set, overrides the direct Gemini API call and routes receipt verification through an n8n workflow instead. Leave blank to use the Gemini API directly. | `https://n8n.pancatz.com/webhook/verify-receipt` |
| `XC_TOKEN` | Optional | DevOps | NocoDB admin API token for `scripts/deploy-nocodb-config.sh` authenticated API checks. Only needed when running the deployment validation script. Obtain from NocoDB → Team & Auth → API Tokens. | `xc-token-...` |

### Database Migrations
Migrations run from a machine that can reach the production database — Vercel functions do not run them:

```bash
DATABASE_URL="postgresql://...prod..." bun run db:migrate   # apply pending
DATABASE_URL="postgresql://...prod..." bun run db:status    # show applied / pending
```

`scripts/migrate.ts` imports Bun's SQL client, so these commands require Bun (`curl -fsSL https://bun.sh/install | bash`). They are not part of the deployed artifact.

### CI/CD Automation (GitHub Actions)
Continuous integration is orchestrated via [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) on all PRs and pushes to `main`:
1. **Dependency Resolution**: `bun install --frozen-lockfile`
2. **Static Typecheck**: `bun run typecheck`
3. **Astro Component Typecheck**: `npx astro check` (catches `.astro` `<script>` block errors `tsc` misses)
4. **Production Build**: `bun run build`
5. **Serverless Output Gate**: asserts all five `/api/v1/**` routes resolve to the `_render` function in `.vercel/output/config.json` — this is what catches a silent regression back to build-time prerendering
6. **Automated Test Suite**: `bun test` (402 test cases including route-level end-to-end tests against a real PostgreSQL 16 container)

The workflow uses no Vercel secrets: production deploys come from Vercel's Git integration, so CI stays a pure quality gate. To deploy from CI instead, add `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as repository secrets and run `vercel pull --yes --environment=production && vercel build --prod && vercel deploy --prebuilt --prod`.

