# Project Roadmap: 321 Clementi Smart Parking Barcode Redemption

**Repository:** `syafiqabdha/321clementi-parking-barcode`  
**Initiative:** Autonomous Receipt-to-Barcode Parking Redemption Engine  
**Target Venue:** 321 Clementi Mall, Singapore  
**Orchestration Squad:** `@Pancatz Foundry`  

---

## 1. Initiative Vision & Objective

Replace physical Customer Service counter operations with a frictionless, self-service mobile web portal. Shoppers scan an in-mall QR code, capture their receipt photo, input their vehicle registration number, and receive an instant **Code 128 barcode** on-screen to scan directly at 321 Clementi carpark exit gantries for 2 hours of complimentary weekday parking (12:00 PM – 3:00 PM, min spend $30.00).

---

## 2. Milestone Breakdown

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Architecture, Design Tokens & Project Initialization (Current)│
│ • Lock brand tokens (design.md, logo asset, chromatic palette)        │
│ • Database DDL schema (voucher_pool, redemption_logs)                  │
│ • Project roadmap, sprint plan, and squad execution delegation         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 2: Core Engine & Automation (n8n + PostgreSQL + NocoDB)          │
│ • Database tables setup & NocoDB spreadsheet base integration         │
│ • n8n Webhook workflow (12:00-15:00 gate, Plain-text Canonicalization, Gemini Vision)   │
│ • Atomic FIFO voucher reservation CTE (lock-free SKIP LOCKED)          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 3: Mobile Web Portal (Astro 5 + Tailwind + Code 128)             │
│ • Clean mobile layout matching 321 Clementi Design System (<50KB)      │
│ • Camera capture with client-side HTML5 canvas compression (~200KB)    │
│ • Instant on-screen Code 128 barcode display with countdown timer      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 4: Verification, Security & Gantry Pilot Gate                    │
│ • E2E test suite (concurrency, bad receipts, off-hours rejection)      │
│ • Physical gantry barcode scan test & laser readability verification    │
│ • Hand-off to pilot operations at 321 Clementi                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Workstream Ownership (Pancatz Foundry Squad)

| Role | Squad Member | Primary Responsibilities |
| :--- | :--- | :--- |
| **Delivery & Coordination** | `@Project Manager` | Sprint tracking, milestone gates, risk register, stakeholder comms |
| **Requirements & Spec** | `@Business Analyst` | Business rule verification, edge-case Gherkin specs, audit logs |
| **Architecture & Gate** | `@Tech Lead Architect` | Concurrency model review, n8n contract validation, ADRs |
| **Backend & Workflows** | `@Backend Developer` | n8n workflow construction, PostgreSQL DDL migrations, atomic CTE |
| **Frontend & Mobile UX** | `@Frontend Developer` / `@Iqbal` | Astro 5 portal, client-side canvas compression, Code 128 canvas |
| **Admin & Operations** | `@DevOps Engineer` | Docker Compose configs, NocoDB table wiring, Coolify setup |
| **Quality & Security** | `@QA Sentinel` / `@Sentinel` | Automated test suites, canonicalization checks, pre-merge review |
