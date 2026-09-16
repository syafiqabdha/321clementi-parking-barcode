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
                           │ POST /webhook/clementi-redemption
                           ▼
          [n8n Automation Engine (n8n.pancatz.com)]
           ├── 1. Fast Gate: 12:00–15:00 SGT Weekdays only
           ├── 2. Fast Gate: LTA MOD-19 Vehicle Plate Checksum
           ├── 3. Deduplication: 1 redemption per plate daily
           ├── 4. Gemini 1.5 Flash Vision: Min $30 spend & date check
           └── 5. PostgreSQL: Atomic FIFO Voucher Allocation
                           │
                           ▼
          [PostgreSQL 16] ◄── (Admin UI) ──► [NocoDB (nocodb.pancatz.com)]
           • voucher_pool (Code 128 codes)      • CSV Voucher Batch Upload
           • redemption_logs (Audit records)    • Customer Service Search
```

---

## Project Documentation
- [Project Roadmap](./docs/project-management/ROADMAP.md)
- [Sprint Plan](./docs/project-management/SPRINT_PLAN.md)
- [Brand Identity & Design System](./docs/design/design.md)

---

## Deployment & Infrastructure

### Production Deployment (Vercel)
The mobile web portal is deployed to Vercel as a static Astro 5 build configured via [`vercel.json`](./vercel.json).

#### Environment Variables
Configure the following environment variables in the Vercel project dashboard or `.env`:

| Variable | Target | Description | Example |
|---|---|---|---|
| `PUBLIC_REDEMPTION_WEBHOOK_URL` | Production / Staging | Public HTTPS webhook endpoint for the n8n receipt verification workflow | `https://n8n.pancatz.com/webhook/clementi-redemption` |
| `DATABASE_URL` | Production (Backend) | PostgreSQL 16 connection URI for database migrations and automation scripts | `postgresql://user:pass@host:5432/clementi_redemption` |
| `NOCODB_URL` | Admin / Internal | NocoDB dashboard URL for administrative voucher management | `https://nocodb.pancatz.com` |

### CI/CD Automation (GitHub Actions)
Continuous integration is orchestrated via [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) on all PRs and pushes to `main`:
1. **Dependency Resolution**: `bun install --frozen-lockfile`
2. **Static Typecheck**: `bun run typecheck`
3. **Production Build**: `bun run build`
4. **Automated Test Suite**: `bun test` (134 test cases covering MOD-19 validation, operating hours gating, concurrency/FIFO allocation, and PostgreSQL 16 migrations)

