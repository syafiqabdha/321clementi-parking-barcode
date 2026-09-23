/**
 * 321 Clementi Smart Parking Redemption Engine
 * PAN-104 Quality Gate — route-level end-to-end tests (D3 + D4)
 *
 * Drives the REAL Astro route handlers for /api/v1/redemptions/history and
 * /api/v1/redemptions/unclaim against a real PostgreSQL 16 instance. These are the
 * behavioural proofs for the two defects that were only fixable at the
 * frontend/backend contract level:
 *
 *   D3  unclaim recovery must authorize on receipt_number, not vehicle_plate
 *   D4  a patron must be able to look up a plate-less redemption by receipt number
 *
 * WHY BOTH SUITES LIVE IN ONE FILE: src/db/connection.ts caches its SQL client in
 * a module-level singleton, and bun test shares one process across test files. Two
 * files each pointing DATABASE_URL at their own container therefore fight over the
 * singleton — whichever runs first wins, and once its container is torn down every
 * later query in the other file fails with a 500. One file, one container, one
 * getDb() target. Keep it that way.
 *
 * Isolation: the history route caps requests per IP and per distinct search key;
 * the unclaim route caps 3 attempts/day and applies a 60s cooldown per redemption
 * id. Every request here gets a unique client IP and every unclaim attempt a
 * freshly seeded redemption, so no test can be perturbed by another's budget.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256 } from '../src/utils/crypto';

const CONTAINER_NAME = 'test-clementi-pg16-pan104api';
const PG_PORT = 55437;
const DB_USER = 'clementi_admin';
const DB_PASS = 'clementi_secret_123';
const DB_NAME = 'clementi_test_db';
const PG_URL = `postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}`;

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const MIGRATION_FILES = [
  '0001_create_voucher_pool_and_redemption_logs',
  '0002_create_shops_and_unclaim_support',
  '0003_add_receipt_deduplication_and_verification',
  '0004_enforce_10digit_numeric_voucher_codes',
  '0005_shift_to_receipt_number_tracking',
];

const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SHOP_ID = '22222222-2222-4222-8222-222222222222';

// History suite fixtures
const HISTORY_RECEIPT = 'INV-2026-7788';
const OTHER_RECEIPT = 'INV-2026-9999';
const LEGACY_RECEIPT = 'INV-LEGACY-0001';
const LEGACY_PLATE = 'SBA1234A';
const HISTORY_TOKEN = 'tok_pan104_history_plaintext';

// Unclaim suite fixtures
const UNCLAIM_TOKEN = 'tok_pan104_unclaim_plaintext';

let sql: SQL;
let GET_HISTORY: (ctx: any) => Response | Promise<Response>;
let POST_UNCLAIM: (ctx: any) => Response | Promise<Response>;
let historyTokenHash = '';

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function callHistory(query: string, headers: Record<string, string> = {}) {
  const request = new Request(`http://localhost/api/v1/redemptions/history${query}`, {
    headers: { 'cf-connecting-ip': nextIp(), 'user-agent': 'pan104-qa-suite', ...headers },
  });
  const res = await GET_HISTORY({ request });
  return { status: res.status, body: await res.json() };
}

async function callUnclaim(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const request = new Request('http://localhost/api/v1/redemptions/unclaim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': nextIp(),
      'user-agent': 'pan104-qa-suite',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const res = await POST_UNCLAIM({ request });
  return { status: res.status, body: await res.json() };
}

let redemptionSeq = 0;
let voucherSeq = 0;

/** Seed a fresh CLAIMED plate-less redemption for one unclaim attempt. */
async function seedRedemption(opts: { amount?: number; claimToken?: string | null } = {}) {
  redemptionSeq += 1;
  voucherSeq += 1;

  const amount = opts.amount ?? 42.5;
  const receipt = `INV-UNQ-${String(redemptionSeq).padStart(4, '0')}`;
  const voucherCode = `3000000${String(voucherSeq).padStart(3, '0')}`;
  const token = opts.claimToken === undefined ? UNCLAIM_TOKEN : opts.claimToken;
  const tokenHash = token ? await sha256(token) : null;

  await sql`
    INSERT INTO voucher_pool (voucher_code, status, batch_id)
    VALUES (${voucherCode}, 'REDEEMED', 'BATCH-QA-UNCLAIM');
  `;

  const rows = await sql`
    INSERT INTO redemption_logs
      (vehicle_plate, vehicle_plate_hash, receipt_amount, receipt_date, tenant_name, shop_id,
       voucher_code, status, claim_token_hash, receipt_hash, receipt_number, receipt_fingerprint_hash)
    VALUES
      (NULL, NULL, ${amount}, CURRENT_DATE, 'FairPrice Finest', ${SHOP_ID}::uuid,
       ${voucherCode}, 'CLAIMED', ${tokenHash},
       ${String(redemptionSeq).padStart(64, '7')}, ${receipt}, ${String(redemptionSeq).padStart(64, '8')})
    RETURNING id;
  `;

  return { id: (rows[0] as any).id as string, receipt, amount, voucherCode, token };
}

