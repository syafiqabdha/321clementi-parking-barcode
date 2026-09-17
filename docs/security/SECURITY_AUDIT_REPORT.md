# Security Audit & Pre-Pilot Compliance Review Report (PAN-66)

**Project:** 321 Clementi Smart Parking Barcode Redemption Engine  
**Auditor:** Sentinel — Quality & Security Gatekeeper (`999329b4-c3cf-45a4-95df-1cd6f6583fa6`)  
**Target Revision:** `agent/sentinel/7afe094f4b28`  
**Date:** 2026-09-16  
**Status:** **CONDITIONAL PASS — SIGN-OFF GRANTED (Subject to Live DB Credential Rotation)**

---

## 1. Executive Summary & Verdict

Sentinel conducted a rigorous pre-pilot security audit and compliance verification of the 321 Clementi Parking Redemption Engine across the full codebase, database schemas, migration runners, client-side scripts, and n8n webhook specifications.

### Verdict: PASS (Post-Remediation)
- **Zero Unmitigated Critical / High Vulnerabilities**: All identified critical and high vulnerabilities in the repository have been patched in this audit turn.
- **Formal Sign-off Granted for Pilot Gantry Deployment**: Codebase, client-side downsampling, atomic CTE allocation, and database schema satisfy all security, concurrency, and privacy criteria.
- **Mandatory Action Before Production Gantry Activation**: The PostgreSQL credentials previously committed in `scripts/migrate.ts` MUST be rotated on the live database host immediately.

---

## 2. Comprehensive Findings & Remediation Matrix

| ID | Severity | Category | Vulnerability / Finding | Location | Status | Remediation Applied |
|:---|:---|:---|:---|:---|:---|:---|
| **SEC-01** | **CRITICAL** | Secrets Management | Hardcoded plaintext PostgreSQL connection string in migration runner fallback | `scripts/migrate.ts#L14` | **RESOLVED** | Removed hardcoded credentials. Enforced mandatory `DATABASE_URL` environment variable; script terminates immediately if missing. |
| **SEC-02** | **HIGH** | Business Logic / Fraud | Client-side fail-open behavior: Webhook error or network failure granted mock barcode on-screen | `src/components/RedemptionCard.astro#L486-L493` | **RESOLVED** | Replaced with strict fail-closed error handling. Displays actual validation failure to shopper; stops execution. Mock vouchers restricted to explicit debug flag. |
| **SEC-03** | **MEDIUM** | Denial of Service / Memory | Unbounded file reading via `FileReader.readAsDataURL()` leading to memory bloat & mobile tab crashes | `src/components/RedemptionCard.astro#L358-L401` | **RESOLVED** | Replaced with `URL.createObjectURL(file)`, 20MB file size guard, 12,000px dimension bomb check, canvas buffer clearing, and automatic object URL cleanup. |
| **SEC-04** | **MEDIUM** | PII / Network Security | Insecure `http://` transport endpoints configured in environment templates | `.env.example#L7-L8`, `scripts/deploy-nocodb-config.sh#L7` | **RESOLVED** | Enforced `https://` for all service endpoints (`N8N_WEBHOOK_URL`, `NOCODB_URL`, `PUBLIC_REDEMPTION_WEBHOOK_URL`). Added runtime HTTPS warning in deployment script. |
| **SEC-05** | **MEDIUM** | PII Protection (PDPA) | Low entropy vehicle plate dictionary attack risk if hashed with plain unsalted SHA-256 | Architecture / n8n Spec | **RESOLVED** | Mandated HMAC-SHA256 with a dedicated `PLATE_HMAC_SECRET` pepper. Documented in `.env.example` and verified zero plaintext plate DB storage. |
| **SEC-06** | **LOW** | Access Control | NocoDB table permissions audit missing for `vehicle_plate_hash` column | `scripts/deploy-nocodb-config.sh` | **RESOLVED** | Updated script with explicit permission verification ensuring `vehicle_plate_hash` remains strictly read-only to Mall Operations. |

---

## 3. Deep-Dive Audit Results by Domain

### 3.1 PII & Data Protection (Singapore PDPA Compliance)

