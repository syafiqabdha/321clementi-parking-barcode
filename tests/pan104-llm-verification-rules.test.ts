/**
 * 321 Clementi Smart Parking Redemption Engine
 * PAN-104 Quality Gate — Criterion 2: the 4 LLM verification rules
 *
 * Exercises the real `verifyReceipt()` gate pipeline in
 * src/services/receipt-verifier.ts by pointing the n8n verifier fallback at a
 * local stub server that returns controlled OCR extractions. No Gemini key and
 * no network access to Google are required.
 *
 * The 4 rules under test:
 *   1. Duplicate/fake/blur receipts are rejected
 *   2. Total spend on a SINGLE receipt must be >= $30.00
 *   3. Receipt date must be the current date (Asia/Singapore)
 *   4. At least one location keyword ("321 Clementi", "Ave 3", "129905") must appear
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const VERIFIER_SRC = join(import.meta.dir, '..', 'src', 'services', 'receipt-verifier.ts');

/** Today in Singapore time — mirrors getTodaySGT() in the service under test. */
function todaySGT(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
}

function dayOffsetSGT(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
}

/** Baseline extraction that satisfies all 4 rules; tests override single fields. */
function passingExtraction(overrides: Record<string, unknown> = {}) {
  return {
    is_receipt: true,
    is_legible: true,
    tenant_name: 'FairPrice Finest',
    total_amount: 45.50,
    receipt_date: todaySGT(),
    receipt_time: '13:15:00',
    receipt_number: 'RCPT-1001',
    location_verified: true,
    confidence_score: 0.93,
    rejection_reason: null,
    ...overrides,
  };
}

let server: ReturnType<typeof Bun.serve>;
let stubPayload: unknown;

const { verifyReceipt, buildReceiptFingerprintHash } = await import('../src/services/receipt-verifier');

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(JSON.stringify(stubPayload), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  // n8n fallback takes precedence over Gemini in verifyReceipt()
  process.env.N8N_RECEIPT_VERIFIER_URL = `http://127.0.0.1:${server.port}/webhook/verify`;
  delete process.env.GEMINI_API_KEY;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.N8N_RECEIPT_VERIFIER_URL;
});

async function verify(payload: unknown) {
  stubPayload = payload;
  return verifyReceipt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
}

