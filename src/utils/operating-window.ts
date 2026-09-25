/**
 * 321 Clementi Smart Parking Barcode Redemption Engine
 * Singapore Operating Window & Public Holidays Policy
 *
 * Rules:
 *   - Official Promotion Hours: 12:00 PM – 3:00 PM SGT, Weekdays (Monday–Friday).
 *   - Grace Buffer: Accepts redemptions 30 minutes earlier (starts 11:30 AM)
 *     and 30 minutes after (ends 3:30 PM / 15:30 SGT).
 *   - Effective Window: 11:30 AM <= SGT Time < 3:30 PM (15:30).
 *   - Exclusions: Weekends (Saturdays & Sundays) AND Singapore Public Holidays
 *     falling on weekdays (including observed Mondays).
 */

export const SINGAPORE_PUBLIC_HOLIDAYS: Record<string, string> = {
  // 2026 Singapore Official Statutory Public Holidays (MOM)
  '2026-01-01': "New Year's Day",
  '2026-02-17': 'Chinese New Year (Day 1)',
  '2026-02-18': 'Chinese New Year (Day 2)',
  '2026-03-20': 'Hari Raya Puasa',
  '2026-04-03': 'Good Friday',
  '2026-05-01': 'Labour Day',
  '2026-05-27': 'Hari Raya Haji',
  '2026-05-31': 'Vesak Day',
  '2026-06-01': 'Vesak Day (Observed)',
  '2026-08-09': 'National Day',
  '2026-08-10': 'National Day (Observed)',
  '2026-11-08': 'Deepavali',
  '2026-11-09': 'Deepavali (Observed)',
  '2026-12-25': 'Christmas Day',

  // 2025
  '2025-01-01': "New Year's Day",
  '2025-01-29': 'Chinese New Year',
  '2025-01-30': 'Chinese New Year',
  '2025-03-31': 'Hari Raya Puasa',
  '2025-04-18': 'Good Friday',
  '2025-05-01': 'Labour Day',
  '2025-05-12': 'Vesak Day',
  '2025-06-07': 'Hari Raya Haji',
  '2025-08-09': 'National Day',
  '2025-10-20': 'Deepavali',
  '2025-12-25': 'Christmas Day',

  // 2027
  '2027-01-01': "New Year's Day",
  '2027-02-06': 'Chinese New Year',
  '2027-02-07': 'Chinese New Year',
  '2027-02-08': 'Chinese New Year (Observed)',
  '2027-03-10': 'Hari Raya Puasa',
  '2027-03-26': 'Good Friday',
  '2027-05-01': 'Labour Day',
  '2027-05-17': 'Hari Raya Haji',
  '2027-05-20': 'Vesak Day',
  '2027-08-09': 'National Day',
  '2027-10-29': 'Deepavali',
  '2027-12-25': 'Christmas Day',
};

export type OperatingWindowReason =
  | 'WITHIN_OPERATING_WINDOW'
  | 'GRACE_PERIOD'
  | 'BEFORE_OPERATING_HOURS'
  | 'AFTER_OPERATING_HOURS'
  | 'WEEKEND_NOT_ALLOWED'
  | 'PUBLIC_HOLIDAY_NOT_ALLOWED';

export interface OperatingWindowResult {
  allowed: boolean;
  isGracePeriod: boolean;
  reason: OperatingWindowReason;
  message: string;
  holidayName?: string;
  sgtDate: string;
  sgtTime: string;
  sgtDayOfWeek: number; // 0=Sun..6=Sat
}

/**
 * Checks whether the specified timestamp in Singapore Time (SGT) is eligible for redemption.
 *
 * @param date - Date to check (defaults to current system time).
 * @param graceBufferMinutes - Grace buffer in minutes before 12:00 and after 15:00 (default: 30).
 * @param holidayOverrides - Optional DB-backed holiday map from back-office NocoDB { [dateStr]: { name: string, is_closed: boolean } }.
 */
export function checkOperatingWindow(
  date: Date = new Date(),
  graceBufferMinutes: number = 30,
  holidayOverrides?: Record<string, { name: string; is_closed: boolean }>
): OperatingWindowResult {
  // Format accurately to Asia/Singapore (SGT = UTC+8)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const year = getPart('year');
  const month = getPart('month');
  const day = getPart('day');
  const weekdayStr = getPart('weekday');
  const hours = parseInt(getPart('hour'), 10);
  const minutes = parseInt(getPart('minute'), 10);
  const seconds = parseInt(getPart('second'), 10);

  const sgtDate = `${year}-${month}-${day}`;
  const sgtTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const sgtDayOfWeek = dayMap[weekdayStr] ?? 0;

  // 1. Weekend check
  if (sgtDayOfWeek === 0 || sgtDayOfWeek === 6) {
    return {
      allowed: false,
      isGracePeriod: false,
      reason: 'WEEKEND_NOT_ALLOWED',
      message: 'Redemption is only available Monday to Friday (excluding Public Holidays).',
      sgtDate,
      sgtTime,
      sgtDayOfWeek,
    };
  }

  // 2. Singapore Public Holiday check (NocoDB DB overrides take precedence, then built-in calendar)
  let isHolidayClosed = false;
  let holidayName: string | undefined;

  if (holidayOverrides && holidayOverrides[sgtDate]) {
    const override = holidayOverrides[sgtDate];
    holidayName = override.name;
    isHolidayClosed = override.is_closed;
  } else {
    holidayName = SINGAPORE_PUBLIC_HOLIDAYS[sgtDate];
    isHolidayClosed = Boolean(holidayName);
  }

  if (isHolidayClosed && holidayName) {
    return {
      allowed: false,
      isGracePeriod: false,
      reason: 'PUBLIC_HOLIDAY_NOT_ALLOWED',
      message: `Redemption is closed on Singapore Public Holidays (${holidayName}).`,
      holidayName,
      sgtDate,
      sgtTime,
      sgtDayOfWeek,
    };
  }

  // 3. Time calculation in minutes from midnight
  const currentMinutes = hours * 60 + minutes;
  const officialStart = 12 * 60; // 12:00 = 720
  const officialEnd = 15 * 60;   // 15:00 = 900
  const earlyStart = officialStart - graceBufferMinutes; // 11:30 = 690
  const lateEnd = officialEnd + graceBufferMinutes;       // 15:30 = 930

  // Before early grace cutoff (before 11:30 AM)
  if (currentMinutes < earlyStart) {
    return {
      allowed: false,
      isGracePeriod: false,
      reason: 'BEFORE_OPERATING_HOURS',
      message: 'Redemption opens at 12:00 PM (11:30 AM early access).',
      sgtDate,
      sgtTime,
      sgtDayOfWeek,
    };
  }

  // After late grace cutoff (at or after 3:30 PM / 15:30)
  if (currentMinutes >= lateEnd) {
    return {
      allowed: false,
      isGracePeriod: false,
      reason: 'AFTER_OPERATING_HOURS',
      message: 'Redemption window closed at 3:00 PM (3:30 PM cutoff).',
      sgtDate,
      sgtTime,
      sgtDayOfWeek,
    };
  }

  // Grace buffer active (11:30–12:00 or 15:00–15:30)
  const isGrace = currentMinutes < officialStart || currentMinutes >= officialEnd;
  return {
    allowed: true,
    isGracePeriod: isGrace,
    reason: isGrace ? 'GRACE_PERIOD' : 'WITHIN_OPERATING_WINDOW',
    message: isGrace ? '12:00 PM – 3:00 PM (Grace Period Active)' : '12:00 PM – 3:00 PM Active',
    sgtDate,
    sgtTime,
    sgtDayOfWeek,
  };
}
