/**
 * 321 Clementi Smart Parking Redemption Engine
 * Shop ID Resolution Tests (PAN-81: Defect 1 regression coverage)
 *
 * Verifies that synthetic slug-based shop IDs from the offline fallback
 * resolve correctly via slug-prefix lookup against the seed data.
 */

import { describe, test, expect } from 'bun:test';
import { FALLBACK_ELIGIBLE_SHOPS } from '../src/components/shops-data';
import { SHOP_SEED_DATA } from '../src/db/seed-shops';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractSlugPrefix(shopId: string): string {
  if (shopId.startsWith('shop-')) {
    return shopId.slice(5);
  }
  return shopId;
}

describe('Shop ID Resolution (PAN-81)', () => {
  describe('UUID detection', () => {
    test('recognizes valid UUIDs', () => {
      expect(UUID_RE.test('8c79b97b-3225-522b-0705-928ef318dcc4')).toBe(true);
      expect(UUID_RE.test('00000000-0000-0000-0000-000000000000')).toBe(true);
      expect(UUID_RE.test('FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF')).toBe(true);
    });

    test('rejects synthetic slug-based IDs', () => {
      expect(UUID_RE.test('shop-huang-tu-di')).toBe(false);
      expect(UUID_RE.test('shop-saizeriya')).toBe(false);
      expect(UUID_RE.test('shop-gofit')).toBe(false);
      expect(UUID_RE.test('not-a-shop')).toBe(false);
    });

    test('rejects empty and short strings', () => {
      expect(UUID_RE.test('')).toBe(false);
      expect(UUID_RE.test('abc')).toBe(false);
      // 37-char string (valid pattern but too long for UUID)
      expect(UUID_RE.test('12345678-1234-1234-1234-1234567890abc')).toBe(false);
      // 35-char string (too short)
      expect(UUID_RE.test('12345678-1234-1234-1234-1234567890a')).toBe(false);
    });
  });

  describe('Slug prefix extraction', () => {
    test('strips shop- prefix from synthetic IDs', () => {
      expect(extractSlugPrefix('shop-huang-tu-di')).toBe('huang-tu-di');
      expect(extractSlugPrefix('shop-ji-de-chi')).toBe('ji-de-chi');
      expect(extractSlugPrefix('shop-kumar-mess')).toBe('kumar-mess');
    });

    test('returns raw value when no shop- prefix', () => {
      expect(extractSlugPrefix('some-raw-slug')).toBe('some-raw-slug');
      expect(extractSlugPrefix('saizeriya')).toBe('saizeriya');
    });
  });

  describe('Fallback synthetic IDs resolve to unique seed shop slugs', () => {
    // Build a lookup of eligible seed shops by slug for validation
    const eligibleSeedShops = SHOP_SEED_DATA.filter(s => s.is_eligible && s.is_active);

    for (const fallbackShop of FALLBACK_ELIGIBLE_SHOPS) {
      const syntheticId = fallbackShop.id;
      const slugPrefix = extractSlugPrefix(syntheticId);

      test(`synthetic ID "${syntheticId}" → slug prefix "${slugPrefix}" matches exactly 1 seed shop`, () => {
        const matches = eligibleSeedShops.filter(s => s.slug.startsWith(slugPrefix));

        expect(matches.length).toBe(1);
        // The matched shop name should be consistent
        expect(matches[0].slug).toBe(fallbackShop.slug);
        expect(matches[0].name).toBe(fallbackShop.name);
      });
    }
  });

  describe('Fallback shop count matches seed data', () => {
    test('21 fallback shops match 21 eligible seed shops', () => {
      expect(FALLBACK_ELIGIBLE_SHOPS.length).toBe(21);

      const eligibleSeedSlugs = new Set(
        SHOP_SEED_DATA.filter(s => s.is_eligible && s.is_active).map(s => s.slug)
      );
      for (const shop of FALLBACK_ELIGIBLE_SHOPS) {
        expect(eligibleSeedSlugs.has(shop.slug)).toBe(true);
      }
    });
  });
});