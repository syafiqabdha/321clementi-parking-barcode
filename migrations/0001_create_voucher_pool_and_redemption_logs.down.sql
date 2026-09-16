-- Migration Rollback: 0001_create_voucher_pool_and_redemption_logs
-- Initiative: 321 Clementi Autonomous Parking Barcode Redemption Engine
-- Reversible teardown of redemption_logs and voucher_pool

-- Drop redemption_logs indexes and table first (referencing table)
DROP INDEX IF EXISTS idx_redemption_logs_receipt_date;
DROP INDEX IF EXISTS idx_redemption_logs_created_at;
DROP INDEX IF EXISTS idx_redemption_logs_voucher_code;
DROP INDEX IF EXISTS uq_redemption_vehicle_daily;
DROP TABLE IF EXISTS redemption_logs CASCADE;

-- Drop voucher_pool indexes and table
DROP INDEX IF EXISTS idx_voucher_pool_vehicle_plate_hash;
DROP INDEX IF EXISTS idx_voucher_pool_status;
DROP INDEX IF EXISTS idx_voucher_pool_batch_id;
DROP INDEX IF EXISTS idx_voucher_pool_fifo_available;
DROP TABLE IF EXISTS voucher_pool CASCADE;
