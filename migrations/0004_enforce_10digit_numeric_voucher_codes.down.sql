-- Migration: 0004_enforce_10digit_numeric_voucher_codes (DOWN)
-- Reverts the CHECK constraint; does NOT re-AVAILABLE the expired vouchers
-- because ops must manually re-upload a compliant batch anyway.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'ck_voucher_pool_voucher_code_numeric_10'
    ) THEN
        ALTER TABLE voucher_pool
            DROP CONSTRAINT ck_voucher_pool_voucher_code_numeric_10;
    END IF;
END
$$;
