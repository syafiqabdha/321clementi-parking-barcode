-- Migration: 0001_create_voucher_pool_and_redemption_logs
-- Initiative: 321 Clementi Autonomous Parking Barcode Redemption Engine
-- Target Database: PostgreSQL 16+
-- Reference: PAN-59 (321-S1-01)

-- Ensure UUID generation functions are available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. Voucher Pool Table (Pre-loaded Code 128 barcode inventory)
-- ============================================================================
CREATE TABLE IF NOT EXISTS voucher_pool (
    id BIGSERIAL PRIMARY KEY,
    voucher_code VARCHAR(64) NOT NULL UNIQUE,
    barcode_format VARCHAR(32) NOT NULL DEFAULT 'CODE128',
    status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
    allocated_at TIMESTAMPTZ,
    redeemed_at TIMESTAMPTZ,
    vehicle_plate_hash VARCHAR(64),
    batch_id VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_voucher_pool_status CHECK (
        status IN ('AVAILABLE', 'RESERVED', 'REDEEMED', 'EXPIRED')
    )
);

-- Crucial: Partial FIFO Index for O(1) lock-free voucher allocation.
-- Optimizes atomic CTE queries using `FOR UPDATE SKIP LOCKED`.
CREATE INDEX IF NOT EXISTS idx_voucher_pool_fifo_available 
ON voucher_pool (id ASC) 
WHERE status = 'AVAILABLE';

-- Index for batch operations, reporting, and NocoDB batch imports
CREATE INDEX IF NOT EXISTS idx_voucher_pool_batch_id 
ON voucher_pool (batch_id);

-- Index for status filtering and inventory monitoring
CREATE INDEX IF NOT EXISTS idx_voucher_pool_status 
ON voucher_pool (status);

-- Index for vehicle plate lookup on reserved/redeemed vouchers
CREATE INDEX IF NOT EXISTS idx_voucher_pool_vehicle_plate_hash 
ON voucher_pool (vehicle_plate_hash) 
WHERE vehicle_plate_hash IS NOT NULL;


-- ============================================================================
-- 2. Redemption Logs Table (Audit trail & daily vehicle limit enforcement)
-- ============================================================================
CREATE TABLE IF NOT EXISTS redemption_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_plate_hash VARCHAR(64) NOT NULL,
    receipt_amount NUMERIC(10, 2) NOT NULL,
    receipt_date DATE NOT NULL,
    tenant_name VARCHAR(128),
    voucher_code VARCHAR(64) NOT NULL,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_redemption_logs_voucher_code FOREIGN KEY (voucher_code) 
        REFERENCES voucher_pool(voucher_code) ON DELETE RESTRICT
);

-- Crucial: Daily Unique Index enforcing strictly 1 redemption per car per calendar day.
-- Atomic CTE allocation rolls back if duplicate plate insertion is attempted on the same receipt_date.
CREATE UNIQUE INDEX IF NOT EXISTS uq_redemption_vehicle_daily 
ON redemption_logs (vehicle_plate_hash, receipt_date);

-- Fast lookup of redemption log by voucher code
CREATE INDEX IF NOT EXISTS idx_redemption_logs_voucher_code 
ON redemption_logs (voucher_code);

-- Fast chronological sorting and audit review
CREATE INDEX IF NOT EXISTS idx_redemption_logs_created_at 
ON redemption_logs (created_at DESC);

-- Fast query by receipt date for daily reconciliation
CREATE INDEX IF NOT EXISTS idx_redemption_logs_receipt_date 
ON redemption_logs (receipt_date);
