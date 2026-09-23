/**
 * 321 Clementi Smart Parking Barcode Redemption Engine
 * Database Queries & Atomic Allocation Statements
 * Updated for PAN-75: plain-text plates, shop selection, unclaim support.
 */

// ============================================================================
// Voucher Code Format (PAN-95)
// ============================================================================

/**
 * Regex enforcing the canonical voucher code format: exactly 10 decimal digits.
 * Used in API validation (redemptions.ts) and unit tests.
 * Must match the DB CHECK constraint added by migration 0004.
 */
export const VOUCHER_CODE_REGEX = /^\d{10}$/;

// ============================================================================
// Voucher Pool Queries
// ============================================================================

/** Count available vouchers in pool. */
export const COUNT_AVAILABLE_VOUCHERS_QUERY = `
SELECT COUNT(*)::bigint as available_count
FROM voucher_pool
WHERE status = 'AVAILABLE';
`;

// ============================================================================
// Redemption Allocation CTE (Updated for PAN-75)
// ============================================================================

/**
 * Atomic voucher allocation with plain-text plate, shop_id, claim_token_hash.
 * PAN-84: Added receipt_hash ($10), receipt_number ($11), receipt_fingerprint_hash ($12).
 * Returns allocated voucher details and inserted redemption log id.
 */
export const ATOMIC_ALLOCATION_CTE = `
WITH available_voucher AS (
    SELECT id, voucher_code, barcode_format
    FROM voucher_pool
    WHERE status = 'AVAILABLE'
      AND voucher_code ~ '^\\d{10}$'
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
        vehicle_plate,
        vehicle_plate_hash,
        receipt_amount,
        receipt_date,
        tenant_name,
        shop_id,
        voucher_code,
        status,
        claim_token_hash,
        ip_address,
        user_agent,
        receipt_hash,
        receipt_number,
        receipt_fingerprint_hash,
        created_at
    )
    SELECT
        $2, $1, $3, $4, $5, $6::uuid,
        rv.voucher_code, 'CLAIMED', $7,
        $8::inet, $9, $10, $11, $12, NOW()
    FROM reserved_voucher rv
    RETURNING id, voucher_code
)
SELECT 
    il.id AS redemption_id,
    rv.voucher_code,
    rv.barcode_format
FROM reserved_voucher rv
CROSS JOIN inserted_log il;
`;

// ============================================================================
// Daily Limit Check
// ============================================================================

/** Check if vehicle plate already has a CLAIMED redemption today (PAN-84: space-invariant). */
export const CHECK_DAILY_REDEMPTION_QUERY = `
SELECT id, voucher_code, created_at
FROM redemption_logs
WHERE REPLACE(UPPER(vehicle_plate), ' ', '') = REPLACE(UPPER($1), ' ', '')
  AND receipt_date = $2
  AND status = 'CLAIMED'
LIMIT 1;
`;

/** Check if a receipt image hash has already been used today (PAN-84: duplicate prevention). */
export const CHECK_RECEIPT_HASH_QUERY = `
SELECT id, vehicle_plate, created_at
FROM redemption_logs
WHERE receipt_hash = $1
  AND receipt_date = $2
  AND status = 'CLAIMED'
LIMIT 1;
`;

/** Check if a receipt fingerprint has already been used today (PAN-84: semantic dedup). */
export const CHECK_RECEIPT_FINGERPRINT_QUERY = `
SELECT id, vehicle_plate, created_at
FROM redemption_logs
WHERE receipt_fingerprint_hash = $1
  AND receipt_date = $2
  AND status = 'CLAIMED'
LIMIT 1;
`;

// ============================================================================
// Shop Queries
// ============================================================================

/** Get active, eligible shops for customer dropdown. */
export const GET_SHOPS_QUERY = `
SELECT id, name, slug, category, level, unit, is_eligible
FROM shops
WHERE is_active = TRUE
  AND is_eligible = TRUE
  AND ($1::varchar IS NULL OR category = $1)
ORDER BY category, name;
`;

/** Get all shops (admin). */
export const GET_ALL_SHOPS_QUERY = `
SELECT *
FROM shops
ORDER BY category, name;
`;

/** Get single shop by ID. */
export const GET_SHOP_BY_ID_QUERY = `
SELECT *
FROM shops
WHERE id = $1::uuid;
`;

/** Insert a new shop. */
export const INSERT_SHOP_QUERY = `
INSERT INTO shops (name, slug, category, level, unit, is_active, is_eligible, ineligibility_reason)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;
`;

/** Update an existing shop. */
export const UPDATE_SHOP_QUERY = `
UPDATE shops
SET name = COALESCE($2, name),
    slug = COALESCE($3, slug),
    category = COALESCE($4, category),
    level = COALESCE($5, level),
    unit = COALESCE($6, unit),
    is_active = COALESCE($7, is_active),
    is_eligible = COALESCE($8, is_eligible),
    ineligibility_reason = COALESCE($9, ineligibility_reason),
    updated_at = NOW()
WHERE id = $1::uuid
RETURNING *;
`;

/** Delete a shop. */
export const DELETE_SHOP_QUERY = `
DELETE FROM shops
WHERE id = $1::uuid
RETURNING id;
`;

// ============================================================================
// Claim History Queries
// ============================================================================

