/**
 * POST /api/v1/redemptions
 * Submit receipt, vehicle plate, and shop for voucher allocation.
 */

import type { APIRoute } from 'astro';
import { getDb } from '../../../db/connection';
import {
  ATOMIC_ALLOCATION_CTE,
  CHECK_DAILY_REDEMPTION_QUERY,
  COUNT_AVAILABLE_VOUCHERS_QUERY,
  INSERT_AUDIT_LOG,
} from '../../../db/queries';
import { normalizeCarPlate, PlateValidationError } from '../../../utils/plate-normalization';
import { generateClaimToken } from '../../../utils/crypto';
import { sha256 } from '../../../utils/crypto';
import { getClientIp } from '../../../utils/rate-limiter';

export const POST: APIRoute = async ({ request }) => {
  try {
    const ip = getClientIp(request);
    const ua = request.headers.get('user-agent') || null;

    // Parse form data
    const formData = await request.formData();
    const rawPlate = formData.get('vehiclePlate');
    const shopId = formData.get('shopId');
    const timestamp = formData.get('timestamp');

    // Validate required fields
    if (!rawPlate || typeof rawPlate !== 'string') {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_PLATE', message: 'Vehicle plate is required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (!shopId || typeof shopId !== 'string') {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_SHOP', message: 'Shop selection is required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Normalize plate
    let canonicalPlate: string;
    try {
      canonicalPlate = normalizeCarPlate(rawPlate);
    } catch (err) {
      if (err instanceof PlateValidationError) {
        return new Response(
          JSON.stringify({ success: false, error: err.code, message: err.message }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw err;
    }

    const sql = getDb();

    // Resolve shopId: accept UUIDs directly, resolve slug-based synthetic IDs via slug lookup
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let resolvedShopId = shopId;
    if (!UUID_RE.test(shopId)) {
      // Synthetic ID from offline fallback (e.g. "shop-huang-tu-di")
      const slugPrefix = shopId.startsWith('shop-') ? shopId.slice(5) : shopId;
      const resolved = await sql`
        SELECT id, name, is_active, is_eligible
        FROM shops
        WHERE slug ILIKE ${slugPrefix + '%'}
        LIMIT 2
      `;
      if (resolved.length === 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'INVALID_SHOP', message: 'Selected shop does not exist.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (resolved.length > 1) {
        return new Response(
          JSON.stringify({ success: false, error: 'AMBIGUOUS_SHOP', message: 'Shop identifier matches multiple stores.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      resolvedShopId = (resolved[0] as any).id;
    }

    // Verify shop exists and is eligible
    const shopRows = await sql`
      SELECT id, name, is_active, is_eligible
      FROM shops
      WHERE id = ${resolvedShopId}::uuid
    `;
    if (shopRows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'INVALID_SHOP', message: 'Selected shop does not exist.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const shop = shopRows[0] as any;
    if (!shop.is_active || !shop.is_eligible) {
      return new Response(
        JSON.stringify({ success: false, error: 'INELIGIBLE_SHOP', message: 'Selected shop is not eligible for parking redemption.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check available vouchers
    const availRows = await sql.unsafe(COUNT_AVAILABLE_VOUCHERS_QUERY);
    const availableCount = Number((availRows[0] as any).available_count);
    if (availableCount < 1) {
      return new Response(
        JSON.stringify({ success: false, error: 'VOUCHER_POOL_EXHAUSTED', message: 'No parking vouchers available at this time.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Derive receipt date from timestamp or use today
    const today = new Date().toISOString().slice(0, 10);

    // Check daily limit
    const existingRows = await sql.unsafe(CHECK_DAILY_REDEMPTION_QUERY, [canonicalPlate, today]);
    if (existingRows.length > 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'DAILY_LIMIT_EXCEEDED', message: `Vehicle ${canonicalPlate} has already redeemed a complimentary parking voucher for today.` }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Generate claim token
    const claimToken = generateClaimToken();
    const claimTokenHash = await sha256(claimToken);
    const plateHash = await sha256(canonicalPlate);

    // Atomic allocation
    // For now, use placeholder receipt_amount; OCR integration comes later.
    const receiptAmount = 30.00;
    const receiptDate = today;
    const tenantName = shop.name;

    let result: any[];
    try {
      result = await sql.unsafe(ATOMIC_ALLOCATION_CTE, [
        plateHash,        // $1
        canonicalPlate,   // $2
        receiptAmount,    // $3
        receiptDate,      // $4
        tenantName,       // $5
        resolvedShopId,   // $6
        claimTokenHash,   // $7
        ip,               // $8
        ua,               // $9
      ]);
    } catch (err: any) {
      // Detect unique constraint violation (daily limit race)
      if (err.message?.includes('uq_redemption_vehicle_daily') || err.code === '23505') {
        return new Response(
          JSON.stringify({ success: false, error: 'DAILY_LIMIT_EXCEEDED', message: `Vehicle ${canonicalPlate} has already redeemed a complimentary parking voucher for today.` }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw err;
    }

    if (result.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'VOUCHER_POOL_EXHAUSTED', message: 'No parking vouchers available at this time.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const row = result[0] as any;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Log audit
    try {
      await sql.unsafe(INSERT_AUDIT_LOG, [
        row.redemption_id,
        'CLAIM',
        canonicalPlate,
        row.voucher_code,
        ip,
        ua,
        true,
        null,
        JSON.stringify({ shop_id: resolvedShopId, shop_name: shop.name }),
      ]);
    } catch {
      // Best-effort audit logging
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          redemption_id: row.redemption_id,
          vehicle_plate: canonicalPlate,
          voucher_code: row.voucher_code,
          barcode_format: row.barcode_format || 'CODE128',
          shop_name: shop.name,
          receipt_amount: receiptAmount,
          claim_token: claimToken,
          status: 'CLAIMED',
          expires_at: expiresAt,
          created_at: new Date().toISOString(),
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'INTERNAL_ERROR', message: err.message || 'An unexpected error occurred' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};