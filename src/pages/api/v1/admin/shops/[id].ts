/**
 * Admin API: /api/v1/admin/shops/[id]
 * PATCH: Update an existing shop
 * DELETE: Remove a shop
 * Requires X-Admin-Key or Authorization header.
 */

import type { APIRoute } from 'astro';
import { getDb } from '../../../../../db/connection';
import { UPDATE_SHOP_QUERY, DELETE_SHOP_QUERY } from '../../../../../db/queries';

function isAuthorized(request: Request): boolean {
  const adminKey = request.headers.get('X-Admin-Key');
  const auth = request.headers.get('Authorization');
  const expectedKey = process.env.ADMIN_API_KEY;
  if (!expectedKey) return false;
  if (adminKey === expectedKey) return true;
  if (auth === `Bearer ${expectedKey}`) return true;
  return false;
}

export const PATCH: APIRoute = async ({ request, params }) => {
  if (!isAuthorized(request)) {
    return new Response(
      JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or missing admin credentials.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const shopId = params.id;
    if (!shopId) {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_ID', message: 'Shop ID is required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const body = await request.json();
    const { name, slug, category, level, unit, is_active, is_eligible, ineligibility_reason } = body;

    const sql = getDb();

    const rows = await sql.unsafe(UPDATE_SHOP_QUERY, [
      shopId,
      name ?? null,
      slug ?? null,
      category ?? null,
      level ?? null,
      unit ?? null,
      is_active ?? null,
      is_eligible ?? null,
      ineligibility_reason ?? null,
    ]);

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'NOT_FOUND', message: 'Shop not found.' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: rows[0] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'INTERNAL_ERROR', message: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  if (!isAuthorized(request)) {
    return new Response(
      JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or missing admin credentials.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const shopId = params.id;
    if (!shopId) {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_ID', message: 'Shop ID is required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const sql = getDb();

    const rows = await sql.unsafe(DELETE_SHOP_QUERY, [shopId]);

    if (rows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'NOT_FOUND', message: 'Shop not found.' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Shop deleted successfully.' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: 'INTERNAL_ERROR', message: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};