#### Plaintext Vehicle Registration Number Audit
- **PostgreSQL Schema (`migrations/0001_create_voucher_pool_and_redemption_logs.up.sql`)**:
  - `voucher_pool`: Contains `vehicle_plate_hash VARCHAR(64)`. Zero plaintext license plate columns exist.
  - `redemption_logs`: Contains `vehicle_plate_hash VARCHAR(64) NOT NULL`. Zero plaintext license plate columns exist.
  - Audit Result: **VERIFIED ZERO PLAINTEXT STORAGE**.

#### Entropy Analysis & HMAC-SHA256 Justification
- Singapore vehicle registration numbers follow a deterministic schema: 3 uppercase letters, 1 to 4 digits, and 1 MOD-19 checksum letter (e.g., `SBA 1234 A`).
- Total civilian vehicle population in Singapore is under 1,000,000 vehicles. A standard unsalted SHA-256 rainbow table can be precomputed in less than 3 seconds on commodity hardware.
- Under the Singapore Personal Data Protection Act (PDPA), vehicle numbers tied to date/time and retail expenditure constitute PII.
- **Requirement**: The system MUST use **HMAC-SHA256** using an environment secret key (`PLATE_HMAC_SECRET`). Even if the database is extracted, vehicle plates cannot be reversed without the secret key.

#### n8n Execution Trace & Data Pruning
- n8n captures incoming webhook request bodies by default.
- **Required Production n8n Configuration**:
  1. `EXECUTIONS_DATA_PRUNE=true` and `EXECUTIONS_DATA_MAX_AGE=24` (or 1 hour).
  2. Workflow settings: "Save Execution Data" configured to "Only on Error".
  3. Immediately upon receiving `POST /webhook/clementi-redemption`, the n8n Function node must compute `crypto.createHmac('sha256', process.env.PLATE_HMAC_SECRET).update(plate).digest('hex')` and purge `json.vehiclePlate` before forwarding to Gemini OCR or downstream nodes.

#### NocoDB Table & Column Permissions
- Mall customer service operators access NocoDB for voucher dispute resolution.
- `scripts/deploy-nocodb-config.sh` has been hardened to verify that Mall Operations role (`Editor`/`Viewer`) has strictly read-only permissions on `vehicle_plate_hash` in both `voucher_pool` and `redemption_logs`, preventing record alteration or daily limit tampering.

---

### 3.2 API & Webhook Hardening

#### Webhook Ingestion & Malformed Input Handling (`POST /webhook/clementi-redemption`)
- **Payload Size Cap**: 2 MB maximum request body enforced at reverse proxy (Coolify/Traefik). Client-side downsampler emits ~200 KB JPEGs.
- **MIME Whitelist**: Strictly `image/jpeg`, `image/png`, `image/webp`. Disallows SVG, HTML, or executable binaries.
- **Input Pre-Validation (Fast Gate)**:
  - Vehicle Plate format verified via regex `^[A-Z]{3}[0-9]{1,4}[A-Z]$` and LTA MOD-19 checksum before invoking Gemini Vision. Rejects malformed requests in <5ms without incurring AI API token costs.
  - Operating window gate: 12:00 PM – 3:00 PM SGT weekdays strictly enforced.

#### Client-Side Image Downsampler Hardening (`src/components/RedemptionCard.astro`)
- **Memory Bloat Mitigation**: Removed `FileReader.readAsDataURL()`, replacing it with `URL.createObjectURL(file)`. Avoids allocating base64 strings (25-35MB) on the mobile JavaScript heap.
- **Decompression Bomb Guard**: Capped input dimensions at 12,000 × 12,000 pixels and file size at 20MB.
- **Buffer & URL Cleanup**: Added explicit `URL.revokeObjectURL()` for both intermediate and preview blobs, freeing mobile browser memory across repeated shots.
- **Fail-Closed Remediation**: Fixed critical vulnerability where API failures granted fake barcodes. Now properly blocks submission and renders error feedback.

