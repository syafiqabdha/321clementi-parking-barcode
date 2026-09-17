/**
 * GET /api/v1/shops
 * Retrieve tenant store directory for form population.
 * Query: ?category=Dine|Learn|Relax|Services&eligible_only=true
 */

import type { APIRoute } from 'astro';
import { getDb } from '../../../db/connection';
import { GET_SHOPS_QUERY } from '../../../db/queries';

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get('category') || null;
    const eligibleOnly = url.searchParams.get('eligible_only') !== 'false'; // default true

    const sql = getDb();

    let shops;
    if (eligibleOnly) {
      shops = await sql.unsafe(GET_SHOPS_QUERY, [category]);
    } else {
      // Return all shops including ineligible ones (admin use)
      shops = await sql`
        SELECT id, name, slug, category, level, unit, is_active, is_eligible, ineligibility_reason
        FROM shops
        ${category ? sql`WHERE category = ${category}` : sql``}
        ORDER BY category, name
      `;
    }

    return new Response(
      JSON.stringify({
        success: true,
        count: shops.length,
        data: shops,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'INTERNAL_ERROR',
        message: err.message || 'An unexpected error occurred',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};