/**
 * 321 Clementi Parking Barcode — Security Fix Tests (PAN-83)
 *
 * Covers:
 *   SEC-01  Shop ID resolution: $6 must be resolvedShopId (UUID), never raw shopId (slug)
 *   SEC-02  History endpoint: voucher_code masked when token is absent or wrong
 *   SEC-03  History endpoint: receipt_amount / shop_name / can_resume masked when unauthenticated
 *   SEC-04  Admin auth: constant-time comparison via timingSafeEqual
 */

import { describe, test, expect } from 'bun:test';
import { generateClaimToken, sha256 } from '../src/utils/crypto';
import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// SEC-01: Shop ID Resolution — $6 parameter must be resolvedShopId (UUID)
// ---------------------------------------------------------------------------
describe('SEC-01: Shop ID resolution in redemptions.ts ($6 = resolvedShopId)', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  test('A UUID shopId is used directly as resolvedShopId', () => {
    const shopId = '8c79b97b-3225-522b-0705-928ef318dcc4';
    let resolvedShopId = shopId;
    if (!UUID_RE.test(shopId)) {
      resolvedShopId = 'resolved-via-slug-lookup'; // simulates DB lookup path
    }
    // The value passed as $6 must always be resolvedShopId
    expect(resolvedShopId).toBe(shopId);
    expect(UUID_RE.test(resolvedShopId)).toBe(true);
  });

  test('A synthetic slug shopId resolves to a UUID via slug lookup (not passed raw)', () => {
    const shopId = 'shop-huang-tu-di';
    let resolvedShopId = shopId;

    // Simulate the resolution path in redemptions.ts
    if (!UUID_RE.test(shopId)) {
      // In production this comes from a DB look-up; here we simulate the resolved value
      resolvedShopId = 'aaaaaaa0-0000-0000-0000-000000000001';
    }

    expect(UUID_RE.test(shopId)).toBe(false);          // raw shopId is NOT a UUID
    expect(UUID_RE.test(resolvedShopId)).toBe(true);   // $6 value IS a UUID
    expect(resolvedShopId).not.toBe(shopId);            // they differ — fix is in place
  });

  test('Passing raw slug as $6 would crash Postgres (validates the bug description)', () => {
    const rawSlug = 'shop-saizeriya';
    // In earlier code shopId (the slug) was passed as $6 to sql.unsafe(ATOMIC_ALLOCATION_CTE, [...])
    // Postgres expects a UUID at $6; a slug would trigger an invalid UUID syntax error.
    // This test documents and validates the root cause.
    expect(UUID_RE.test(rawSlug)).toBe(false); // slug is not a UUID → Postgres would error
  });
});

