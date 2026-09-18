-- Migration: 0003_add_receipt_deduplication_and_verification
-- Initiative: PAN-84 (Backend TSK-05)
-- Adds receipt_hash, receipt_number, receipt_fingerprint_hash columns to redemption_logs
-- and creates dual-layer deduplication indexes to prevent duplicate/fake receipt fraud.
--
-- receipt_hash              = SHA-256(raw_image_buffer) — exact byte deduplication
-- receipt_number            = Raw receipt number string from OCR
-- receipt_fingerprint_hash  = SHA-256(shop_id || ':' || receipt_date || ':' || UPPER(TRIM(receipt_number)))
--                            — semantic dedup (same shop + date + receipt no.)

-- 1. Add columns (idempotent — IF NOT EXISTS guards)
ALTER TABLE redemption_logs
    ADD COLUMN IF NOT EXISTS receipt_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(64),
    ADD COLUMN IF NOT EXISTS receipt_fingerprint_hash VARCHAR(64);

-- 2. Index for performance on hash lookups
CREATE INDEX IF NOT EXISTS idx_redemption_logs_receipt_hash
ON redemption_logs (receipt_hash)
WHERE receipt_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_redemption_logs_receipt_fingerprint_hash
ON redemption_logs (receipt_fingerprint_hash)
WHERE receipt_fingerprint_hash IS NOT NULL;

-- 3. Exact image byte deduplication — one receipt image per calendar day (across all vehicles)
--    Partial index only covers status = 'CLAIMED' rows; unclaimed rows don't block re-try.
CREATE UNIQUE INDEX IF NOT EXISTS uq_redemption_receipt_hash_daily
ON redemption_logs (receipt_hash, receipt_date)
WHERE status = 'CLAIMED' AND receipt_hash IS NOT NULL;

-- 4. Semantic receipt number deduplication — same shop + date + receipt_no blocks reuse
--    even if the image is re-photographed or altered slightly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_redemption_receipt_fingerprint_daily
ON redemption_logs (receipt_fingerprint_hash, receipt_date)
WHERE status = 'CLAIMED' AND receipt_fingerprint_hash IS NOT NULL;
