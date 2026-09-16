/**
 * 321 Clementi Smart Parking Barcode Redemption Engine
 * Database Queries & Atomic Allocation Statement
 */

/**
 * Single-statement atomic CTE to allocate next available voucher using
 * `FOR UPDATE SKIP LOCKED` and insert audit redemption log.
 *
 * Guaranteed O(1) performance via partial index `idx_voucher_pool_fifo_available`.
 * Rolls back automatically if daily duplicate vehicle plate constraint `uq_redemption_vehicle_daily` is violated.
 */
export const ATOMIC_ALLOCATION_CTE = `
WITH available_voucher AS (
    SELECT id, voucher_code, barcode_format
    FROM voucher_pool
    WHERE status = 'AVAILABLE'
    ORDER BY id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
),
reserved_voucher AS (
    UPDATE voucher_pool v
    SET status = 'REDEEMED',
        allocated_at = NOW(),
        redeemed_at = NOW(),
        vehicle_plate_hash = $1
    FROM available_voucher av
    WHERE v.id = av.id
    RETURNING v.id, v.voucher_code, v.barcode_format
),
inserted_log AS (
    INSERT INTO redemption_logs (
        vehicle_plate_hash,
        receipt_amount,
        receipt_date,
        tenant_name,
        voucher_code,
        ip_address,
        user_agent,
        created_at
    )
    SELECT
        $1,
        $2,
        $3,
        $4,
        rv.voucher_code,
        $5,
        $6,
        NOW()
    FROM reserved_voucher rv
    RETURNING id, voucher_code
)
SELECT 
    rv.voucher_code,
    rv.barcode_format
FROM reserved_voucher rv;
`;

/**
 * Check if vehicle plate hash already redeemed today.
 */
export const CHECK_DAILY_REDEMPTION_QUERY = `
SELECT id, voucher_code, created_at
FROM redemption_logs
WHERE vehicle_plate_hash = $1
  AND receipt_date = $2
LIMIT 1;
`;

/**
 * Count available vouchers in pool.
 */
export const COUNT_AVAILABLE_VOUCHERS_QUERY = `
SELECT COUNT(*)::bigint as available_count
FROM voucher_pool
WHERE status = 'AVAILABLE';
`;
