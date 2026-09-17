-- Migration: 0002_create_shops_and_unclaim_support
-- Initiative: PAN-75 / PAN-76 (Backend PAN-77)
-- Creates shops table, extends redemption_logs with plain-text plates,
-- partial unique index for unclaim support, and audit trail.

-- 1. Create Shops Table
CREATE TABLE IF NOT EXISTS shops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL,
    slug VARCHAR(128) NOT NULL UNIQUE,
    category VARCHAR(64) NOT NULL,
    level VARCHAR(16) NOT NULL,
    unit VARCHAR(64) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    ineligibility_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for customer query performance
CREATE INDEX IF NOT EXISTS idx_shops_active_eligible 
ON shops (is_active, is_eligible);

CREATE INDEX IF NOT EXISTS idx_shops_category 
ON shops (category);

-- 2. Modify Redemption Logs Table
ALTER TABLE redemption_logs 
    ADD COLUMN IF NOT EXISTS vehicle_plate VARCHAR(16),
    ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shops(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'CLAIMED',
    ADD COLUMN IF NOT EXISTS claim_token_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS unclaimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS unclaimed_reason VARCHAR(255),
    ADD CONSTRAINT ck_redemption_logs_status CHECK (
        status IN ('CLAIMED', 'UNCLAIMED', 'RE_REDEEMED', 'EXPIRED')
    );

-- Populate vehicle_plate from existing hash if null (placeholder fallback)
UPDATE redemption_logs 
SET vehicle_plate = 'SG-LEGACY' 
WHERE vehicle_plate IS NULL;

ALTER TABLE redemption_logs 
    ALTER COLUMN vehicle_plate SET NOT NULL;

-- CRUCIAL ARCHITECTURAL CHANGE:
-- Replace the absolute daily unique index with a PARTIAL UNIQUE INDEX.
-- This allows unclaiming an existing redemption and re-redeeming on the same day.
DROP INDEX IF EXISTS uq_redemption_vehicle_daily;

CREATE UNIQUE INDEX uq_redemption_vehicle_daily 
ON redemption_logs (vehicle_plate, receipt_date) 
WHERE status = 'CLAIMED';

-- Fast lookup for car plate history queries
CREATE INDEX IF NOT EXISTS idx_redemption_logs_vehicle_plate 
ON redemption_logs (vehicle_plate);

CREATE INDEX IF NOT EXISTS idx_redemption_logs_shop_id 
ON redemption_logs (shop_id);

CREATE INDEX IF NOT EXISTS idx_redemption_logs_status 
ON redemption_logs (status);

-- 3. Create Immutable Audit Trail Table
CREATE TABLE IF NOT EXISTS redemption_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    redemption_id UUID REFERENCES redemption_logs(id) ON DELETE CASCADE,
    action VARCHAR(32) NOT NULL, -- 'CLAIM', 'UNCLAIM', 'RE_REDEEM', 'HISTORY_QUERY'
    vehicle_plate VARCHAR(16) NOT NULL,
    voucher_code VARCHAR(64),
    ip_address INET,
    user_agent TEXT,
    success BOOLEAN NOT NULL DEFAULT TRUE,
    failure_reason TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_plate 
ON redemption_audit_logs (vehicle_plate);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action 
ON redemption_audit_logs (action);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at 
ON redemption_audit_logs (created_at DESC);