beforeAll(async () => {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });

  const startRes = spawnSync('docker', [
    'run', '-d', '--rm',
    '--name', CONTAINER_NAME,
    '-e', `POSTGRES_DB=${DB_NAME}`,
    '-e', `POSTGRES_USER=${DB_USER}`,
    '-e', `POSTGRES_PASSWORD=${DB_PASS}`,
    '-p', `${PG_PORT}:5432`,
    'postgres:16-alpine',
  ]);
  if (startRes.status !== 0) {
    throw new Error(`Failed to start postgres:16-alpine container: ${startRes.stderr.toString()}`);
  }

  let ready = false;
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(200);
    const logs = spawnSync('docker', ['logs', CONTAINER_NAME], { encoding: 'utf-8' });
    const logText = logs.stdout || '';
    if (
      logText.includes('PostgreSQL init process complete; ready for start up.') &&
      logText.includes('database system is ready to accept connections')
    ) {
      const check = spawnSync('docker', ['exec', CONTAINER_NAME, 'pg_isready', '-U', DB_USER, '-d', DB_NAME]);
      if (check.status === 0) { ready = true; break; }
    }
  }
  if (!ready) {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
    throw new Error('PostgreSQL 16 container timed out waiting for ready state');
  }

  sql = new SQL(PG_URL);
  for (const name of MIGRATION_FILES) {
    await sql.unsafe(await readFile(join(MIGRATIONS_DIR, `${name}.up.sql`), 'utf-8'));
  }

  // ---- Common fixtures -------------------------------------------------------
  await sql`
    INSERT INTO shops (id, name, slug, category, level, unit, is_active, is_eligible)
    VALUES
      (${SHOP_ID}::uuid, 'FairPrice Finest', 'fairprice-finest', 'Supermarket', 'B1', '#B1-12', TRUE, TRUE),
      (${OTHER_SHOP_ID}::uuid, 'Saizeriya', 'saizeriya', 'F&B', 'B1', '#B1-30', TRUE, TRUE);
  `;

  historyTokenHash = await sha256(HISTORY_TOKEN);

  // Voucher codes must be 10-digit numeric (migration 0004); status is constrained
  // to AVAILABLE | RESERVED | REDEEMED | EXPIRED by ck_voucher_pool_status.
  await sql`
    INSERT INTO voucher_pool (voucher_code, status, batch_id)
    VALUES
      ('1000000001', 'REDEEMED', 'BATCH-QA'),
      ('1000000002', 'REDEEMED', 'BATCH-QA'),
      ('1000000003', 'REDEEMED', 'BATCH-QA');
  `;

  // ---- History fixtures ------------------------------------------------------
  // A) The PAN-104 case: no vehicle plate at all, receipt number is the only key.
  await sql`
    INSERT INTO redemption_logs
      (vehicle_plate, vehicle_plate_hash, receipt_amount, receipt_date, tenant_name, shop_id,
       voucher_code, status, claim_token_hash, receipt_hash, receipt_number, receipt_fingerprint_hash)
    VALUES
      (NULL, NULL, 42.50, CURRENT_DATE, 'FairPrice Finest', ${SHOP_ID}::uuid,
       '1000000001', 'CLAIMED', ${historyTokenHash}, ${'1'.repeat(64)}, ${HISTORY_RECEIPT}, ${'2'.repeat(64)});
  `;

  // B) A different receipt on the same day — must never be returned by A's lookup.
  await sql`
    INSERT INTO redemption_logs
      (vehicle_plate, vehicle_plate_hash, receipt_amount, receipt_date, tenant_name, shop_id,
       voucher_code, status, claim_token_hash, receipt_hash, receipt_number, receipt_fingerprint_hash)
    VALUES
      (NULL, NULL, 31.00, CURRENT_DATE, 'Saizeriya', ${SHOP_ID}::uuid,
       '1000000002', 'CLAIMED', NULL, ${'3'.repeat(64)}, ${OTHER_RECEIPT}, ${'4'.repeat(64)});
  `;

  // C) Legacy row that still carries a plate, so the plate path stays verifiable.
  await sql`
    INSERT INTO redemption_logs
      (vehicle_plate, vehicle_plate_hash, receipt_amount, receipt_date, tenant_name, shop_id,
       voucher_code, status, claim_token_hash, receipt_hash, receipt_number, receipt_fingerprint_hash)
    VALUES
      (${LEGACY_PLATE}, ${'d'.repeat(64)}, 55.00, CURRENT_DATE, 'Uniqlo', ${SHOP_ID}::uuid,
       '1000000003', 'CLAIMED', NULL, ${'5'.repeat(64)}, ${LEGACY_RECEIPT}, ${'6'.repeat(64)});
  `;

  // ---- Real route handlers (single getDb target — see file header) -----------
  process.env.DATABASE_URL = PG_URL;
  ({ GET: GET_HISTORY } = await import('../src/pages/api/v1/redemptions/history'));
  ({ POST: POST_UNCLAIM } = await import('../src/pages/api/v1/redemptions/unclaim'));
}, 90_000);

