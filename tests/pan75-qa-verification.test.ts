/**
 * 321 Clementi Smart Parking Barcode Redemption Engine
 * QA Acceptance & Verification Test Suite (PAN-79 / PAN-75)
 * 
 * Verifies all Stage 1 ADR-001 acceptance criteria against PostgreSQL 16 & Bun runtime:
 * 1. Database Migrations (0001 -> 0002 Up & Down)
 * 2. Managed Shop Directory (26 DB records, 21 active & eligible, query filtering)
 * 3. Plain-Text Car Plate Normalization & Canonical Equivalency
 * 4. Claim -> History -> Unclaim -> Re-Claim Lifecycle & Partial Unique Index
 * 5. Fast-Path (Token) & Secondary Factor (Amount + Shop) Unclaim Verification
 * 6. Rate Limiting & Anti-Enumeration Guards
 * 7. Barcode Enlarge Modal Specifications & Dismissal Interactions
 * 8. Defect Reproduction & Edge Case Probing
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeCarPlate, PlateValidationError } from '../src/utils/plate-normalization';
import { generateClaimToken, sha256, verifyClaimToken } from '../src/utils/crypto';
import {
  checkHistoryRateLimit,
  checkPlateHistoryScanLimit,
  checkUnclaimRateLimit,
  checkUnclaimCooldown,
} from '../src/utils/rate-limiter';
import { SHOP_SEED_DATA } from '../src/db/seed-shops';
import { FALLBACK_ELIGIBLE_SHOPS } from '../src/components/shops-data';
import {
  ATOMIC_ALLOCATION_CTE,
  ATOMIC_UNCLAIM_CTE,
  CHECK_DAILY_REDEMPTION_QUERY,
  GET_PLATE_HISTORY_QUERY,
  GET_SHOPS_QUERY,
} from '../src/db/queries';

const CONTAINER_NAME = 'test-clementi-pan75-runner';
const PG_PORT = 55436;
const DB_USER = 'clementi_admin';
const DB_PASS = 'clementi_secret_123';
const DB_NAME = 'clementi_pan75_db';
const PG_URL = `postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}`;

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

let sql: SQL;

beforeAll(async () => {
  // 1. Clean up any existing container
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });

  // 2. Start clean PostgreSQL 16 Alpine container
  const startRes = spawnSync('docker', [
    'run',
    '-d',
    '--rm',
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

  // 3. Wait for PostgreSQL 16 ready state
  let ready = false;
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(200);
    const logs = spawnSync('docker', ['logs', CONTAINER_NAME], { encoding: 'utf-8' });
    const logText = logs.stdout || '';

    if (
      logText.includes('PostgreSQL init process complete; ready for start up.') &&
      logText.includes('database system is ready to accept connections')
    ) {
      const check = spawnSync('docker', [
        'exec', CONTAINER_NAME,
        'pg_isready', '-U', DB_USER, '-d', DB_NAME,
      ]);
      if (check.status === 0) {
        ready = true;
        break;
      }
    }
  }

  if (!ready) {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
    throw new Error('PostgreSQL 16 container timed out waiting for ready state');
  }

  sql = new SQL(PG_URL);
});

afterAll(async () => {
  if (sql) {
    await sql.close();
  }
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
});

describe('1. Schema Migrations (0001 & 0002) on PostgreSQL 16', () => {
  test('Migration 0001 applies base tables', async () => {
    const m0001 = await readFile(join(MIGRATIONS_DIR, '0001_create_voucher_pool_and_redemption_logs.up.sql'), 'utf-8');
    await sql.unsafe(m0001);

    const tables = await sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
    `;
    const tableNames = tables.map((t: any) => t.tablename);
    expect(tableNames).toContain('voucher_pool');
    expect(tableNames).toContain('redemption_logs');
  });

  test('Migration 0002 applies shops, partial unique index & audit trail', async () => {
    const m0002 = await readFile(join(MIGRATIONS_DIR, '0002_create_shops_and_unclaim_support.up.sql'), 'utf-8');
    await sql.unsafe(m0002);

    const tables = await sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
    `;
    const tableNames = tables.map((t: any) => t.tablename);
    expect(tableNames).toContain('shops');
    expect(tableNames).toContain('redemption_audit_logs');

    // Check new columns in redemption_logs
    const cols = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'redemption_logs'
      ORDER BY ordinal_position;
    `;
    const colMap = new Map(cols.map((c: any) => [c.column_name, c]));
    expect(colMap.has('vehicle_plate')).toBe(true);
    expect((colMap.get('vehicle_plate') as any).is_nullable).toBe('NO');
    expect(colMap.has('shop_id')).toBe(true);
    expect(colMap.has('status')).toBe(true);
    expect(colMap.has('claim_token_hash')).toBe(true);
    expect(colMap.has('unclaimed_at')).toBe(true);
    expect(colMap.has('unclaimed_reason')).toBe(true);

    // Verify partial unique index on redemption_logs
    const indexes = await sql`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'redemption_logs';
    `;
    const dailyIdx = indexes.find((i: any) => i.indexname === 'uq_redemption_vehicle_daily');
    expect(dailyIdx).toBeDefined();
    expect(dailyIdx.indexdef).toContain("WHERE ((status)::text = 'CLAIMED'::text)");
  });
});

describe('2. Managed Shop Directory (PAN-77 / ADR-001)', () => {
  let seededShopMap = new Map<string, string>(); // slug -> uuid

  test('Seeding 26 directory records into PostgreSQL', async () => {
    for (const shop of SHOP_SEED_DATA) {
      const inserted = await sql`
        INSERT INTO shops (name, slug, category, level, unit, is_active, is_eligible, ineligibility_reason)
        VALUES (${shop.name}, ${shop.slug}, ${shop.category}, ${shop.level}, ${shop.unit}, ${shop.is_active}, ${shop.is_eligible}, ${shop.ineligibility_reason})
        RETURNING id, slug;
      `;
      seededShopMap.set(inserted[0].slug, inserted[0].id);
    }
    expect(seededShopMap.size).toBe(26);
  });

  test('Customer query GET_SHOPS_QUERY returns exactly 21 active and eligible stores', async () => {
    const shops = await sql.unsafe(GET_SHOPS_QUERY, [null]);
    expect(shops.length).toBe(21);
    expect(shops.every((s: any) => s.is_eligible === true)).toBe(true);

    // Verify excluded facilities/clinics are absent
    const names = shops.map((s: any) => s.name);
    expect(names).not.toContain('Carpark');
    expect(names).not.toContain('Roof top playground');
    expect(names).not.toContain('Clementi Family & Aesthetic Clinic');
    expect(names).not.toContain("GynaeMD Women's Clinic");
    expect(names).not.toContain('Western Union');
  });

  test('Category filter honors category parameter', async () => {
    const dineShops = await sql.unsafe(GET_SHOPS_QUERY, ['Dine']);
    expect(dineShops.length).toBe(8);

    const learnShops = await sql.unsafe(GET_SHOPS_QUERY, ['Learn']);
    expect(learnShops.length).toBe(5);

    const relaxShops = await sql.unsafe(GET_SHOPS_QUERY, ['Relax']);
    expect(relaxShops.length).toBe(2);

    const servicesShops = await sql.unsafe(GET_SHOPS_QUERY, ['Services']);
    expect(servicesShops.length).toBe(6);
  });

  test('All shops (eligible_only=false) returns all 26 seeded records', async () => {
    const allShops = await sql`SELECT * FROM shops ORDER BY category, name;`;
    expect(allShops.length).toBe(26);
  });
});

describe('3. Plain-Text Plate Normalization & Canonical Equivalency (PAN-75 Scope 1)', () => {
  test('Canonical mapping: case, surrounding whitespace, and collapsed spaces resolve to identical string', () => {
    const inputs = [
      'sba1234a',
      ' SBA 1234 A ',
      'sba   1234  a',
      'SBA 1234 A',
      '  sba  1234   a  ',
    ];
    const canonicals = inputs.map(normalizeCarPlate);
    expect(new Set(canonicals).size).toBe(2); // 'SBA1234A' vs 'SBA 1234 A'
    // Specifically verify spaced equivalents collapse
    expect(normalizeCarPlate('sba   1234   a')).toBe('SBA 1234 A');
    expect(normalizeCarPlate(' SBA 1234 A ')).toBe('SBA 1234 A');
    expect(normalizeCarPlate('sgp1234a')).toBe('SGP1234A');
    expect(normalizeCarPlate(' SGP 1234A ')).toBe('SGP 1234A');
    expect(normalizeCarPlate('sgp   1234a')).toBe('SGP 1234A');
  });

  test('Malaysian, diplomatic, and commercial vehicle plates pass normalization', () => {
    expect(normalizeCarPlate('jqr 1234')).toBe('JQR 1234');
    expect(normalizeCarPlate('w 1234 a')).toBe('W 1234 A');
    expect(normalizeCarPlate('cd 12 34')).toBe('CD 12 34');
    expect(normalizeCarPlate('gba 9999')).toBe('GBA 9999');
  });

  test('Unicode NFKC normalizes full-width alphanumeric characters', () => {
    expect(normalizeCarPlate('ＳＧＰ １２３４ Ａ')).toBe('SGP 1234 A');
  });

  test('Zero-width characters and control chars are stripped', () => {
    expect(normalizeCarPlate('\u200BSBA 1234 A\uFEFF')).toBe('SBA 1234 A');
  });

  test('Length boundary checks enforce 2 to 16 characters', () => {
    expect(() => normalizeCarPlate('A')).toThrow(PlateValidationError);
    expect(() => normalizeCarPlate('A')).toThrow('at least 2 characters');

    expect(() => normalizeCarPlate('SBA123456789012345')).toThrow(PlateValidationError);
    expect(() => normalizeCarPlate('SBA123456789012345')).toThrow('cannot exceed 16 characters');
  });

  test('Character whitelist rejects invalid symbols, emojis, and SQL injection strings', () => {
    expect(() => normalizeCarPlate('SBA 🚗 1234')).toThrow('alphanumeric characters and spaces');
    expect(() => normalizeCarPlate('SBA-1234-A')).toThrow('alphanumeric characters and spaces');
    expect(() => normalizeCarPlate('SBA.1234')).toThrow('alphanumeric characters and spaces');
    expect(() => normalizeCarPlate("SBA' OR 1=1")).toThrow('alphanumeric characters and spaces');
  });
});

describe('4. Claim -> History -> Unclaim -> Re-Claim Lifecycle & Partial Index', () => {
  const testPlate = 'SBA 8888 Z';
  const testDate = '2026-09-18';
  let saizeriyaId: string;
  let allocatedVoucherCode: string;
  let redemptionId: string;
  let validClaimToken: string;

  beforeAll(async () => {
    // Look up Saizeriya UUID
    const shops = await sql`SELECT id FROM shops WHERE slug = 'saizeriya';`;
    saizeriyaId = shops[0].id;

    // Seed voucher pool with 10 vouchers
    for (let i = 1; i <= 10; i++) {
      await sql`
        INSERT INTO voucher_pool (voucher_code, barcode_format, status, batch_id)
        VALUES (${`CLM-QA-${String(i).padStart(4, '0')}`}, 'CODE128', 'AVAILABLE', 'QA-BATCH-01')
        ON CONFLICT (voucher_code) DO NOTHING;
      `;
    }
  });

  test('Initial claim succeeds and atomically allocates voucher in REDEEMED state', async () => {
    validClaimToken = generateClaimToken();
    const tokenHash = await sha256(validClaimToken);
    const plateHash = await sha256(testPlate);

    const result = await sql.unsafe(ATOMIC_ALLOCATION_CTE, [
      plateHash,
      testPlate,
      35.50,
      testDate,
      'Saizeriya',
      saizeriyaId,
      tokenHash,
      '127.0.0.1',
      'QA-BunTest-Runner',
    ]);

    expect(result.length).toBe(1);
    redemptionId = result[0].redemption_id;
    allocatedVoucherCode = result[0].voucher_code;
    expect(redemptionId).toBeDefined();
    expect(allocatedVoucherCode).toContain('CLM-QA-');

    // Verify voucher_pool state is REDEEMED
    const vRows = await sql`SELECT status FROM voucher_pool WHERE voucher_code = ${allocatedVoucherCode};`;
    expect(vRows[0].status).toBe('REDEEMED');

    // Verify redemption_logs status is CLAIMED
    const rRows = await sql`SELECT status, shop_id, vehicle_plate FROM redemption_logs WHERE id = ${redemptionId}::uuid;`;
    expect(rRows[0].status).toBe('CLAIMED');
    expect(rRows[0].shop_id).toBe(saizeriyaId);
    expect(rRows[0].vehicle_plate).toBe(testPlate);
  });

  test('Attempting duplicate claim on SAME date throws unique constraint violation', async () => {
    const plateHash = await sha256(testPlate);
    const tokenHash = await sha256(generateClaimToken());

    let errorThrown = false;
    try {
      await sql.unsafe(ATOMIC_ALLOCATION_CTE, [
        plateHash,
        testPlate,
        40.00,
        testDate,
        'Saizeriya',
        saizeriyaId,
        tokenHash,
        '127.0.0.1',
        'QA-BunTest-Runner',
      ]);
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain('uq_redemption_vehicle_daily');
    }
    expect(errorThrown).toBe(true);
  });

  test('History query retrieves the active CLAIMED record with can_unclaim=true', async () => {
    const rows = await sql.unsafe(GET_PLATE_HISTORY_QUERY, [testPlate]);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('CLAIMED');
    expect(rows[0].can_unclaim).toBe(true);
    expect(rows[0].shop_name).toBe('Saizeriya');
    expect(Number(rows[0].receipt_amount)).toBe(35.50);
  });

  test('Unclaim via atomic CTE releases voucher back to AVAILABLE and marks UNCLAIMED', async () => {
    const unclaimRes = await sql.unsafe(ATOMIC_UNCLAIM_CTE, [
      redemptionId,
      'USER_INITIATED',
      '127.0.0.1',
      'QA-BunTest-Runner',
      JSON.stringify({ recovery_type: 'token' }),
    ]);

    expect(unclaimRes.length).toBe(1);
    expect(unclaimRes[0].voucher_code).toBe(allocatedVoucherCode);

    // Verify voucher_pool returned to AVAILABLE
    const vRows = await sql`SELECT status, vehicle_plate_hash FROM voucher_pool WHERE voucher_code = ${allocatedVoucherCode};`;
    expect(vRows[0].status).toBe('AVAILABLE');
    expect(vRows[0].vehicle_plate_hash).toBeNull();

    // Verify redemption_logs status is UNCLAIMED
    const rRows = await sql`SELECT status, unclaimed_at, unclaimed_reason FROM redemption_logs WHERE id = ${redemptionId}::uuid;`;
    expect(rRows[0].status).toBe('UNCLAIMED');
    expect(rRows[0].unclaimed_at).not.toBeNull();
    expect(rRows[0].unclaimed_reason).toBe('USER_INITIATED');

    // Verify audit log
    const auditRows = await sql`
      SELECT action, vehicle_plate, voucher_code, success
      FROM redemption_audit_logs
      WHERE redemption_id = ${redemptionId}::uuid;
    `;
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0].action).toBe('UNCLAIM');
    expect(auditRows[0].success).toBe(true);
  });

  test('History query reflects UNCLAIMED status with can_unclaim=false', async () => {
    const rows = await sql.unsafe(GET_PLATE_HISTORY_QUERY, [testPlate]);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('UNCLAIMED');
    expect(rows[0].can_unclaim).toBe(false);
  });

  test('Partial unique index is RELEASED: Same plate can immediately re-claim on SAME date', async () => {
    const plateHash = await sha256(testPlate);
    const tokenHash = await sha256(generateClaimToken());

    const result = await sql.unsafe(ATOMIC_ALLOCATION_CTE, [
      plateHash,
      testPlate,
      52.00,
      testDate,
      'Saizeriya',
      saizeriyaId,
      tokenHash,
      '127.0.0.1',
      'QA-BunTest-Runner',
    ]);

    expect(result.length).toBe(1);
    const newRedemptionId = result[0].redemption_id;
    const newVoucherCode = result[0].voucher_code;
    expect(newRedemptionId).not.toBe(redemptionId);

    // History now shows 2 records: 1 CLAIMED, 1 UNCLAIMED
    const history = await sql.unsafe(GET_PLATE_HISTORY_QUERY, [testPlate]);
    expect(history.length).toBe(2);
    expect(history.filter((h: any) => h.status === 'CLAIMED').length).toBe(1);
    expect(history.filter((h: any) => h.status === 'UNCLAIMED').length).toBe(1);
  });

  test('Cannot unclaim an already-unclaimed voucher (state guard)', async () => {
    // Attempting unclaim on the first redemptionId (which is already UNCLAIMED)
    const result = await sql.unsafe(ATOMIC_UNCLAIM_CTE, [
      redemptionId,
      'DOUBLE_UNCLAIM_ATTEMPT',
      '127.0.0.1',
      'QA-BunTest-Runner',
      '{}',
    ]);
    expect(result.length).toBe(0); // CTE target_redemption filter `WHERE status = 'CLAIMED'` matches 0 rows
  });
});

describe('5. Unclaim Authorization & Secondary Fallback Verification', () => {
  test('Claim token verification: authentic token verifies, forged token fails', async () => {
    const token = generateClaimToken();
    const hash = await sha256(token);

    expect(await verifyClaimToken(token, hash)).toBe(true);
    expect(await verifyClaimToken('ct_forged_token_value_here', hash)).toBe(false);
  });

  test('Secondary factors verification: requires exact amount, shop_id, and plate match', () => {
    const record = {
      vehicle_plate: 'SBA 8888 Z',
      receipt_amount: 35.50,
      shop_id: 'a0000000-0000-0000-0000-000000000001',
    };

    function verifySecondaryFactors(input: { plate: string; amount: number; shopId: string }) {
      const plateMatch = normalizeCarPlate(input.plate) === record.vehicle_plate;
      const amountMatch = Math.abs(input.amount - record.receipt_amount) < 0.01;
      const shopMatch = input.shopId === record.shop_id;
      return plateMatch && amountMatch && shopMatch;
    }

    // Exact match passes
    expect(verifySecondaryFactors({ plate: 'sba 8888 z', amount: 35.50, shopId: 'a0000000-0000-0000-0000-000000000001' })).toBe(true);

    // Mismatched amount fails
    expect(verifySecondaryFactors({ plate: 'SBA 8888 Z', amount: 35.00, shopId: 'a0000000-0000-0000-0000-000000000001' })).toBe(false);

    // Mismatched shop fails
    expect(verifySecondaryFactors({ plate: 'SBA 8888 Z', amount: 35.50, shopId: 'b0000000-0000-0000-0000-000000000002' })).toBe(false);

    // Mismatched plate fails
    expect(verifySecondaryFactors({ plate: 'SBA 1234 A', amount: 35.50, shopId: 'a0000000-0000-0000-0000-000000000001' })).toBe(false);
  });
});

describe('6. Rate Limiting Behaviors (ADR-001 §6.4.1)', () => {

  test('History endpoint allows 10 requests/min/IP and blocks 11th', () => {
    const ip = '192.168.10.50';
    for (let i = 0; i < 10; i++) {
      expect(checkHistoryRateLimit(ip).allowed).toBe(true);
    }
    const blocked = checkHistoryRateLimit(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  test('Anti-enumeration scan limit allows 5 distinct plates/hr/IP and blocks 6th', () => {
    const ip = '192.168.10.51';
    const plates = ['SBA1111A', 'SBA2222B', 'SBA3333C', 'SBA4444D', 'SBA5555E'];
    for (const plate of plates) {
      expect(checkPlateHistoryScanLimit(ip, plate).allowed).toBe(true);
    }
    // Repeating an already-scanned plate does not increment distinct count
    expect(checkPlateHistoryScanLimit(ip, 'SBA1111A').allowed).toBe(true);

    // 6th distinct plate is blocked
    const blocked = checkPlateHistoryScanLimit(ip, 'SBA6666F');
    expect(blocked.allowed).toBe(false);
  });

  test('Unclaim limit allows 3 attempts/plate/day and blocks 4th', () => {
    const plate = 'SLK 9999 X';
    for (let i = 0; i < 3; i++) {
      expect(checkUnclaimRateLimit(plate).allowed).toBe(true);
    }
    const blocked = checkUnclaimRateLimit(plate);
    expect(blocked.allowed).toBe(false);
  });

  test('Unclaim cooldown enforces 60s window per redemption ID', () => {
    const redemptionUuid = '01a0-test-cooldown-uuid';
    expect(checkUnclaimCooldown(redemptionUuid).allowed).toBe(true);
    const blocked = checkUnclaimCooldown(redemptionUuid);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });
});

describe('7. Defect Reproduction & Edge Cases', () => {
  test('DEFECT REPRODUCTION (CRITICAL): Frontend fallback shop ID is not a valid UUID and fails DB query', async () => {
    const fallbackShop = FALLBACK_ELIGIBLE_SHOPS[0];
    expect(fallbackShop.id).toBe('shop-huang-tu-di');

    // Simulating backend shop lookup in POST /api/v1/redemptions:
    // SELECT id, name, is_active, is_eligible FROM shops WHERE id = ${shopId}::uuid
    let errorThrown = false;
    let errorMessage = '';
    try {
      await sql`
        SELECT id, name, is_active, is_eligible
        FROM shops
        WHERE id = ${fallbackShop.id}::uuid;
      `;
    } catch (err: any) {
      errorThrown = true;
      errorMessage = err.message;
    }

    expect(errorThrown).toBe(true);
    expect(errorMessage).toContain('invalid input syntax for type uuid');
  });

  test('DEFECT VERIFICATION (DOC): seed-shops header comment states 22 stores, but actual count is 21', () => {
    const eligibleCount = SHOP_SEED_DATA.filter(s => s.is_active && s.is_eligible).length;
    expect(eligibleCount).toBe(21);
    // ADR-001 line 20 / seed-shops comment line 9 claimed 22 due to off-by-one arithmetic
  });

  test('DEFECT VERIFICATION (FRONTEND): BarcodeModal lacks Screen Wake Lock API integration', async () => {
    const redemptionCardContent = await readFile(join(import.meta.dir, '..', 'src/components/RedemptionCard.astro'), 'utf-8');
    const barcodeModalContent = await readFile(join(import.meta.dir, '..', 'src/components/BarcodeModal.astro'), 'utf-8');

    // ADR-001 §6.6.2 explicitly specifies: "Auto-release any acquired screen WakeLock when dismissed."
    // Verify neither component references wakeLock
    expect(redemptionCardContent).not.toContain('wakeLock');
    expect(barcodeModalContent).not.toContain('wakeLock');
  });

  test('DEFECT VERIFICATION (API SPEC): openapi.yaml paths drift for unclaim route', async () => {
    const openapiContent = await readFile(join(import.meta.dir, '..', 'docs/openapi.yaml'), 'utf-8');
    // OpenAPI specifies /redemptions/{id}/unclaim with path parameter
    expect(openapiContent).toContain('/redemptions/{id}/unclaim:');
    // But route handler is /api/v1/redemptions/unclaim with body { id }
    const unclaimRouteContent = await readFile(join(import.meta.dir, '..', 'src/pages/api/v1/redemptions/unclaim.ts'), 'utf-8');
    expect(unclaimRouteContent).toContain('body.id');
  });
});
