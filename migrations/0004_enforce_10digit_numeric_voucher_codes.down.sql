-- Migration: 0004_enforce_10digit_numeric_voucher_codes (DOWN)
-- Reverts the CHECK constraint; does NOT re-AVAILABLE the expired vouchers
-- because ops must manually re-upload a compliant batch anyway.
-- Scoped with conrelid = 'voucher_pool'::regclass to avoid false-positive
-- matches against same-named constraints on other tables.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname    = 'ck_voucher_pool_voucher_code_numeric_10'
          AND  conrelid   = 'voucher_pool'::regclass
    ) THEN
        ALTER TABLE voucher_pool
            DROP CONSTRAINT ck_voucher_pool_voucher_code_numeric_10;
    END IF;
END
$$;