describe('PAN-104 Criterion 2 — Rule 1: duplicate / fake / blur rejection', () => {
  test('a non-receipt image is rejected with INVALID_RECEIPT', async () => {
    const res = await verify(passingExtraction({ is_receipt: false, rejection_reason: 'Appears to be a selfie.' }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('INVALID_RECEIPT');
    expect(res.http_status).toBe(400);
  });

  test('an illegible/blurred receipt is rejected with LOW_CONFIDENCE_IMAGE', async () => {
    const res = await verify(passingExtraction({ is_legible: false }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('LOW_CONFIDENCE_IMAGE');
  });

  test('a legible receipt below the 0.75 confidence floor is rejected', async () => {
    const res = await verify(passingExtraction({ confidence_score: 0.74 }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('LOW_CONFIDENCE_IMAGE');
  });

  test('a blurred receipt with otherwise perfect fields never reaches the voucher pool', async () => {
    // is_legible=false wins over a perfect amount/date/location — blur is a hard fail
    const res = await verify(
      passingExtraction({ is_legible: false, total_amount: 99.99, confidence_score: 0.99, location_verified: true })
    );
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('LOW_CONFIDENCE_IMAGE');
  });
});

describe('PAN-104 Criterion 2 — Rule 2: single-receipt spend must be >= $30.00', () => {
  test('$29.99 is rejected with MINIMUM_SPEND_NOT_MET', async () => {
    const res = await verify(passingExtraction({ total_amount: 29.99 }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('MINIMUM_SPEND_NOT_MET');
    expect(res.message).toContain('$29.99');
  });

  test('exactly $30.00 passes (boundary is inclusive)', async () => {
    const res = await verify(passingExtraction({ total_amount: 30.00 }));
    expect(res.valid).toBe(true);
    expect(res.error_code).toBeUndefined();
  });

  test('$30.01 passes', async () => {
    const res = await verify(passingExtraction({ total_amount: 30.01 }));
    expect(res.valid).toBe(true);
  });

  test('an unreadable total is rejected with RECEIPT_VALIDATION_FAILED', async () => {
    const res = await verify(passingExtraction({ total_amount: null }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('RECEIPT_VALIDATION_FAILED');
  });

  test('$0.00 is rejected', async () => {
    const res = await verify(passingExtraction({ total_amount: 0 }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('MINIMUM_SPEND_NOT_MET');
  });

  test('a very large single-receipt total still passes', async () => {
    const res = await verify(passingExtraction({ total_amount: 9999.99 }));
    expect(res.valid).toBe(true);
  });
});

describe('PAN-104 Criterion 2 — Rule 3: receipt date must be the current date', () => {
  test("today's date (Asia/Singapore) passes", async () => {
    const res = await verify(passingExtraction({ receipt_date: todaySGT() }));
    expect(res.valid).toBe(true);
  });

  test("yesterday's receipt is rejected with RECEIPT_EXPIRED", async () => {
    const res = await verify(passingExtraction({ receipt_date: dayOffsetSGT(-1) }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('RECEIPT_EXPIRED');
  });

  test('a receipt dated far in the past is rejected', async () => {
    const res = await verify(passingExtraction({ receipt_date: '2024-01-01' }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('RECEIPT_EXPIRED');
  });

  test("tomorrow's receipt is rejected (not today)", async () => {
    const res = await verify(passingExtraction({ receipt_date: dayOffsetSGT(1) }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('RECEIPT_EXPIRED');
  });

  test('an unreadable date is rejected with RECEIPT_VALIDATION_FAILED', async () => {
    const res = await verify(passingExtraction({ receipt_date: null }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('RECEIPT_VALIDATION_FAILED');
  });
});

describe('PAN-104 Criterion 2 — Rule 4: location keyword must match', () => {
  test('location_verified=true passes', async () => {
    const res = await verify(passingExtraction({ location_verified: true }));
    expect(res.valid).toBe(true);
  });

  test('location_verified=false is rejected with LOCATION_NOT_VERIFIED', async () => {
    const res = await verify(passingExtraction({ location_verified: false }));
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('LOCATION_NOT_VERIFIED');
    expect(res.http_status).toBe(400);
    expect(res.message).toContain('321 Clementi');
  });

  test('a receipt from a different mall is rejected even with a valid amount and date', async () => {
    const res = await verify(
      passingExtraction({ tenant_name: 'JEM Mall Food Court', location_verified: false })
    );
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('LOCATION_NOT_VERIFIED');
  });

  test('a missing location_verified field fails closed (rejected)', async () => {
    const extraction = passingExtraction();
    delete (extraction as any).location_verified;
    const res = await verify(extraction);
    expect(res.valid).toBe(false);
    expect(res.error_code).toBe('LOCATION_NOT_VERIFIED');
  });

  test('the retired STORE_MISMATCH tenant fuzzy-match code is no longer produced', async () => {
    const res = await verify(
      passingExtraction({ tenant_name: 'Completely Unrelated Merchant', location_verified: false })
    );
    expect(res.error_code).not.toBe('STORE_MISMATCH');
    expect(res.error_code).toBe('LOCATION_NOT_VERIFIED');
  });
});

describe('PAN-104 Criterion 2 — gate ordering and happy path', () => {
  test('a receipt satisfying all 4 rules is valid and returns the extraction (incl. receipt_number)', async () => {
    const res = await verify(passingExtraction({ receipt_number: 'INV-2026-7788' }));
    expect(res.valid).toBe(true);
    expect(res.extraction?.receipt_number).toBe('INV-2026-7788');
    expect(res.extraction?.location_verified).toBe(true);
    expect(res.extraction?.total_amount).toBe(45.50);
  });

  test('blur is reported before the spend failure when both fail', async () => {
    const res = await verify(passingExtraction({ is_legible: false, total_amount: 5.00 }));
    expect(res.error_code).toBe('LOW_CONFIDENCE_IMAGE');
  });

  test('spend is reported before the date failure when both fail', async () => {
    const res = await verify(passingExtraction({ total_amount: 5.00, receipt_date: dayOffsetSGT(-3) }));
    expect(res.error_code).toBe('MINIMUM_SPEND_NOT_MET');
  });

  test('date is reported before the location failure when both fail', async () => {
    const res = await verify(passingExtraction({ receipt_date: dayOffsetSGT(-3), location_verified: false }));
    expect(res.error_code).toBe('RECEIPT_EXPIRED');
  });

  test('a verifier timeout is surfaced as VERIFIER_TIMEOUT (fail closed)', async () => {
    const original = process.env.N8N_RECEIPT_VERIFIER_URL;
    process.env.N8N_RECEIPT_VERIFIER_URL = 'http://127.0.0.1:1/webhook/never';
    try {
      const res = await verifyReceipt(new Uint8Array([1, 2, 3]), 'image/jpeg');
      expect(res.valid).toBe(false);
      expect(res.error_code).toBe('VERIFIER_TIMEOUT');
    } finally {
      process.env.N8N_RECEIPT_VERIFIER_URL = original;
    }
  });
});

describe('PAN-104 Criterion 2 — the tracking key is not enforced (finding)', () => {
  // PAN-104 replaces the vehicle plate with receipt_number as the redemption
  // tracking key, but no gate requires the number to be readable. These tests
  // document the resulting behaviour rather than assert it is desirable.
  test('a receipt whose number is unreadable is still accepted as valid', async () => {
    const res = await verify(passingExtraction({ receipt_number: null }));
    expect(res.valid).toBe(true);
    expect(res.extraction?.receipt_number).toBeNull();
  });

  test('a blank receipt number is accepted too', async () => {
    const res = await verify(passingExtraction({ receipt_number: '   ' }));
    expect(res.valid).toBe(true);
  });

  test('a null receipt number silently disables semantic fingerprint dedup', async () => {
    const fingerprint = await buildReceiptFingerprintHash('shop-1', todaySGT(), null);
    expect(fingerprint).toBeNull();

    const blank = await buildReceiptFingerprintHash('shop-1', todaySGT(), '   ');
    expect(blank).toBeNull();
  });

  test('a readable receipt number does produce a fingerprint (the dedup path is live)', async () => {
    const fingerprint = await buildReceiptFingerprintHash('shop-1', todaySGT(), 'INV-1');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PAN-104 Criterion 2 — LLM prompt contract', () => {
  test('the Gemini prompt instructs all 4 rules and the 3 location keywords', async () => {
    const src = await readFile(VERIFIER_SRC, 'utf-8');

    // Rule 4 keywords must be passed to the model verbatim
    expect(src).toContain('"321 Clementi"');
    expect(src).toContain('"Ave 3"');
    expect(src).toContain('"129905"');

    // Rule 4 response field
    expect(src).toContain('"location_verified": boolean');

    // Rule 1 — fake / blur discrimination
    expect(src).toContain('is_receipt: true only for retail/F&B purchase receipts');
    expect(src).toContain('is_legible: true only if key fields');

    // Rule 2 — single-receipt total
    expect(src).toContain('total_amount: Singapore dollar grand total');

    // Rule 3 — receipt date
    expect(src).toContain('receipt_date: date printed on receipt in YYYY-MM-DD format');
  });

  test('verifyReceipt no longer accepts a shop name (verification is location-keyword based)', async () => {
    const src = await readFile(VERIFIER_SRC, 'utf-8');
    expect(src).not.toContain('selectedShopName');
    expect(src).not.toContain('computeSimilarity');
    expect(src).toContain('export async function verifyReceipt(\n  imageBuffer: Uint8Array,\n  mimeType: string\n)');
    expect(verifyReceipt.length).toBe(2);
  });
});
