/**
 * GET /api/v1/redemptions/history
 * Retrieve claim history for a vehicle plate.
 * Query: ?plate=SBA1234A
 * Header: X-Claim-Token (optional)
 */

import type { APIRoute } from 'astro';
import { getDb } from '../../../../db/connection';
import { GET_PLATE_HISTORY_QUERY, INSERT_AUDIT_LOG } from '../../../../db/queries';
import { normalizeCarPlate, PlateValidationError } from '../../../../utils/plate-normalization';
import { checkHistoryRateLimit, checkPlateHistoryScanLimit, getClientIp } from '../../../../utils/rate-limiter';
import { sha256 } from '../../../../utils/crypto';

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const rawPlate = url.searchParams.get('plate');
    const claimToken = request.headers.get('X-Claim-Token') || null;
    const ip = getClientIp(request);
    const ua = request.headers.get('user-agent') || null;

    // Validate plate input
    if (!rawPlate) {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_PLATE', message: 'Vehicle plate query parameter is required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

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

    // Rate limiting
    const historyCheck = checkHistoryRateLimit(ip);
    if (!historyCheck.allowed) {
      return new Response(
        JSON.stringify({ success: false, error: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((historyCheck.retryAfterMs || 1000) / 1000)) } }
      );
    }

    const scanCheck = checkPlateHistoryScanLimit(ip, canonicalPlate);
    if (!scanCheck.allowed) {
      return new Response(
        JSON.stringify({ success: false, error: 'SCAN_LIMITED', message: 'Too many distinct plate lookups. Please try again later.' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const sql = getDb();

    // Query history
    const rows = await sql.unsafe(GET_PLATE_HISTORY_QUERY, [canonicalPlate]);

    // Log audit (history query)
    try {
      await sql.unsafe(INSERT_AUDIT_LOG, [
        rows.length > 0 ? rows[0].id : null,
        'HISTORY_QUERY',
        canonicalPlate,
        null,
        ip,
        ua,
        true,
        null,
        JSON.stringify({ claim_token_provided: !!claimToken }),
      ]);
    } catch {
      // Audit logging is best-effort; don't fail the request
    }

    // Per-row claim token verification (SEC-02/SEC-03):
    // Hash the incoming token once; compare against each row's stored hash.
    const tokenHash = claimToken ? await sha256(claimToken) : null;

    // Format response — mask sensitive fields when token is absent or invalid
    const data = await Promise.all(rows.map(async (row: any) => {
      const rowTokenHash: string | null = row.claim_token_hash || null;
      // Token is valid for this row only when it exists and the hashes match
      const tokenValid = tokenHash !== null && rowTokenHash !== null && tokenHash === rowTokenHash;

      if (tokenValid) {
        return {
          id: row.id,
          voucher_code: row.voucher_code,
          barcode_format: row.barcode_format || 'CODE128',
          receipt_amount: parseFloat(row.receipt_amount),
          receipt_date: row.receipt_date instanceof Date ? row.receipt_date.toISOString().slice(0, 10) : String(row.receipt_date).slice(0, 10),
          shop_name: row.shop_name || 'Unknown',
          status: row.status,
          can_unclaim: row.can_unclaim,
          can_resume: row.can_resume,
          expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        };
      }

      // Unauthenticated — mask voucher_code, receipt_amount, shop_name, can_resume
      return {
        id: row.id,
        voucher_code: 'CLM-••••••••',
        barcode_format: row.barcode_format || 'CODE128',
        receipt_amount: null,
        receipt_date: row.receipt_date instanceof Date ? row.receipt_date.toISOString().slice(0, 10) : String(row.receipt_date).slice(0, 10),
        shop_name: null,
        status: row.status,
        can_unclaim: row.can_unclaim,
        can_resume: false,
        expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      };
    }));

    return new Response(
      JSON.stringify({
        success: true,
        vehicle_plate: canonicalPlate,
        data,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'INTERNAL_ERROR', message: err.message || 'An unexpected error occurred' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};