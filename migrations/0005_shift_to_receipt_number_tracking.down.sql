-- Rollback: 0005_shift_to_receipt_number_tracking
-- Restores vehicle-bound daily constraint and NOT NULL requirements.

-- 1. Backfill nullable vehicle_plate columns with placeholder for historical rows
UPDATE redemption_logs SET vehicle_plate = 'SG-UNKNOWN' WHERE vehicle_plate IS NULL;
UPDATE redemption_logs SET vehicle_plate_hash = 'LEGACY' WHERE vehicle_plate_hash IS NULL;
UPDATE redemption_audit_logs SET vehicle_plate = 'SG-UNKNOWN' WHERE vehicle_plate IS NULL;

-- 2. Re-enforce NOT NULL constraints
ALTER TABLE redemption_logs ALTER COLUMN vehicle_plate SET NOT NULL;
ALTER TABLE redemption_logs ALTER COLUMN vehicle_plate_hash SET NOT NULL;
ALTER TABLE redemption_audit_logs ALTER COLUMN vehicle_plate SET NOT NULL;

-- 3. Recreate vehicle-bound daily constraint (partial: only CLAIMED rows)
CREATE UNIQUE INDEX uq_redemption_vehicle_daily
ON redemption_logs (vehicle_plate, receipt_date)
WHERE status = 'CLAIMED';
