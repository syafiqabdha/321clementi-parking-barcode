/**
 * 321 Clementi Smart Parking Redemption Engine
 * Rate Limiter Unit Tests (PAN-77 / ADR-001)
 * 
 * Verifies:
 * - History endpoint: max 10 req/min per IP
 * - Plate scan limit: max 5 distinct plates/hr per IP
 * - Unclaim limit: max 3 attempts/plate/day
 * - Unclaim cooldown: 60s between attempts
 */

import { describe, test, expect } from 'bun:test';
import {
  checkHistoryRateLimit,
  checkPlateHistoryScanLimit,
  checkUnclaimRateLimit,
  checkUnclaimCooldown,
} from '../src/utils/rate-limiter';

describe('Rate Limiter (PAN-77)', () => {
  
  describe('History Endpoint Rate Limiting', () => {
    test('Allows up to 10 requests per minute per IP', () => {
      const ip = '192.168.1.1';
      for (let i = 0; i < 10; i++) {
        const result = checkHistoryRateLimit(ip);
        expect(result.allowed).toBe(true);
      }
    });

    test('Blocks 11th request within same minute', () => {
      const ip = '192.168.1.2';
      for (let i = 0; i < 10; i++) {
        checkHistoryRateLimit(ip);
      }
      const blocked = checkHistoryRateLimit(ip);
      expect(blocked.allowed).toBe(false);
    });

    test('Different IPs have independent limits', () => {
      const ip1 = '192.168.1.10';
      const ip2 = '192.168.1.20';
      for (let i = 0; i < 10; i++) {
        checkHistoryRateLimit(ip1);
      }
      // ip2 should still be allowed
      const result = checkHistoryRateLimit(ip2);
      expect(result.allowed).toBe(true);
    });
  });

  describe('Plate Scan Limiting (Anti-Enumeration)', () => {
    test('Allows up to 5 distinct plates per IP per hour', () => {
      const ip = '10.0.0.1';
      const plates = ['SBA1234A', 'GBA5678B', 'JQR1234', 'W1234A', 'XYZ9999Z'];
      for (const plate of plates) {
        const result = checkPlateHistoryScanLimit(ip, plate);
        expect(result.allowed).toBe(true);
      }
    });

    test('Blocks 6th distinct plate within the hour', () => {
      const ip = '10.0.0.2';
      const plates = ['SBA1234A', 'GBA5678B', 'JQR1234', 'W1234A', 'XYZ9999Z', 'TEST12'];
      let blocked = null;
      for (const plate of plates) {
        const result = checkPlateHistoryScanLimit(ip, plate);
        if (!result.allowed) blocked = result;
      }
      expect(blocked).not.toBeNull();
      expect(blocked!.allowed).toBe(false);
    });

    test('Same plate looked up multiple times does not count toward distinct limit', () => {
      const ip = '10.0.0.3';
      for (let i = 0; i < 20; i++) {
        const result = checkPlateHistoryScanLimit(ip, 'SBA1234A');
        expect(result.allowed).toBe(true);
      }
    });
  });

  describe('Unclaim Rate Limiting', () => {
    test('Allows up to 3 unclaim attempts per plate per day', () => {
      const plate = 'UNCLAIM-TEST-1';
      for (let i = 0; i < 3; i++) {
        const result = checkUnclaimRateLimit(plate);
        expect(result.allowed).toBe(true);
      }
    });

    test('Blocks 4th unclaim attempt on same plate', () => {
      const plate = 'UNCLAIM-TEST-2';
      for (let i = 0; i < 3; i++) {
        checkUnclaimRateLimit(plate);
      }
      const blocked = checkUnclaimRateLimit(plate);
      expect(blocked.allowed).toBe(false);
    });

    test('Different plates have independent unclaim limits', () => {
      const plate1 = 'UNCLAIM-A';
      const plate2 = 'UNCLAIM-B';
      for (let i = 0; i < 3; i++) {
        checkUnclaimRateLimit(plate1);
      }
      const result = checkUnclaimRateLimit(plate2);
      expect(result.allowed).toBe(true);
    });
  });

  describe('Unclaim Cooldown', () => {
    test('First attempt on a redemption ID is always allowed', () => {
      const result = checkUnclaimCooldown('redemption-cooldown-1');
      expect(result.allowed).toBe(true);
    });

    test('Second attempt on same redemption ID within 60s is blocked', () => {
      const id = 'redemption-cooldown-2';
      checkUnclaimCooldown(id);
      const blocked = checkUnclaimCooldown(id);
      expect(blocked.allowed).toBe(false);
    });

    test('Different redemption IDs have independent cooldowns', () => {
      checkUnclaimCooldown('redemption-cooldown-A');
      const result = checkUnclaimCooldown('redemption-cooldown-B');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Rate Limit Reset Behavior', () => {
    test('Retry-after is provided when rate limited', () => {
      const ip = '192.168.1.100';
      for (let i = 0; i < 10; i++) {
        checkHistoryRateLimit(ip);
      }
      const blocked = checkHistoryRateLimit(ip);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBeDefined();
      expect(blocked.retryAfterMs!).toBeGreaterThan(0);
    });
  });
});