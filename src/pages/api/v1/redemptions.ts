/**
 * POST /api/v1/redemptions
 * Submit receipt for voucher allocation. PAN-104: vehicle plate is now optional (removed as primary tracking key).
 *
 * PAN-84 Gate pipeline (fast-fail order):
 *   Gate 1: Bot detection — honeypot field and timing gate
 *   Gate 2: IP rate limit (3 req / 5 min)
 *   Gate 3: Shop validation (plate optional)
 *   Gate 4: (removed) Daily vehicle limit — now enforced by receipt deduplication
 *   Gate 5: Receipt image hash deduplication (SHA-256)
 *   Gate 6: AI Vision receipt verification (Gemini 1.5 Flash / n8n fallback) — enforces 4 LLM rules
 *   Gate 7: Semantic receipt fingerprint deduplication
 *   Gate 8: Atomic CTE voucher allocation
 */

import type { APIRoute } from 'astro';
import { getDb } from '../../../db/connection';
import {
  ATOMIC_ALLOCATION_CTE,
  CHECK_RECEIPT_HASH_QUERY,
  CHECK_RECEIPT_FINGERPRINT_QUERY,
  COUNT_AVAILABLE_VOUCHERS_QUERY,
  INSERT_AUDIT_LOG,
  VOUCHER_CODE_REGEX,
} from '../../../db/queries';
import { normalizeCarPlate, PlateValidationError } from '../../../utils/plate-normalization';
import { generateClaimToken } from '../../../utils/crypto';
import { sha256 } from '../../../utils/crypto';
import {
  getClientIp,
  checkRedemptionRateLimit,
} from '../../../utils/rate-limiter';
import {
  verifyReceipt,
  sha256Buffer,
  buildReceiptFingerprintHash,
} from '../../../services/receipt-verifier';
import { checkOperatingWindow } from '../../../utils/operating-window';

const MIN_FORM_SUBMIT_MS = 1_500; // Gate 1b: timing gate threshold

