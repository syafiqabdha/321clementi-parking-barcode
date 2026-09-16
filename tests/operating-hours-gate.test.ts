/**
 * 321 Clementi Smart Parking Redemption Engine
 * Operating Hours Gate Tests (PAN-64)
 * 
 * Test time verification: operating window enforcement for 
 * 12:00 PM – 3:00 PM weekdays in Singapore (SGT).
 */

import { describe, test, expect } from 'bun:test';

// ============================================================================
// Core Algorithm (mirrors n8n operating window gate node)
// Takes explicit SGT hour, minute, dayOfWeek (0=Sun..6=Sat)
// Returns structured result for deterministic unit testing.
// ============================================================================

interface SGTTimeResult {
  allowed: boolean;
  reason: string;
}

/**
 * Check if the given SGT timestamp falls within operating window.
 * Operating hours: 12:00 PM – 3:00 PM (15:00) on weekdays only.
 * Inclusive of 12:00, exclusive of 15:00.
 * @param utcHour - Hour in UTC
 * @param utcMinute - Minute in UTC  
 * @param utcDayOfWeek - Day of week in UTC (0=Sun..6=Sat)
 */
function checkOperatingWindow(utcHour: number, utcMinute: number, utcDayOfWeek: number): SGTTimeResult {
  // Convert UTC → SGT (+8h), wrapping days accordingly
  let sgtHour = utcHour + 8;
  let sgtDayOffset = 0;
  while (sgtHour >= 24) {
    sgtHour -= 24;
    sgtDayOffset += 1;
  }
  while (sgtHour < 0) {
    sgtHour += 24;
    sgtDayOffset -= 1;
  }
  const sgtDayOfWeek = (utcDayOfWeek + sgtDayOffset) % 7;
  const totalMinutes = sgtHour * 60 + utcMinute;

  // Weekday check: Monday(1) through Friday(5)
  if (sgtDayOfWeek === 0 || sgtDayOfWeek === 6) {
    return { allowed: false, reason: 'WEEKEND_NOT_ALLOWED' };
  }

  // Operating window: 720 minutes (12:00) to 900 minutes (15:00)
  if (totalMinutes < 720) {
    return { allowed: false, reason: 'BEFORE_OPERATING_HOURS' };
  }
  if (totalMinutes >= 900) {
    return { allowed: false, reason: 'AFTER_OPERATING_HOURS' };
  }

  return { allowed: true, reason: 'WITHIN_OPERATING_WINDOW' };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Operating Hours Gate Tests (PAN-64)', () => {
  
  // --- Section 1: Boundary Time Testing ---
  describe('Boundary Time Verification', () => {
    test('11:59 AM SGT must be rejected — before operating hours', () => {
      // SGT 11:59 = UTC 03:59 (same day)
      const result = checkOperatingWindow(3, 59, 1); // Monday
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('BEFORE_OPERATING_HOURS');
    });

    test('12:00 PM SGT must be accepted — exact start of operating hours', () => {
      // SGT 12:00 = UTC 04:00 (same day)
      const result = checkOperatingWindow(4, 0, 1); // Monday
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('WITHIN_OPERATING_WINDOW');
    });

    test('12:01 PM SGT must be accepted', () => {
      const result = checkOperatingWindow(4, 1, 1); // Monday
      expect(result.allowed).toBe(true);
    });

    test('2:59 PM SGT must be accepted — just before cutoff', () => {
      // SGT 14:59 = UTC 06:59 (same day)
      const result = checkOperatingWindow(6, 59, 1); // Monday
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('WITHIN_OPERATING_WINDOW');
    });

    test('3:00 PM SGT must be rejected — at/exact operating hours cutoff', () => {
      // SGT 15:00 = UTC 07:00 (same day)
      const result = checkOperatingWindow(7, 0, 1); // Monday
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('AFTER_OPERATING_HOURS');
    });

    test('3:01 PM SGT must be rejected — after operating hours', () => {
      const result = checkOperatingWindow(7, 1, 1); // Monday
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('AFTER_OPERATING_HOURS');
    });

    test('6:00 PM SGT must be rejected — far past operating hours', () => {
      // SGT 18:00 = UTC 10:00 (same day)
      const result = checkOperatingWindow(10, 0, 1); // Monday
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('AFTER_OPERATING_HOURS');
    });

    test('Midnight SGT must be rejected — outside operating hours', () => {
      // SGT 00:00 = UTC 16:00 (previous day in UTC)
      const result = checkOperatingWindow(16, 0, 0); // Sunday midnight
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('BEFORE_OPERATING_HOURS');
    });
  });

  // --- Section 2: Weekend Rejection ---
  describe('Weekend Access Denial', () => {
    test('Saturday noon SGT must be rejected regardless of time', () => {
      // Saturday noon SGT (12:00) = UTC 04:00 Saturday → UTC 04:00+0 = day 6
      const result = checkOperatingWindow(4, 0, 6);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('WEEKEND_NOT_ALLOWED');
    });

    test('Sunday any time must be rejected with weekend reason', () => {
      const result = checkOperatingWindow(4, 30, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('WEEKEND_NOT_ALLOWED');
    });

    test('Saturday midnight SGT must also be rejected with weekend reason', () => {
      const result = checkOperatingWindow(16, 0, 6); // UTC Saturday evening → Saturday midnight SGT next day? No...
      // Actually let me verify: UTC 16:00 Saturday = SGT 00:00 Sunday (because +8 goes into next day)
      // Wait no: Saturday UTC 16:00 + 8h = Sunday SGT 00:00 → day wraps
      // So this test as written: utcDay=6 (Sat), hour=16, min=0
      // sgtHour = 16+8 = 24 → sgtHour=0, sgtDayOffset=1
      // sgtDayOfWeek = (6+1)%7 = 0 (Sunday) → WEEKEND
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('WEEKEND_NOT_ALLOWED');
    });
  });

  // --- Section 3: Weekday Validation ---
  describe('Weekday Acceptance', () => {
    const weekDaysNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

    for (let i = 1; i <= 5; i++) {
      test(`${weekDaysNames[i - 1]} at 12:00 PM SGT must be accepted`, () => {
        const result = checkOperatingWindow(4, 0, i);
        expect(result.allowed).toBe(true);
      });

      test(`${weekDaysNames[i - 1]} at 2:00 PM SGT must be accepted`, () => {
        const result = checkOperatingWindow(6, 0, i);
        expect(result.allowed).toBe(true);
      });

      test(`${weekDaysNames[i - 1]} at 11:59 AM SGT must be rejected`, () => {
        const result = checkOperatingWindow(3, 59, i);
        expect(result.allowed).toBe(false);
      });

      test(`${weekDaysNames[i - 1]} at 3:00 PM SGT must be rejected`, () => {
        const result = checkOperatingWindow(7, 0, i);
        expect(result.allowed).toBe(false);
      });
    }
  });

  // --- Section 4: Exact Boundary Edge Cases ---
  describe('Exact Boundary Edge Cases', () => {
    test('12:00 exactly on Friday must accept', () => {
      const result = checkOperatingWindow(4, 0, 5);
      expect(result.allowed).toBe(true);
    });

    test('14:59 exactly on Friday must still accept', () => {
      const result = checkOperatingWindow(6, 59, 5);
      expect(result.allowed).toBe(true);
    });

    test('15:00 exactly on Friday must reject', () => {
      const result = checkOperatingWindow(7, 0, 5);
      expect(result.allowed).toBe(false);
    });

    test('Last second of window (14:59 SGT) accepts', () => {
      const result = checkOperatingWindow(6, 59, 3); // Wednesday
      expect(result.allowed).toBe(true);
    });

    test('First second past window (15:00 SGT) rejects', () => {
      const result = checkOperatingWindow(7, 0, 3); // Wednesday
      expect(result.allowed).toBe(false);
    });
  });

  // --- Section 5: Cross-Day Boundary ---
  describe('Cross-Day Timezone Boundaries', () => {
    test('SGT late night crossing into next weekday must work', () => {
      // Friday 11PM SGT = UTC 11AM Friday → sgtHour=0, sgtDay=(4+1)=5(Fri)? No...
      // UTC 11:00 Friday → sgtHour=11+8=19, sgtDayOfWeek=4(Fri)
      // That's within range (11PM is > 15:00) so should reject
      const result = checkOperatingWindow(11, 0, 4);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('AFTER_OPERATING_HOURS');
    });

    test('SGT early morning Monday must accept', () => {
      // Monday 12:00 SGT = UTC 04:00 Monday
      const result = checkOperatingWindow(4, 0, 1);
      expect(result.allowed).toBe(true);
    });

    test('UTC edge: Sunday 23:00 UTC = Monday 07:00 SGT — should be rejected (after hours)', () => {
      const result = checkOperatingWindow(23, 0, 0);
      // sgtHour = 23+8 = 31 → 31-24 = 7, sgtDayOffset = 1
      // sgtDayOfWeek = (0+1)%7 = 1 (Monday)
      // totalMinutes = 7*60+0 = 420 < 720 → BEFORE
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('BEFORE_OPERATING_HOURS');
    });
  });

  // --- Section 6: Multiple Consecutive Calls Consistency ---
  describe('Call Consistency', () => {
    test('Same inputs produce consistent results across many calls', () => {
      const results = [];
      for (let i = 0; i < 100; i++) {
        results.push(checkOperatingWindow(4, 30, 2)); // Tuesday noon
      }
      
      const firstAllowed = results[0].allowed;
      const firstReason = results[0].reason;
      for (const r of results) {
        expect(r.allowed).toBe(firstAllowed);
        expect(r.reason).toBe(firstReason);
      }
    });

    test('All boundary cases consistently hit correct branch', () => {
      const boundaries = [
        { h: 3, m: 59, d: 1, expected: false },   // Before
        { h: 4, m: 0, d: 1, expected: true },      // At start
        { h: 6, m: 59, d: 1, expected: true },     // Near end
        { h: 7, m: 0, d: 1, expected: false },     // At cutoff
      ];
      
      for (const b of boundaries) {
        const result = checkOperatingWindow(b.h, b.m, b.d);
        expect(result.allowed).toBe(b.expected);
      }
    });
  });
});
