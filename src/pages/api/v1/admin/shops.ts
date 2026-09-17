/**
 * Admin API: /api/v1/admin/shops
 * POST: Create a new shop
 * PATCH: Update an existing shop (id in body)
 * DELETE: Remove a shop (id in body)
 * Requires X-Admin-Key or Authorization header.
 */

import type { APIRoute } from 'astro';
import { getDb } from '../../../../db/connection';
import { INSERT_SHOP_QUERY, UPDATE_SHOP_QUERY, DELETE_SHOP_QUERY } from '../../../../db/queries';

function isAuthorized(request: Request): boolean {
  const adminKey = request.headers.get('X-Admin-Key');
  const auth = request.headers.get('Authorization');
  const expectedKey = process.env.ADMIN_API_KEY;
  if (!expectedKey) return false;
  if (adminKey === expectedKey) return true;
  if (auth === `Bearer ${expectedKey}`) return true;
  return false;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const POST: APIRoute = async ({ request }) => {
  if (!isAuthorized(request)) {
    return new Response(
      JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or missing admin credentials.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await request.json();
    const { name, category, level, unit, is_active, is_eligible, ineligibility_reason } = body;

    if (!name || !category || !level || !unit) {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_FIELDS', message: 'name, category, level, and unit are required.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const slug = slugify(name);
    const sql = getDb();

    const rows = await sql.unsafe(INSERT_SHOP_QUERY, [
      name,
      slug,
      category,
      level,
      unit,
      is_active ?? true,
      is_eligible ?? true,
      ineligibility_reason ?? null,
    ]);

    return new Response(
      JSON.stringify({ success: true, data: rows[0] }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    if (err.message?.includes('duplicate key') || err.message?.includes('unique')) {
      return new Response(
        JSON.stringify({ success: false, error: 'DUPLICATE', message: 'A shop with this name already exists.' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ success: false, error: 'INTERNAL_ERROR', message: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const PATCH: APIRoute = async ({ request }) => {
  if (!isAuthorized(request)) {
    return new Response(
      JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or missing admin credentials.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await request.json();
    const { id, name, slug, category, level, unit, is_active, is_eligible, ineligibility_reason } = body;

    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_ID', message: 'Shop ID is required in request body.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const sql = getDb();
    const rows = await sql.unsafe(UPDATE_SHOP_QUERY, [
      id,
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

export const DELETE: APIRoute = async ({ request }) => {
  if (!isAuthorized(request)) {
    return new Response(
      JSON.stringify({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or missing admin credentials.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: 'MISSING_ID', message: 'Shop ID is required in request body.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const sql = getDb();
    const rows = await sql.unsafe(DELETE_SHOP_QUERY, [id]);

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