export const POST: APIRoute = async ({ request }) => {
  try {
    const ip = getClientIp(request);
    const ua = request.headers.get('user-agent') || null;

    // -----------------------------------------------------------------------
    // Gate 0: Operating Window Gate (12 PM - 3 PM Weekdays with 30m grace buffer, no PH)
    // -----------------------------------------------------------------------
    const bypassWindow =
      request.headers.get('X-Bypass-Window') === process.env.ADMIN_API_KEY ||
      (process.env.NODE_ENV !== 'production' && request.headers.get('X-Bypass-Window') === 'test');
    if (!bypassWindow) {
      const windowStatus = checkOperatingWindow();
      if (!windowStatus.allowed) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'PROMOTION_WINDOW_CLOSED',
            message: `Automated parking redemption is only available on weekdays between 12:00 PM and 3:00 PM (excluding Public Holidays). ${windowStatus.message}`,
            details: windowStatus,
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Parse form data
    const formData = await request.formData();

    // -----------------------------------------------------------------------
    // Gate 1a: Honeypot field — bots fill hidden inputs, humans don't
    // -----------------------------------------------------------------------
    const honeypot = formData.get('hp_company_field');
    if (honeypot && typeof honeypot === 'string' && honeypot.trim() !== '') {
      return new Response(
        JSON.stringify({ success: false, error: 'BOT_DETECTED', message: 'Submission rejected.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // -----------------------------------------------------------------------
    // Gate 1b: Timing gate — reject submissions under 1500ms
    // -----------------------------------------------------------------------
    const formRenderedAt = formData.get('form_rendered_at');
    if (formRenderedAt && typeof formRenderedAt === 'string') {
      const renderedTs = parseInt(formRenderedAt, 10);
      // The timestamp comes from the client's wall clock, which is independent of
      // the server's. A negative elapsed time means the two clocks disagree, not
      // that a bot submitted instantly, so it is not grounds for rejection — and
      // a client that wants to look slow can send an old timestamp regardless.
      const elapsedMs = Date.now() - renderedTs;
      if (!isNaN(renderedTs) && elapsedMs >= 0 && elapsedMs < MIN_FORM_SUBMIT_MS) {
        return new Response(
          JSON.stringify({ success: false, error: 'SUBMISSION_TOO_FAST', message: 'Submission rejected. Please try again.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // -----------------------------------------------------------------------
    // Gate 2: IP rate limit — 3 redemption attempts per IP per 5 minutes
    // -----------------------------------------------------------------------
    const rateCheck = checkRedemptionRateLimit(ip);
    if (!rateCheck.allowed) {
      const retryAfterSec = Math.ceil((rateCheck.retryAfterMs ?? 300_000) / 1000);
      return new Response(
        JSON.stringify({
          success: false,
          error: 'RATE_LIMITED',
          message: `Too many attempts. Please wait ${retryAfterSec} seconds before trying again.`,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfterSec),
          },
        }
      );
    }

    // -----------------------------------------------------------------------
    // Gate 3: Parse & validate required fields (PAN-104: plate is now optional)
    // -----------------------------------------------------------------------
    const rawPlate = formData.get('vehiclePlate');
    const shopId = formData.get('shopId');
    const receiptFile = formData.get('receiptImage');

    if (!shopId || typeof shopId !== 'string') {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_SHOP', message: 'Shop selection is required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (!receiptFile || !(receiptFile instanceof File)) {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_RECEIPT', message: 'Receipt image is required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Normalize plate if provided (PAN-104: optional)
    let canonicalPlate: string | null = null;
    if (rawPlate && typeof rawPlate === 'string' && rawPlate.trim() !== '') {
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

    // Today in SGT (Asia/Singapore) — consistent with receipt_date from AI verifier
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });

    // -----------------------------------------------------------------------
    // Gate 5: Exact receipt image hash deduplication (SHA-256)
    // -----------------------------------------------------------------------
    const receiptArrayBuffer = await receiptFile.arrayBuffer();
    const receiptBytes = new Uint8Array(receiptArrayBuffer);
    const receiptHash = await sha256Buffer(receiptBytes);

    const hashRows = await sql.unsafe(CHECK_RECEIPT_HASH_QUERY, [receiptHash, today]);
    if (hashRows.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'DUPLICATE_RECEIPT',
          message: 'This receipt image has already been used to claim a parking voucher today.',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // -----------------------------------------------------------------------
    // Gate 6: AI Vision receipt verification (Gemini 1.5 Flash / n8n fallback)
    // Enforces 4 LLM rules: legible receipt, >= $30 spend, today's date, location keyword
    // -----------------------------------------------------------------------
    const mimeType = receiptFile.type || 'image/jpeg';
    const verifyResult = await verifyReceipt(receiptBytes, mimeType);

    if (!verifyResult.valid) {
      return new Response(
        JSON.stringify({
          success: false,
          error: verifyResult.error_code || 'RECEIPT_VALIDATION_FAILED',
          message: verifyResult.message || 'Receipt could not be verified.',
        }),
        { status: verifyResult.http_status || 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Extract verified receipt fields
    const extraction = verifyResult.extraction;
    const receiptAmount = extraction?.total_amount ?? 30.00;
    const receiptNumber = extraction?.receipt_number ?? null;
    const tenantName = extraction?.tenant_name ?? shop.name;

    // -----------------------------------------------------------------------
    // Gate 7: Semantic receipt fingerprint deduplication
    // -----------------------------------------------------------------------
    const receiptFingerprintHash = await buildReceiptFingerprintHash(resolvedShopId, today, receiptNumber);
    if (receiptFingerprintHash) {
      const fpRows = await sql.unsafe(CHECK_RECEIPT_FINGERPRINT_QUERY, [receiptFingerprintHash, today]);
      if (fpRows.length > 0) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'DUPLICATE_RECEIPT',
            message: 'This receipt number has already been used to claim a parking voucher today.',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // -----------------------------------------------------------------------
    // Gate 8: Atomic CTE voucher allocation (PAN-104: plate fields nullable)
    // -----------------------------------------------------------------------
    const claimToken = generateClaimToken();
    const claimTokenHash = await sha256(claimToken);
    const plateHash = canonicalPlate ? await sha256(canonicalPlate) : null;

    let result: any[];
    try {
      result = await sql.unsafe(ATOMIC_ALLOCATION_CTE, [
        plateHash,              // $1 (nullable)
        canonicalPlate,         // $2 (nullable)
        receiptAmount,          // $3
        today,                  // $4
        tenantName,             // $5
        resolvedShopId,         // $6
        claimTokenHash,         // $7
        ip,                     // $8
        ua,                     // $9
        receiptHash,            // $10
        receiptNumber,          // $11
        receiptFingerprintHash, // $12
      ]);
    } catch (err: any) {
      // Detect unique constraint violations (race condition duplicates)
      if (
        err.message?.includes('uq_redemption_receipt_hash_daily') ||
        err.message?.includes('uq_redemption_receipt_fingerprint_daily') ||
        err.code === '23505'
      ) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'DUPLICATE_RECEIPT',
            message: 'This receipt has already been used to claim a voucher today.',
          }),
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

    // PAN-95: Invariant guard — the CTE selector now filters to compliant codes, so this
    // branch should only fire if the constraint was not applied AND legacy data slipped
    // through. Return 500 (server bug) rather than 503 (user retry), and do NOT consume
    // the daily slot — throw so the outer catch rolls any partial state back cleanly.
    if (!VOUCHER_CODE_REGEX.test(String(row.voucher_code ?? ''))) {
      throw new Error(`INVARIANT_VIOLATED: allocated non-compliant voucher code '${row.voucher_code}'. Run migration 0004 immediately.`);
    }

    // Log audit
    try {
      await sql.unsafe(INSERT_AUDIT_LOG, [
        row.redemption_id,
        'CLAIM',
        canonicalPlate || null,
        row.voucher_code,
        ip,
        ua,
        true,
        null,
        JSON.stringify({ shop_id: resolvedShopId, shop_name: shop.name, receipt_hash: receiptHash }),
      ]);
    } catch {
      // Best-effort audit logging
    }

    // Return success response
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          redemption_id: row.redemption_id,
          voucher_code: row.voucher_code,
          claim_token: claimToken,
          receipt_number: receiptNumber,
          vehicle_plate: canonicalPlate || null,
          shop_id: resolvedShopId,
          receipt_amount: receiptAmount,
          receipt_date: today,
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
