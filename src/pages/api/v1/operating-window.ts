import type { APIRoute } from 'astro';
import {
  checkServerOperatingWindow,
  getDbHolidayOverrides,
} from '../../../utils/server-operating-window';

export const GET: APIRoute = async () => {
  try {
    const status = await checkServerOperatingWindow();
    const overrides = await getDbHolidayOverrides();

    return new Response(
      JSON.stringify({
        success: true,
        data: status,
        holidays_count: Object.keys(overrides).length,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30',
        },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to query operating window';
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
