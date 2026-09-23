# Sprint Plan: 321 Clementi Smart Parking Barcode Redemption

**Target:** Initial Release & Autonomous Redemption Engine MVP  
**Sprint Cadence:** 3 Phased Execution Stages  
**Squad:** `@Pancatz Foundry`  

---

## Sprint Backlog & Stage Breakdown

### Stage 1: Data Infrastructure & Automation Core (Backend)
- **Issue 1.1: PostgreSQL DDL Migrations (`voucher_pool` & `redemption_logs`)**
  - Owner: `@Backend Developer`
  - Deliverable: SQL migration creating `voucher_pool` (with partial FIFO index `WHERE status = 'AVAILABLE'`) and `redemption_logs` (with daily vehicle plate unique index).
- **Issue 1.2: NocoDB Base & Admin Table Configuration**
  - Owner: `@Backend Developer` / `@DevOps Engineer`
  - Deliverable: Point NocoDB to PostgreSQL tables, configure views for CSV batch upload and customer service dispute searches.
- **Issue 1.3: n8n Redemption Webhook Workflow**
  - Owner: `@Backend Developer`
  - Deliverable: n8n workflow implementing fast-fail operating hours gate (12:00–15:00 SGT weekdays), plain-text plate canonicalization, Gemini 1.5 Flash vision extraction, and atomic `SKIP LOCKED` voucher pop.

### Stage 2: Mobile Web Portal & Barcode Engine (Frontend)
- **Issue 2.1: Astro 5 Mobile Portal Scaffold & Design System**
  - Owner: `@Frontend Developer` / `@Iqbal`
  - Deliverable: Mobile-first portal adhering to `docs/design/design.md` (Clementi Crimson `#ED1651`, Montserrat headers, Inter body, high contrast).
- **Issue 2.2: Camera Capture & HTML5 Canvas Downsampling**
  - Owner: `@Frontend Developer`
  - Deliverable: In-browser camera capture with auto-compression (resizes raw 10MB phone photo to max 1200px width / ~200KB JPEG before webhook dispatch).
- **Issue 2.3: Code 128 Dynamic Barcode Renderer & Countdown Timer**
  - Owner: `@Frontend Developer` / `@Iqbal`
  - Deliverable: Clean, high-contrast SVG/Canvas Code 128 barcode display optimized for laser gantry scanners with validity countdown timer and brightness reminder.

### Stage 3: Verification, Quality Assurance & Security Gate
- **Issue 3.1: Automated Test Suite & Validation Harness**
  - Owner: `@QA Sentinel`
  - Deliverable: Pytest/Playwright tests covering plate permutations, off-hours rejection, and receipt validation edge cases.
- **Issue 3.2: Security Review & Concurrency Audit**
  - Owner: `@Sentinel`
  - Deliverable: Audit of HMAC-SHA256 plate hashing, SQL injection prevention, and zero voucher leakage under simulated concurrency.
