import { describe, it, expect } from 'bun:test';
import {
  checkOperatingWindow,
} from '../src/utils/operating-window';

describe('Singapore Operating Window Policy (Strict 12:00 PM – 3:00 PM SGT)', () => {
  it('allows redemptions strictly between 12:00 PM and 3:00 PM on weekdays', () => {
    // 2026-09-28 is a Monday. 04:00 UTC = 12:00 SGT (exact start)
    const monday1200 = new Date('2026-09-28T04:00:00Z');
    const res1200 = checkOperatingWindow(monday1200);
    expect(res1200.allowed).toBe(true);
    expect(res1200.reason).toBe('WITHIN_OPERATING_WINDOW');
    expect(res1200.sgtTime).toBe('12:00:00');

    // 04:30 UTC = 12:30 SGT
    const monday1230 = new Date('2026-09-28T04:30:00Z');
    const res1230 = checkOperatingWindow(monday1230);
    expect(res1230.allowed).toBe(true);

    // 06:59 UTC = 14:59 SGT (2:59 PM)
    const monday1459 = new Date('2026-09-28T06:59:00Z');
    const res1459 = checkOperatingWindow(monday1459);
    expect(res1459.allowed).toBe(true);
  });

  it('rejects redemptions before 12:00 PM (e.g. 11:30 AM or 11:59 AM)', () => {
    // 03:30 UTC = 11:30 SGT
    const monday1130 = new Date('2026-09-28T03:30:00Z');
    const res1130 = checkOperatingWindow(monday1130);
    expect(res1130.allowed).toBe(false);
    expect(res1130.reason).toBe('BEFORE_OPERATING_HOURS');

    // 03:59 UTC = 11:59 SGT
    const monday1159 = new Date('2026-09-28T03:59:00Z');
    const res1159 = checkOperatingWindow(monday1159);
    expect(res1159.allowed).toBe(false);
    expect(res1159.reason).toBe('BEFORE_OPERATING_HOURS');
  });

  it('rejects redemptions at or after 3:00 PM (e.g. 15:00:00 SGT)', () => {
    // 07:00 UTC = 15:00 SGT (3:00 PM sharp cutoff)
    const monday1500 = new Date('2026-09-28T07:00:00Z');
    const res1500 = checkOperatingWindow(monday1500);
    expect(res1500.allowed).toBe(false);
    expect(res1500.reason).toBe('AFTER_OPERATING_HOURS');

    // 07:15 UTC = 15:15 SGT (3:15 PM)
    const monday1515 = new Date('2026-09-28T07:15:00Z');
    const res1515 = checkOperatingWindow(monday1515);
    expect(res1515.allowed).toBe(false);
    expect(res1515.reason).toBe('AFTER_OPERATING_HOURS');
  });

  it('rejects redemptions on weekends (Saturday & Sunday)', () => {
    // 2026-09-26 Saturday at 12:30 PM SGT
    const saturday = new Date('2026-09-26T04:30:00Z');
    expect(checkOperatingWindow(saturday).allowed).toBe(false);

    // 2026-09-27 Sunday at 12:30 PM SGT
    const sunday = new Date('2026-09-27T04:30:00Z');
    expect(checkOperatingWindow(sunday).allowed).toBe(false);
  });

  it('rejects redemptions on Singapore Public Holidays occurring on weekdays', () => {
    // Labour Day: 2026-05-01 (Friday) at 12:30 PM SGT
    const labourDay = new Date('2026-05-01T04:30:00Z');
    const resLabour = checkOperatingWindow(labourDay);
    expect(resLabour.allowed).toBe(false);
    expect(resLabour.reason).toBe('PUBLIC_HOLIDAY_NOT_ALLOWED');
    expect(resLabour.holidayName).toBe('Labour Day');
  });
});
