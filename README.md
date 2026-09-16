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