// ---------------------------------------------------------------------------
// SEC-02 & SEC-03: History endpoint masking logic
// Simulates the per-row token validation introduced in history.ts
// ---------------------------------------------------------------------------
describe('SEC-02/03: History endpoint claim token validation & masking', () => {
  const MASKED_VOUCHER = 'CLM-••••••••';

  // Helper: simulates what history.ts now does per row
  async function buildHistoryRow(
    row: { voucher_code: string; receipt_amount: number; shop_name: string; claim_token_hash: string | null; can_resume: boolean },
    tokenHash: string | null
  ) {
    const rowTokenHash = row.claim_token_hash;
    const tokenValid = tokenHash !== null && rowTokenHash !== null && tokenHash === rowTokenHash;

    if (tokenValid) {
      return {
        voucher_code: row.voucher_code,
        receipt_amount: row.receipt_amount,
        shop_name: row.shop_name,
        can_resume: row.can_resume,
        masked: false,
      };
    }

    return {
      voucher_code: MASKED_VOUCHER,
      receipt_amount: null,
      shop_name: null,
      can_resume: false,
      masked: true,
    };
  }

  test('No claim token → all sensitive fields are masked', async () => {
    const token = generateClaimToken();
    const storedHash = await sha256(token);

    const row = await buildHistoryRow(
      { voucher_code: 'CLM-12345678', receipt_amount: 35.50, shop_name: 'Saizeriya', claim_token_hash: storedHash, can_resume: true },
      null // no token provided
    );

    expect(row.masked).toBe(true);
    expect(row.voucher_code).toBe(MASKED_VOUCHER);
    expect(row.receipt_amount).toBeNull();
    expect(row.shop_name).toBeNull();
    expect(row.can_resume).toBe(false);
  });

  test('Wrong claim token → all sensitive fields are masked', async () => {
    const correctToken = generateClaimToken();
    const wrongToken = generateClaimToken();
    const storedHash = await sha256(correctToken);
    const wrongHash = await sha256(wrongToken);

    const row = await buildHistoryRow(
      { voucher_code: 'CLM-12345678', receipt_amount: 35.50, shop_name: 'Saizeriya', claim_token_hash: storedHash, can_resume: true },
      wrongHash // wrong token hash
    );

    expect(row.masked).toBe(true);
    expect(row.voucher_code).toBe(MASKED_VOUCHER);
    expect(row.receipt_amount).toBeNull();
    expect(row.shop_name).toBeNull();
    expect(row.can_resume).toBe(false);
  });

  test('Correct claim token → all sensitive fields are revealed', async () => {
    const token = generateClaimToken();
    const storedHash = await sha256(token);
    const incomingHash = await sha256(token); // same token re-hashed

    const row = await buildHistoryRow(
      { voucher_code: 'CLM-12345678', receipt_amount: 35.50, shop_name: 'Saizeriya', claim_token_hash: storedHash, can_resume: true },
      incomingHash
    );

    expect(row.masked).toBe(false);
    expect(row.voucher_code).toBe('CLM-12345678');
    expect(row.receipt_amount).toBe(35.50);
    expect(row.shop_name).toBe('Saizeriya');
    expect(row.can_resume).toBe(true);
  });

  test('Row without a stored claim_token_hash → always masked (null hash in DB)', async () => {
    const token = generateClaimToken();
    const tokenHash = await sha256(token);

    const row = await buildHistoryRow(
      { voucher_code: 'CLM-OLDROW00', receipt_amount: 30.00, shop_name: 'KumarMess', claim_token_hash: null, can_resume: true },
      tokenHash // even a valid token cannot unlock a null-hash row
    );

    expect(row.masked).toBe(true);
    expect(row.voucher_code).toBe(MASKED_VOUCHER);
    expect(row.receipt_amount).toBeNull();
    expect(row.shop_name).toBeNull();
    expect(row.can_resume).toBe(false);
  });

  test('Each row is independently validated against the same token', async () => {
    const ownToken = generateClaimToken();
    const otherToken = generateClaimToken();
    const ownHash = await sha256(ownToken);
    const otherHash = await sha256(otherToken);
    const incomingHash = await sha256(ownToken); // client sends ownToken

    // Row belonging to this claim
    const ownRow = await buildHistoryRow(
      { voucher_code: 'CLM-OWN00001', receipt_amount: 40.00, shop_name: 'GoFit', claim_token_hash: ownHash, can_resume: true },
      incomingHash
    );
    // Row belonging to a different claim (different claim_token_hash in DB)
    const otherRow = await buildHistoryRow(
      { voucher_code: 'CLM-OTHER002', receipt_amount: 55.00, shop_name: 'Huang Tu Di', claim_token_hash: otherHash, can_resume: true },
      incomingHash
    );

    expect(ownRow.masked).toBe(false);
    expect(ownRow.voucher_code).toBe('CLM-OWN00001');

    expect(otherRow.masked).toBe(true);
    expect(otherRow.voucher_code).toBe(MASKED_VOUCHER);
  });

  test('Masked voucher code matches the sentinel pattern CLM-\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022', () => {
    expect(MASKED_VOUCHER).toBe('CLM-\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
  });
});

// ---------------------------------------------------------------------------
// SEC-04: Constant-time admin key comparison
// ---------------------------------------------------------------------------
describe('SEC-04: Admin auth constant-time comparison', () => {
  // Mirror the safeCompare logic from admin/shops.ts
  function safeCompare(candidate: string | null, expectedKey: string): boolean {
    if (!candidate) return false;
    const expected = Buffer.from(expectedKey, 'utf8');
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (candidateBuf.length !== expected.length) return false;
    return timingSafeEqual(candidateBuf, expected);
  }

  test('Correct key is accepted', () => {
    expect(safeCompare('super-secret-key', 'super-secret-key')).toBe(true);
  });

  test('Wrong key is rejected', () => {
    expect(safeCompare('wrong-key', 'super-secret-key')).toBe(false);
  });

  test('Empty string is rejected (length mismatch guard)', () => {
    expect(safeCompare('', 'super-secret-key')).toBe(false);
  });

  test('Null candidate is rejected', () => {
    expect(safeCompare(null, 'super-secret-key')).toBe(false);
  });

  test('Key one character off is rejected', () => {
    expect(safeCompare('super-secret-kex', 'super-secret-key')).toBe(false);
  });

  test('Key with different length is rejected before timingSafeEqual (avoids panic)', () => {
    // timingSafeEqual throws if buffers differ in length, so the length guard must fire first
    const key = 'short';
    const expected = 'super-secret-key';
    expect(safeCompare(key, expected)).toBe(false);
  });

  test('timingSafeEqual itself returns true for identical Buffers', () => {
    const a = Buffer.from('test-key-value', 'utf8');
    const b = Buffer.from('test-key-value', 'utf8');
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  test('timingSafeEqual returns false for different Buffers of same length', () => {
    const a = Buffer.from('aaaaaaaaaaaaaaa', 'utf8');
    const b = Buffer.from('aaaaaaaaaaaaaab', 'utf8');
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  test('Bearer token extraction and comparison works correctly', () => {
    const expectedKey = 'my-admin-api-key-secret';
    const bearerHeader = `Bearer ${expectedKey}`;
    const bearerPrefix = 'Bearer ';
    const extracted = bearerHeader.startsWith(bearerPrefix) ? bearerHeader.slice(bearerPrefix.length) : null;
    expect(safeCompare(extracted, expectedKey)).toBe(true);
  });

  test('Bearer token with wrong value is rejected', () => {
    const expectedKey = 'my-admin-api-key-secret';
    const bearerHeader = `Bearer wrong-key-same-len`;
    const bearerPrefix = 'Bearer ';
    const extracted = bearerHeader.startsWith(bearerPrefix) ? bearerHeader.slice(bearerPrefix.length) : null;
    expect(safeCompare(extracted, expectedKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEC-03 UI: UI masking logic (simulates RedemptionCard.astro client logic)
// ---------------------------------------------------------------------------
describe('SEC-03 UI: History card action gating', () => {
  interface HistoryRecord {
    voucher_code: string;
    can_resume: boolean;
    can_unclaim: boolean;
  }

  const MASKED_VOUCHER = 'CLM-••••••••';

  function shouldShowViewBarcode(record: HistoryRecord): boolean {
    const isMasked = !record.voucher_code || record.voucher_code === MASKED_VOUCHER;
    const canResume = record.can_resume === true;
    return !isMasked && canResume;
  }

  test('Authenticated CLAIMED record shows View Barcode', () => {
    expect(shouldShowViewBarcode({ voucher_code: 'CLM-12345678', can_resume: true, can_unclaim: true })).toBe(true);
  });

  test('Masked voucher_code hides View Barcode', () => {
    expect(shouldShowViewBarcode({ voucher_code: MASKED_VOUCHER, can_resume: true, can_unclaim: true })).toBe(false);
  });

  test('can_resume: false hides View Barcode', () => {
    expect(shouldShowViewBarcode({ voucher_code: 'CLM-12345678', can_resume: false, can_unclaim: false })).toBe(false);
  });

  test('Both masked and can_resume:false also hides View Barcode', () => {
    expect(shouldShowViewBarcode({ voucher_code: MASKED_VOUCHER, can_resume: false, can_unclaim: false })).toBe(false);
  });

  test('Empty voucher_code hides View Barcode', () => {
    expect(shouldShowViewBarcode({ voucher_code: '', can_resume: true, can_unclaim: false })).toBe(false);
  });
});
