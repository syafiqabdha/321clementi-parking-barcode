import { describe, it, expect } from 'bun:test';
import {
  checkOperatingWindow,
  SINGAPORE_PUBLIC_HOLIDAYS,
} from '../src/utils/operating-window';

describe('Singapore Operating Window & Public Holidays Policy', () => {
  it('allows redemptions during the official lunch window (12:00 PM – 3:00 PM)', () => {
    // 2026-09-28 is a Monday. 04:30 UTC = 12:30 SGT
    const monday1230 = new Date('2026-09-28T04:30:00Z');
    const result = checkOperatingWindow(monday1230);

    expect(result.allowed).toBe(true);
    expect(result.isGracePeriod).toBe(false);
    expect(result.reason).toBe('WITHIN_OPERATING_WINDOW');
    expect(result.sgtTime).toBe('12:30:00');
  });

  it('allows early redemptions within the 30-minute grace buffer (11:30 AM – 11:59 AM)', () => {
    // 2026-09-28 Monday 03:30 UTC = 11:30 SGT (exact boundary)
    const monday1130 = new Date('2026-09-28T03:30:00Z');
    const result1130 = checkOperatingWindow(monday1130);
    expect(result1130.allowed).toBe(true);
    expect(result1130.isGracePeriod).toBe(true);
    expect(result1130.reason).toBe('GRACE_PERIOD');

    // 03:45 UTC = 11:45 SGT
    const monday1145 = new Date('2026-09-28T03:45:00Z');
    const result1145 = checkOperatingWindow(monday1145);
    expect(result1145.allowed).toBe(true);
    expect(result1145.isGracePeriod).toBe(true);
  });

  it('allows late redemptions within the 30-minute grace buffer (3:00 PM – 3:29 PM)', () => {
    // 07:00 UTC = 15:00 SGT (3:00 PM)
    const monday1500 = new Date('2026-09-28T07:00:00Z');
    const result1500 = checkOperatingWindow(monday1500);
    expect(result1500.allowed).toBe(true);
    expect(result1500.isGracePeriod).toBe(true);
    expect(result1500.reason).toBe('GRACE_PERIOD');

    // 07:29 UTC = 15:29 SGT (3:29 PM)
    const monday1529 = new Date('2026-09-28T07:29:00Z');
    const result1529 = checkOperatingWindow(monday1529);
    expect(result1529.allowed).toBe(true);
    expect(result1529.isGracePeriod).toBe(true);
  });

  it('rejects redemptions before 11:30 AM (outside early grace buffer)', () => {
    // 03:29 UTC = 11:29 SGT
    const monday1129 = new Date('2026-09-28T03:29:00Z');
    const result = checkOperatingWindow(monday1129);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('BEFORE_OPERATING_HOURS');
  });

  it('rejects redemptions at or after 3:30 PM (outside late grace buffer)', () => {
    // 07:30 UTC = 15:30 SGT (exact late cutoff)
    const monday1530 = new Date('2026-09-28T07:30:00Z');
    const result = checkOperatingWindow(monday1530);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('AFTER_OPERATING_HOURS');

    // 08:00 UTC = 16:00 SGT
    const monday1600 = new Date('2026-09-28T08:00:00Z');
    const result1600 = checkOperatingWindow(monday1600);
    expect(result1600.allowed).toBe(false);
    expect(result1600.reason).toBe('AFTER_OPERATING_HOURS');
  });

  it('rejects redemptions on weekends (Saturday & Sunday)', () => {
    // 2026-09-26 is Saturday 04:30 UTC = 12:30 SGT
    const saturday = new Date('2026-09-26T04:30:00Z');
    const satResult = checkOperatingWindow(saturday);
    expect(satResult.allowed).toBe(false);
    expect(satResult.reason).toBe('WEEKEND_NOT_ALLOWED');

    // 2026-09-27 is Sunday
    const sunday = new Date('2026-09-27T04:30:00Z');
    const sunResult = checkOperatingWindow(sunday);
    expect(sunResult.allowed).toBe(false);
    expect(sunResult.reason).toBe('WEEKEND_NOT_ALLOWED');
  });

  it('rejects redemptions on Singapore Public Holidays occurring on weekdays', () => {
    // Labour Day: 2026-05-01 (Friday) at 12:30 PM SGT (04:30 UTC)
    const labourDay = new Date('2026-05-01T04:30:00Z');
    const resLabour = checkOperatingWindow(labourDay);
    expect(resLabour.allowed).toBe(false);
    expect(resLabour.reason).toBe('PUBLIC_HOLIDAY_NOT_ALLOWED');
    expect(resLabour.holidayName).toBe('Labour Day');

    // Good Friday: 2026-04-03 (Friday) at 1:00 PM SGT
    const goodFriday = new Date('2026-04-03T05:00:00Z');
    const resGoodFriday = checkOperatingWindow(goodFriday);
    expect(resGoodFriday.allowed).toBe(false);
    expect(resGoodFriday.reason).toBe('PUBLIC_HOLIDAY_NOT_ALLOWED');
    expect(resGoodFriday.holidayName).toBe('Good Friday');

    // National Day observed Monday: 2026-08-10 at 12:00 PM SGT
    const nationalDayObserved = new Date('2026-08-10T04:00:00Z');
    const resND = checkOperatingWindow(nationalDayObserved);
    expect(resND.allowed).toBe(false);
    expect(resND.reason).toBe('PUBLIC_HOLIDAY_NOT_ALLOWED');
    expect(resND.holidayName).toBe('National Day (Observed)');
  });
});
