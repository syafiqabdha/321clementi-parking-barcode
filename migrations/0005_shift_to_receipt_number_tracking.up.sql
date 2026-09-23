-- Migration: 0005_shift_to_receipt_number_tracking
-- Initiative: PAN-104 (Backend)
-- Shifts primary redemption constraint from vehicle plates to receipt uniqueness.
-- Vehicle plate columns become nullable (preserved for historical data).
-- 1-redemption-per-car-per-day constraint removed.

-- 1. Drop vehicle-bound daily constraint (was: 1 redemption per car per day)
DROP INDEX IF EXISTS uq_redemption_vehicle_daily;

-- 2. Make vehicle columns nullable on redemption_logs
ALTER TABLE redemption_logs ALTER COLUMN vehicle_plate DROP NOT NULL;
ALTER TABLE redemption_logs ALTER COLUMN vehicle_plate_hash DROP NOT NULL;

-- 3. Make vehicle_plate nullable on redemption_audit_logs
ALTER TABLE redemption_audit_logs ALTER COLUMN vehicle_plate DROP NOT NULL;
