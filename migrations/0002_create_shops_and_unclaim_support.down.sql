-- Rollback: 0002_create_shops_and_unclaim_support.down.sql
-- Reverts PAN-75 schema changes.

-- 1. Drop audit trail table
DROP TABLE IF EXISTS redemption_audit_logs;

-- 2. Restore original unique index and drop new columns from redemption_logs
DROP INDEX IF EXISTS uq_redemption_vehicle_daily;
DROP INDEX IF EXISTS idx_redemption_logs_vehicle_plate;
DROP INDEX IF EXISTS idx_redemption_logs_shop_id;
DROP INDEX IF EXISTS idx_redemption_logs_status;

ALTER TABLE redemption_logs
    DROP CONSTRAINT IF EXISTS ck_redemption_logs_status,
    DROP COLUMN IF EXISTS unclaimed_reason,
    DROP COLUMN IF EXISTS unclaimed_at,
    DROP COLUMN IF EXISTS claim_token_hash,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS shop_id,
    DROP COLUMN IF EXISTS vehicle_plate;

-- Recreate original unique index (strict daily lock, no partial)
CREATE UNIQUE INDEX IF NOT EXISTS uq_redemption_vehicle_daily 
ON redemption_logs (vehicle_plate_hash, receipt_date);

-- 3. Drop shops table
DROP TABLE IF EXISTS shops;