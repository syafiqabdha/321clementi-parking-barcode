/**
 * POST /api/v1/redemptions/unclaim
 * Release an active voucher back to the available pool.
 * Body: { id: string } plus optional recovery fields.
 * Supports:
 *   - Fast path: X-Claim-Token header (client has localStorage token)
 *   - Recovery path: body { id, receipt_number, receipt_amount, shop_id, reason }
 * PAN-104: Vehicle plate removed as primary key; recovery uses receipt_number.
 */

import type { APIRoute } from 'astro';
import { getDb } from '../../../../db/connection';
import {
  ATOMIC_UNCLAIM_CTE,
  GET_REDEMPTION_FOR_UNCLAIM,
} from '../../../../db/queries';
import { verifyClaimToken } from '../../../../utils/crypto';
import {
  checkUnclaimRateLimit,
  checkUnclaimCooldown,
  getClientIp,
} from '../../../../utils/rate-limiter';

export const POST: APIRoute = async ({ request }) => {
  try {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // No body
    }

    const redemptionId = body.id;
    if (!redemptionId) {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_ID', message: 'Redemption ID is required in request body.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const ip = getClientIp(request);
    const ua = request.headers.get('user-agent') || null;
    const claimToken = request.headers.get('X-Claim-Token') || null;

    const sql = getDb();

    // Fetch the redemption record
    const rows = await sql.unsafe(GET_REDEMPTION_FOR_UNCLAIM, [redemptionId]);
    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'NOT_FOUND', message: 'Redemption record not found.' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const redemption = rows[0] as any;

    // Check status
    if (redemption.status !== 'CLAIMED') {
      return new Response(
        JSON.stringify({ success: false, error: 'ALREADY_UNCLAIMED', message: 'This voucher has already been unclaimed or expired.' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check 2-hour recovery window
    const createdAt = new Date(redemption.created_at);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    if (createdAt < twoHoursAgo) {
      return new Response(
        JSON.stringify({ success: false, error: 'OUTSIDE_UNCLAIM_WINDOW', message: 'Unclaim window has expired (2-hour limit).' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Rate limiting (PAN-104: keyed on redemption_id since plate is no longer required)
    const rateCheck = checkUnclaimRateLimit(redemptionId);
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ success: false, error: 'UNCLAIM_LIMIT_EXCEEDED', message: 'Maximum unclaim attempts reached for this redemption.' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((rateCheck.retryAfterMs || 3600) / 1000)) } }
      );
    }

    const cooldownCheck = checkUnclaimCooldown(redemptionId);
    if (!cooldownCheck.allowed) {
      return new Response(
        JSON.stringify({ success: false, error: 'UNCLAIM_COOLDOWN', message: 'Please wait before attempting another unclaim.' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((cooldownCheck.retryAfterMs || 60) / 1000)) } }
      );
    }

    // Authorization: verify claim token OR secondary factors
    let authorized = false;
    let recoveryType = 'token';

    if (claimToken) {
      authorized = await verifyClaimToken(claimToken, redemption.claim_token_hash);
    }

    if (!authorized) {
      // Fallback: secondary verification with receipt_number + receipt amount + shop
      recoveryType = 'fallback';

      const receiptNumberInput = body.receipt_number;
      const receiptAmount = body.receipt_amount;
      const shopIdInput = body.shop_id;

      // Resolve synthetic shop ID from offline fallback to real UUID
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let resolvedShopId = shopIdInput;
      if (shopIdInput && !UUID_RE.test(shopIdInput)) {
        const slugPrefix = shopIdInput.startsWith('shop-') ? shopIdInput.slice(5) : shopIdInput;
        const resolved = await sql`
          SELECT id FROM shops
          WHERE slug ILIKE ${slugPrefix + '%'}
          LIMIT 2
        `;
        if (resolved.length === 1) {
          resolvedShopId = (resolved[0] as any).id;
        }
      }

      if (
        receiptNumberInput &&
        typeof receiptNumberInput === 'string' &&
        receiptNumberInput.trim().toUpperCase() === (redemption.receipt_number ?? '').toUpperCase() &&
        receiptAmount !== undefined &&
        Math.abs(Number(receiptAmount) - Number(redemption.receipt_amount)) < 0.01 &&
        resolvedShopId === redemption.shop_id
      ) {
        authorized = true;
      }

      if (!authorized) {
        return new Response(
          JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Details do not match redemption record.' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Execute atomic unclaim
    const reason = recoveryType === 'fallback' ? 'RECOVERY_FALLBACK' : 'USER_INITIATED';
    const metadata = JSON.stringify({ recovery_type: recoveryType });

    try {
      const result = await sql.unsafe(ATOMIC_UNCLAIM_CTE, [
        redemptionId,
        reason,
        ip,
        ua,
        metadata,
      ]);

      if (result.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'UNCLAIM_FAILED', message: 'Unable to unclaim voucher.' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const unclaimed = result[0] as any;

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Voucher successfully unclaimed. Daily redemption limit has been released.',
          data: {
            redemption_id: unclaimed.id,
            vehicle_plate: unclaimed.vehicle_plate,
            status: 'UNCLAIMED',
            unclaimed_at: unclaimed.unclaimed_at instanceof Date ? unclaimed.unclaimed_at.toISOString() : unclaimed.unclaimed_at,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err: any) {
      throw err;
    }
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'INTERNAL_ERROR', message: err.message || 'An unexpected error occurred' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};