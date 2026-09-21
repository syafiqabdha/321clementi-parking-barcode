-- Migration: 0004_enforce_10digit_numeric_voucher_codes
-- Initiative: PAN-95
-- Enforces strictly 10-digit numeric voucher codes in voucher_pool.
--
-- Strategy (zero-downtime, expand-then-contract):
--   Step 1: EXPIRE non-compliant AVAILABLE vouchers (safe — does not break REDEEMED history)
--   Step 2: Add CHECK constraint so inserts/updates can never violate the format going forward
--
-- Data-safe: REDEEMED/EXPIRED legacy rows with non-compliant codes are untouched;
--            only AVAILABLE inventory that would never scan correctly is purged.

-- 1. Expire non-compliant AVAILABLE vouchers so ops starts with a clean numeric batch.
UPDATE voucher_pool
SET    status     = 'EXPIRED',
       updated_at = NOW()
WHERE  status     = 'AVAILABLE'
  AND  voucher_code !~ '^\d{10}$';

-- 2. Add CHECK constraint to prevent future non-compliant inserts.
--    IF NOT EXISTS phrasing is Postgres-compatible via DO block for idempotency.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'ck_voucher_pool_voucher_code_numeric_10'
    ) THEN
        ALTER TABLE voucher_pool
            ADD CONSTRAINT ck_voucher_pool_voucher_code_numeric_10
            CHECK (voucher_code ~ '^\d{10}$');
    END IF;
END
$$;