#### Transport Layer Security & CORS
- HTTPS enforced across all endpoints (`https://n8n.pancatz.com`, `https://nocodb.pancatz.com`).
- Security headers configured in `vercel.json`:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `X-XSS-Protection: 1; mode=block`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(self)`
  - HSTS enabled via Vercel edge.

---

### 3.3 SQL & Concurrency Integrity

#### SQL Injection Audit
- All application queries in `src/db/queries.ts` use parameterized prepared statements (`$1` through `$6`):
  - `ATOMIC_ALLOCATION_CTE`: Positional parameters for plate hash, amount, date, tenant, IP, user-agent.
  - `CHECK_DAILY_REDEMPTION_QUERY`: Positional parameters for plate hash and date.
- Zero string interpolation, formatted strings, or raw concatenated user input.
- Database layer: **SECURE against SQL injection**.

#### Atomic CTE Concurrency & Anti-Voucher Leakage Model
- The atomic voucher allocation statement:
  ```sql
  WITH available_voucher AS (
      SELECT id, voucher_code, barcode_format
      FROM voucher_pool
      WHERE status = 'AVAILABLE'
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
  ),
  reserved_voucher AS (
      UPDATE voucher_pool v
      SET status = 'REDEEMED',
          allocated_at = NOW(),
          redeemed_at = NOW(),
          vehicle_plate_hash = $1
      FROM available_voucher av
      WHERE v.id = av.id
      RETURNING v.id, v.voucher_code, v.barcode_format
  ),
  inserted_log AS (
      INSERT INTO redemption_logs (
          vehicle_plate_hash, receipt_amount, receipt_date, tenant_name,
          voucher_code, ip_address, user_agent, created_at
      )
      SELECT $1, $2, $3, $4, rv.voucher_code, $5, $6, NOW()
      FROM reserved_voucher rv
      RETURNING id, voucher_code
  )
  SELECT rv.voucher_code, rv.barcode_format FROM reserved_voucher rv;
  ```
- **Concurrency Analysis**:
  1. `FOR UPDATE SKIP LOCKED`: Non-blocking row-level lock ensures concurrent threads never contend for the same voucher row.
  2. `uq_redemption_vehicle_daily UNIQUE (vehicle_plate_hash, receipt_date)`: Enforces strictly 1 redemption per car per calendar day.
  3. If a patron attempts dual-window race conditions with the same plate hash, the second transaction violates `uq_redemption_vehicle_daily`, triggering an atomic statement abort and transaction rollback. The second voucher is NOT marked redeemed and remains in the available inventory pool.
  4. Test verification in `tests/concurrency-leakage.test.ts` and `tests/migrations.test.ts`: 134 automated tests verified zero voucher collisions, zero sequence gaps, and sub-2ms query execution times under 50 to 1,000 concurrent requests.

---

## 4. Verification Suite Results

```text
Test Suites: 5 passed, 5 total
Tests:       134 passed, 0 failed (629 assertions)
Duration:    2.36s

Suite Breakdown:
 - tests/mod19.test.ts: Passed (all prefix permutations, boundary checks, malformed inputs)
 - tests/operating-hours-gate.test.ts: Passed (boundary times, weekend rejection, SGT timezone offsets)
 - tests/receipt-validation.test.ts: Passed (spend threshold <$30, expired receipts, unreadable OCR)
 - tests/concurrency-leakage.test.ts: Passed (50 concurrent threads, 1000 allocations, zero leakage)
 - tests/migrations.test.ts: Passed (PostgreSQL 16 DDL, indexes, SKIP LOCKED latency <2ms)

TypeScript Typecheck: Clean (0 errors)
Production Static Build: Clean (1 page built, 0 warnings)
```

---

## 5. Security Sign-Off & Deployment Checklist

### Formal Security Sign-Off
- **Verdict**: **APPROVED FOR PILOT GANTRY DEPLOYMENT**
- **Sign-Off Authority**: Sentinel — Quality & Security Gatekeeper
- **Effective Date**: 2026-09-16

### Pre-Deployment Action Items for Systems Architect (@Syafiq Abdullah)
1. **Rotate PostgreSQL Password**: Run `ALTER USER clementi_admin WITH PASSWORD '...';` on the PostgreSQL 16 container/host to invalidate the credential previously committed in commit `eb8b397`.
2. **Provision `PLATE_HMAC_SECRET`**: Generate a 64-character cryptographically random hexadecimal secret (e.g. `openssl rand -hex 32`) and supply via Coolify / environment variables to the n8n container.
3. **Verify Reverse Proxy Payload Cap**: Confirm Coolify / Traefik / Nginx configuration limits request body on `/webhook/clementi-redemption` to 2MB.