afterAll(async () => {
  if (sql) await sql.close();
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
});

// ============================================================================
// D4 — Claim History by receipt number
// ============================================================================
describe('PAN-104 D4: patron can look up a redemption by receipt number', () => {
  test('?receipt= finds the plate-less redemption (the core requirement)', async () => {
    const { status, body } = await callHistory(`?receipt=${encodeURIComponent(HISTORY_RECEIPT)}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.search_type).toBe('receipt');
    expect(body.receipt).toBe(HISTORY_RECEIPT);
    expect(body.data.length).toBe(1);
    expect(body.data[0].id).toBeString();
  });

  test('the lookup is case- and whitespace-insensitive', async () => {
    const { status, body } = await callHistory('?receipt=%20inv-2026-7788%20');
    expect(status).toBe(200);
    expect(body.data.length).toBe(1);
  });

  test('a different receipt number on the same day is NOT returned', async () => {
    const { body } = await callHistory(`?receipt=${encodeURIComponent(OTHER_RECEIPT)}`);
    expect(body.data.length).toBe(1);

    const { body: other } = await callHistory(`?receipt=${encodeURIComponent(HISTORY_RECEIPT)}`);
    expect(other.data[0].id).not.toBe(body.data[0].id);
  });

  test('an unknown receipt number returns an empty result, not an error', async () => {
    const { status, body } = await callHistory('?receipt=NO-SUCH-RECEIPT');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('a receipt whose number was unreadable (NULL) is never matched', async () => {
    // Guard against a query that degenerates into "match everything".
    const { body } = await callHistory('?receipt=%20');
    expect(body.data).toEqual([]);
  });

  test('omitting both plate and receipt is a 400', async () => {
    const { status, body } = await callHistory('');
    expect(status).toBe(400);
    expect(body.error).toBe('MISSING_PARAMETER');
  });

  test('the legacy ?plate= lookup still works (backward compatibility)', async () => {
    const { status, body } = await callHistory(`?plate=${encodeURIComponent(LEGACY_PLATE)}`);
    expect(status).toBe(200);
    expect(body.search_type).toBe('plate');
    expect(body.data.length).toBe(1);
  });
});

describe('PAN-104 D4: security contract preserved on the receipt path', () => {
  test('without a claim token the record is masked', async () => {
    const { body } = await callHistory(`?receipt=${encodeURIComponent(HISTORY_RECEIPT)}`);
    const row = body.data[0];

    expect(row.voucher_code).toBe('••••••••••');
    expect(row.receipt_amount).toBeNull();
    expect(row.shop_name).toBeNull();
    expect(row.can_resume).toBe(false);
  });

  test('with the matching claim token the record is revealed', async () => {
    const { body } = await callHistory(`?receipt=${encodeURIComponent(HISTORY_RECEIPT)}`, {
      'X-Claim-Token': HISTORY_TOKEN,
    });
    const row = body.data[0];

    expect(row.voucher_code).toBe('1000000001');
    expect(row.receipt_amount).toBe(42.5);
    expect(row.shop_name).toBe('FairPrice Finest');
    expect(row.can_resume).toBe(true);
  });

  test('a token valid for one receipt does not unmask another redemption', async () => {
    const { body } = await callHistory(`?receipt=${encodeURIComponent(OTHER_RECEIPT)}`, {
      'X-Claim-Token': HISTORY_TOKEN,
    });
    const row = body.data[0];

    // Row B has no stored token hash, so it must stay masked
    expect(row.voucher_code).toBe('••••••••••');
    expect(row.can_resume).toBe(false);
  });
});

// ============================================================================
// D3 — unclaim recovery by receipt number
// ============================================================================
describe('PAN-104 D3: recovery authorizes on receipt_number (the fix)', () => {
  test('receipt_number + amount + shop_id authorizes and releases the voucher', async () => {
    const r = await seedRedemption({ amount: 42.5, claimToken: null });

    const { status, body } = await callUnclaim({
      id: r.id,
      receipt_number: r.receipt,
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    const after = await sql`SELECT status FROM redemption_logs WHERE id = ${r.id}::uuid;`;
    expect((after[0] as any).status).toBe('UNCLAIMED');

    const voucher = await sql`SELECT status FROM voucher_pool WHERE voucher_code = ${r.voucherCode};`;
    expect((voucher[0] as any).status).toBe('AVAILABLE');
  });

  test('receipt_number matching is case- and whitespace-insensitive', async () => {
    const r = await seedRedemption({ claimToken: null });

    const { status } = await callUnclaim({
      id: r.id,
      receipt_number: `  ${r.receipt.toLowerCase()} `,
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });
    expect(status).toBe(200);
  });

  test('the legacy vehicle_plate payload no longer authorizes recovery', async () => {
    const r = await seedRedemption({ claimToken: null });

    // The shape the frontend used to send before the D3 fix.
    const { status, body } = await callUnclaim({
      id: r.id,
      vehicle_plate: 'SBA1234A',
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });

    expect(status).toBe(401);
    expect(body.error).toBe('UNAUTHORIZED');

    const after = await sql`SELECT status FROM redemption_logs WHERE id = ${r.id}::uuid;`;
    expect((after[0] as any).status).toBe('CLAIMED');
  });
});

describe('PAN-104 D3: recovery still rejects wrong details', () => {
  test('a wrong receipt number is rejected', async () => {
    const r = await seedRedemption({ claimToken: null });
    const { status, body } = await callUnclaim({
      id: r.id,
      receipt_number: 'INV-WRONG-9999',
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });
    expect(status).toBe(401);
    expect(body.error).toBe('UNAUTHORIZED');
  });

  test('a materially wrong receipt amount is rejected', async () => {
    const r = await seedRedemption({ amount: 42.5, claimToken: null });
    const { status } = await callUnclaim({
      id: r.id,
      receipt_number: r.receipt,
      receipt_amount: 40.0,
      shop_id: SHOP_ID,
    });
    expect(status).toBe(401);
  });

  test('an amount more than one cent off is rejected', async () => {
    const r = await seedRedemption({ amount: 42.5, claimToken: null });
    const { status } = await callUnclaim({
      id: r.id,
      receipt_number: r.receipt,
      receipt_amount: 42.48,
      shop_id: SHOP_ID,
    });
    expect(status).toBe(401);
  });

  test('a one-cent difference is tolerated in both directions', async () => {
    // The guard is `Math.abs(input - stored) < 0.01` — an OCR rounding allowance
    // that accepts exactly one cent either way and rejects two. Pre-existing
    // behaviour (unchanged by PAN-104), asserted here so a future tightening is a
    // deliberate decision rather than a surprise.
    for (const amount of [42.49, 42.51]) {
      const r = await seedRedemption({ amount: 42.5, claimToken: null });
      const { status } = await callUnclaim({
        id: r.id,
        receipt_number: r.receipt,
        receipt_amount: amount,
        shop_id: SHOP_ID,
      });
      expect(status).toBe(200);
    }
  });

  test('a wrong shop is rejected', async () => {
    const r = await seedRedemption({ claimToken: null });
    const { status } = await callUnclaim({
      id: r.id,
      receipt_number: r.receipt,
      receipt_amount: r.amount,
      shop_id: OTHER_SHOP_ID,
    });
    expect(status).toBe(401);
  });

  test('a missing receipt number is rejected', async () => {
    const r = await seedRedemption({ claimToken: null });
    const { status } = await callUnclaim({
      id: r.id,
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });
    expect(status).toBe(401);
  });

  test('a redemption with a NULL stored receipt number cannot be recovered by number', async () => {
    const r = await seedRedemption({ claimToken: null });
    await sql`UPDATE redemption_logs SET receipt_number = NULL WHERE id = ${r.id}::uuid;`;

    const { status } = await callUnclaim({
      id: r.id,
      receipt_number: r.receipt,
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });
    expect(status).toBe(401);
  });

  test('an unknown redemption id is a 404', async () => {
    const { status, body } = await callUnclaim({
      id: '99999999-9999-4999-8999-999999999999',
      receipt_number: 'INV-UNQ-0001',
      receipt_amount: 42.5,
      shop_id: SHOP_ID,
    });
    expect(status).toBe(404);
    expect(body.error).toBe('NOT_FOUND');
  });

  test('a missing body id is a 400', async () => {
    const { status, body } = await callUnclaim({ receipt_number: 'INV-UNQ-0001' });
    expect(status).toBe(400);
    expect(body.error).toBe('MISSING_ID');
  });
});

describe('PAN-104 D3: claim-token fast path and state machine intact', () => {
  test('the correct X-Claim-Token authorizes without recovery fields', async () => {
    const r = await seedRedemption({ claimToken: UNCLAIM_TOKEN });

    const { status, body } = await callUnclaim({ id: r.id }, { 'X-Claim-Token': UNCLAIM_TOKEN });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('a wrong X-Claim-Token falls through to recovery and is rejected', async () => {
    const r = await seedRedemption({ claimToken: UNCLAIM_TOKEN });

    const { status } = await callUnclaim({ id: r.id }, { 'X-Claim-Token': 'tok_not_the_one' });
    expect(status).toBe(401);
  });

  test('unclaiming the same redemption twice does not double-release it', async () => {
    const r = await seedRedemption({ claimToken: null });

    const first = await callUnclaim({
      id: r.id,
      receipt_number: r.receipt,
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });
    expect(first.status).toBe(200);

    // A fresh redemption id per attempt is impossible here — this test *is* the
    // second attempt, so a 429 (per-id cooldown) is an acceptable outcome too.
    // What must hold is that the record stays UNCLAIMED and the voucher is AVAILABLE.
    const second = await callUnclaim({
      id: r.id,
      receipt_number: r.receipt,
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });
    expect([409, 429]).toContain(second.status);

    const after = await sql`SELECT status FROM redemption_logs WHERE id = ${r.id}::uuid;`;
    expect((after[0] as any).status).toBe('UNCLAIMED');
  });
});

describe('PAN-104 D3: plate-less redemptions survive the whole unclaim path', () => {
  test('a redemption created with vehicle_plate = NULL unclaims and writes a NULL-plate audit row', async () => {
    const r = await seedRedemption({ claimToken: null });

    const { status } = await callUnclaim({
      id: r.id,
      receipt_number: r.receipt,
      receipt_amount: r.amount,
      shop_id: SHOP_ID,
    });
    expect(status).toBe(200);

    // This is the write that PAN-104's nullable plate columns exist to allow.
    const audit = await sql`
      SELECT action, vehicle_plate, success FROM redemption_audit_logs
      WHERE redemption_id = ${r.id}::uuid AND action = 'UNCLAIM';
    `;
    expect(audit.length).toBe(1);
    expect((audit[0] as any).vehicle_plate).toBeNull();
    expect((audit[0] as any).success).toBe(true);
  });
});
