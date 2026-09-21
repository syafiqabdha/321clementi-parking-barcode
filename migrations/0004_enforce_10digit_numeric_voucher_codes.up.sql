-- Migration: 0004_enforce_10digit_numeric_voucher_codes
-- Initiative: PAN-95
-- Enforces strictly 10-digit numeric voucher codes in voucher_pool.
--
-- Strategy (zero-downtime, expand-then-contract):
--   Step 1: EXPIRE non-compliant AVAILABLE vouchers (safe — does not break REDEEMED history)
--   Step 2: Add CHECK constraint (NOT VALID) so new inserts/updates are guarded immediately
--            without scanning existing rows (avoids table lock on large pools).
--            Run VALIDATE CONSTRAINT separately in a low-traffic window once all
--            REDEEMED legacy rows have been archived / are no longer a concern.
--
-- Data-safe: REDEEMED/EXPIRED legacy rows with non-compliant codes are untouched;
--            only AVAILABLE inventory that would never scan correctly is purged.
-- Ops-safe:  NOT VALID means validation is deferred; no full-table scan at migration time.

-- 1. Expire non-compliant AVAILABLE vouchers so ops starts with a clean numeric batch.
UPDATE voucher_pool
SET    status     = 'EXPIRED',
       updated_at = NOW()
WHERE  status     = 'AVAILABLE'
  AND  voucher_code !~ '^\d{10}$';

-- 2. Add CHECK constraint (NOT VALID) to guard future inserts/updates immediately.
--    NOT VALID: skips the historic-row scan — safe because REDEEMED legacy codes
--    are immutable at this point. Use VALIDATE CONSTRAINT separately when ready.
--    Scoped with conrelid = 'voucher_pool'::regclass to avoid false-positive
--    matches against same-named constraints on other tables.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname    = 'ck_voucher_pool_voucher_code_numeric_10'
          AND  conrelid   = 'voucher_pool'::regclass
    ) THEN
        ALTER TABLE voucher_pool
            ADD CONSTRAINT ck_voucher_pool_voucher_code_numeric_10
            CHECK (voucher_code ~ '^\d{10}$') NOT VALID;
    END IF;
END
$$;