/** Get redemption history for a receipt number (PAN-104: receipt-based lookup). */
export const GET_RECEIPT_HISTORY_QUERY = `
SELECT 
    rl.id,
    rl.voucher_code,
    rl.receipt_amount,
    rl.receipt_date,
    rl.receipt_number,
    rl.status,
    rl.unclaimed_at,
    rl.claim_token_hash,
    rl.created_at,
    COALESCE(s.name, rl.tenant_name) AS shop_name,
    vp.barcode_format,
    (rl.status = 'CLAIMED' AND rl.created_at >= NOW() - INTERVAL '2 hours') AS can_unclaim,
    (rl.status = 'CLAIMED') AS can_resume,
    rl.created_at + INTERVAL '2 hours' AS expires_at
FROM redemption_logs rl
LEFT JOIN shops s ON rl.shop_id = s.id
LEFT JOIN voucher_pool vp ON rl.voucher_code = vp.voucher_code
WHERE rl.receipt_number IS NOT NULL
  AND UPPER(TRIM(rl.receipt_number)) = UPPER(TRIM($1))
ORDER BY rl.created_at DESC
LIMIT 50;
`;

/** Get redemption history for a vehicle plate (PAN-84: space-invariant lookup). */
export const GET_PLATE_HISTORY_QUERY = `
SELECT 
    rl.id,
    rl.voucher_code,
    rl.receipt_amount,
    rl.receipt_date,
    rl.status,
    rl.unclaimed_at,
    rl.claim_token_hash,
    rl.created_at,
    COALESCE(s.name, rl.tenant_name) AS shop_name,
    vp.barcode_format,
    -- Claim is still active if CLAIMED and within 2-hour window
    (rl.status = 'CLAIMED' AND rl.created_at >= NOW() - INTERVAL '2 hours') AS can_unclaim,
    (rl.status = 'CLAIMED') AS can_resume,
    rl.created_at + INTERVAL '2 hours' AS expires_at
FROM redemption_logs rl
LEFT JOIN shops s ON rl.shop_id = s.id
LEFT JOIN voucher_pool vp ON rl.voucher_code = vp.voucher_code
WHERE REPLACE(UPPER(rl.vehicle_plate), ' ', '') = REPLACE(UPPER($1), ' ', '')
ORDER BY rl.created_at DESC
LIMIT 50;
`;

// ============================================================================
// Unclaim Queries
// ============================================================================

/** Get a single redemption log for unclaim verification. */
export const GET_REDEMPTION_FOR_UNCLAIM = `
SELECT id, voucher_code, vehicle_plate, receipt_amount, receipt_number, shop_id, 
       status, claim_token_hash, created_at
FROM redemption_logs
WHERE id = $1::uuid
FOR UPDATE;
`;

/**
 * Atomic unclaim CTE: returns voucher to AVAILABLE, marks log UNCLAIMED,
 * inserts audit trail. All in one transaction.
 */
export const ATOMIC_UNCLAIM_CTE = `
WITH target_redemption AS (
    SELECT id, voucher_code, vehicle_plate, status, created_at
    FROM redemption_logs
    WHERE id = $1::uuid
      AND status = 'CLAIMED'
      AND created_at >= NOW() - INTERVAL '2 hours'
    FOR UPDATE
),
released_voucher AS (
    UPDATE voucher_pool vp
    SET status = 'AVAILABLE',
        vehicle_plate_hash = NULL,
        allocated_at = NULL,
        redeemed_at = NULL,
        updated_at = NOW()
    FROM target_redemption tr
    WHERE vp.voucher_code = tr.voucher_code
    RETURNING vp.voucher_code
),
updated_log AS (
    UPDATE redemption_logs rl
    SET status = 'UNCLAIMED',
        unclaimed_at = NOW(),
        unclaimed_reason = $2
    FROM target_redemption tr
    WHERE rl.id = tr.id
    RETURNING rl.id, rl.vehicle_plate, rl.voucher_code, rl.unclaimed_at
),
audit_entry AS (
    INSERT INTO redemption_audit_logs (
        redemption_id, action, vehicle_plate, voucher_code,
        ip_address, user_agent, success, metadata
    )
    SELECT 
        ul.id, 'UNCLAIM', ul.vehicle_plate, ul.voucher_code,
        $3::inet, $4, TRUE, $5::jsonb
    FROM updated_log ul
)
SELECT id, vehicle_plate, voucher_code, unclaimed_at 
FROM updated_log;
`;

// ============================================================================
// Audit Trail Queries
// ============================================================================

/** Insert an audit log entry. */
export const INSERT_AUDIT_LOG = `
INSERT INTO redemption_audit_logs (
    redemption_id, action, vehicle_plate, voucher_code,
    ip_address, user_agent, success, failure_reason, metadata
)
VALUES ($1::uuid, $2, $3, $4, $5::inet, $6, $7, $8, $9::jsonb)
RETURNING id;
`;

/** Count unclaim attempts for a plate today. */
export const COUNT_UNCLAIM_ATTEMPTS_TODAY = `
SELECT COUNT(*)::int AS attempt_count
FROM redemption_audit_logs
WHERE vehicle_plate = $1
  AND action = 'UNCLAIM'
  AND created_at >= CURRENT_DATE;
`;