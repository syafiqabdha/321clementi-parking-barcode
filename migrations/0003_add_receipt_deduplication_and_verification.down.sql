-- Rollback: 0003_add_receipt_deduplication_and_verification
-- Removes receipt deduplication indexes and columns added in 0003 up migration.

-- 1. Drop partial unique indexes
DROP INDEX IF EXISTS uq_redemption_receipt_hash_daily;
DROP INDEX IF EXISTS uq_redemption_receipt_fingerprint_daily;

-- 2. Drop performance indexes
DROP INDEX IF EXISTS idx_redemption_logs_receipt_hash;
DROP INDEX IF EXISTS idx_redemption_logs_receipt_fingerprint_hash;

-- 3. Drop columns (reverse order of addition)
ALTER TABLE redemption_logs
    DROP COLUMN IF EXISTS receipt_fingerprint_hash,
    DROP COLUMN IF EXISTS receipt_number,
    DROP COLUMN IF EXISTS receipt_hash;
