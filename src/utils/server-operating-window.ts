import { getDb } from '../db/connection';
import { GET_PUBLIC_HOLIDAYS_QUERY } from '../db/queries';
import { checkOperatingWindow, type OperatingWindowResult } from './operating-window';

interface DbHolidayRow {
  holiday_date: string;
  holiday_name: string;
  is_closed: boolean;
  notes?: string;
}

let cachedOverrides: Record<string, { name: string; is_closed: boolean }> | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60_000; // 60-second in-memory TTL

/**
 * Loads holiday overrides from PostgreSQL (managed via NocoDB).
 * Safe fallback to empty object / static calendar if DB is unreachable.
 */
export async function getDbHolidayOverrides(): Promise<
  Record<string, { name: string; is_closed: boolean }>
> {
  const now = Date.now();
  if (cachedOverrides && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedOverrides;
  }

  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, holiday_name, is_closed, notes
      FROM public_holidays
      ORDER BY holiday_date ASC
    `) as DbHolidayRow[];
    const map: Record<string, { name: string; is_closed: boolean }> = {};
    for (const row of rows) {
      map[row.holiday_date] = {
        name: row.holiday_name,
        is_closed: row.is_closed,
      };
    }
    cachedOverrides = map;
    lastCacheTime = now;
    return map;
  } catch (err) {
    console.warn('[operating-window] Failed to fetch holidays from DB, using fallback:', err);
    return cachedOverrides || {};
  }
}

/**
 * Server-side evaluation of operating window including dynamic NocoDB overrides.
 */
export async function checkServerOperatingWindow(
  date: Date = new Date()
): Promise<OperatingWindowResult> {
  const overrides = await getDbHolidayOverrides();
  return checkOperatingWindow(date, overrides);
}
