/**
 * 321 Clementi Smart Parking Redemption Engine
 * PAN-104 Quality Gate — Criterion 1: receipt-number tracking migration (0005)
 *
 * Verifies migration 0005_shift_to_receipt_number_tracking against a real
 * PostgreSQL 16 instance:
 *   - the 1-redemption-per-car-per-day constraint is gone
 *   - vehicle plate columns are nullable (plate no longer the tracking key)
 *   - receipt_number is the persisted tracking key
 *   - the receipt dedup indexes are untouched and still enforce
 *   - the down migration restores the vehicle-bound constraint
 *
 * Uses its own container name/port so it can run alongside tests/migrations.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CONTAINER_NAME = 'test-clementi-pg16-pan104';
const PG_PORT = 55436;
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

let sql: SQL;

async function applyMigration(sql: SQL, name: string, direction: 'up' | 'down') {
  const content = await readFile(join(MIGRATIONS_DIR, `${name}.${direction}.sql`), 'utf-8');
  await sql.unsafe(content);
}

/** Returns { nullable, dataType } for a column, or null when the column is absent. */
async function columnInfo(sql: SQL, table: string, column: string) {
  const rows = await sql`
    SELECT is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column};
  `;
  if (rows.length === 0) return null;
  return { nullable: (rows[0] as any).is_nullable === 'YES', dataType: (rows[0] as any).data_type };
}

async function indexExists(sql: SQL, indexName: string) {
  const rows = await sql`
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${indexName};
  `;
  return rows.length > 0;
}

/** Insert a voucher into the pool so redemption_logs FKs can be satisfied. */
async function seedVoucher(sql: SQL, code: string) {
  await sql`
    INSERT INTO voucher_pool (voucher_code, status, batch_id)
    VALUES (${code}, 'AVAILABLE', 'BATCH-PAN104')
    ON CONFLICT (voucher_code) DO NOTHING;
  `;
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
}, 60_000);

afterAll(async () => {
  if (sql) await sql.close();
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
});

describe('PAN-104 Criterion 1: receipt-number tracking migration (0005)', () => {
  test('full chain 0001→0005 applies cleanly on PostgreSQL 16', async () => {
    for (const name of MIGRATION_FILES) {
      await applyMigration(sql, name, 'up');
    }

    const tables = await sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
    `;
    const tableNames = tables.map((t: any) => t.tablename);
    expect(tableNames).toContain('voucher_pool');
    expect(tableNames).toContain('redemption_logs');
    expect(tableNames).toContain('redemption_audit_logs');
    expect(tableNames).toContain('shops');
  });

  test('0005 up: vehicle-bound daily unique index is dropped', async () => {
    expect(await indexExists(sql, 'uq_redemption_vehicle_daily')).toBe(false);
  });

  test('0005 up: vehicle plate columns are nullable (plate no longer the tracking key)', async () => {
    const plate = await columnInfo(sql, 'redemption_logs', 'vehicle_plate');
    expect(plate).not.toBeNull();
    expect(plate!.nullable).toBe(true);

    const plateHash = await columnInfo(sql, 'redemption_logs', 'vehicle_plate_hash');
    expect(plateHash).not.toBeNull();
    expect(plateHash!.nullable).toBe(true);

    const auditPlate = await columnInfo(sql, 'redemption_audit_logs', 'vehicle_plate');
    expect(auditPlate).not.toBeNull();
    expect(auditPlate!.nullable).toBe(true);
  });

  test('0005 up: receipt_number is the persisted tracking key on redemption_logs', async () => {
    const receiptNumber = await columnInfo(sql, 'redemption_logs', 'receipt_number');
    expect(receiptNumber).not.toBeNull();
    expect(receiptNumber!.dataType).toBe('character varying');

    const receiptHash = await columnInfo(sql, 'redemption_logs', 'receipt_hash');
    const fingerprint = await columnInfo(sql, 'redemption_logs', 'receipt_fingerprint_hash');
    expect(receiptHash).not.toBeNull();
    expect(fingerprint).not.toBeNull();
  });

  test('0005 up: receipt dedup indexes survive the migration', async () => {
    expect(await indexExists(sql, 'uq_redemption_receipt_hash_daily')).toBe(true);
    expect(await indexExists(sql, 'uq_redemption_receipt_fingerprint_daily')).toBe(true);
  });

  test('0005 up: a redemption with NO vehicle plate is accepted and records the receipt number', async () => {
    await seedVoucher(sql, '1000000001');

    const inserted = await sql`
      INSERT INTO redemption_logs
        (vehicle_plate, vehicle_plate_hash, receipt_amount, receipt_date, tenant_name,
         voucher_code, receipt_hash, receipt_number, receipt_fingerprint_hash)
      VALUES
        (NULL, NULL, 42.50, CURRENT_DATE, 'FairPrice Finest',
         '1000000001', ${'a'.repeat(64)}, 'RCPT-0001', ${'b'.repeat(64)})
      RETURNING id, vehicle_plate, receipt_number;
    `;

    expect(inserted.length).toBe(1);
    expect((inserted[0] as any).vehicle_plate).toBeNull();
    expect((inserted[0] as any).receipt_number).toBe('RCPT-0001');
  });

  test('0005 up: two plate-less redemptions on the same day are allowed (per-car daily cap removed)', async () => {
    await seedVoucher(sql, '1000000002');

    await sql`
      INSERT INTO redemption_logs
        (vehicle_plate, vehicle_plate_hash, receipt_amount, receipt_date, tenant_name,
         voucher_code, receipt_hash, receipt_number, receipt_fingerprint_hash)
      VALUES
        (NULL, NULL, 31.00, CURRENT_DATE, 'Saizeriya',
         '1000000002', ${'c'.repeat(64)}, 'RCPT-0002', ${'d'.repeat(64)});
    `;

    const rows = await sql`
      SELECT count(*)::int AS cnt FROM redemption_logs WHERE vehicle_plate IS NULL;
    `;
    expect((rows[0] as any).cnt).toBe(2);
  });

  test('0005 up: duplicate receipt_hash on the same day is still rejected (anti-fraud intact)', async () => {
    await seedVoucher(sql, '1000000003');

    let errorThrown = false;
    try {
      await sql`
        INSERT INTO redemption_logs
          (vehicle_plate, vehicle_plate_hash, receipt_amount, receipt_date, tenant_name,
           voucher_code, receipt_hash, receipt_number, receipt_fingerprint_hash)
        VALUES
          (NULL, NULL, 31.00, CURRENT_DATE, 'Saizeriya',
           '1000000003', ${'a'.repeat(64)}, 'RCPT-0003', ${'e'.repeat(64)});
      `;
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain('uq_redemption_receipt_hash_daily');
    }
    expect(errorThrown).toBe(true);
  });

  test('0005 up: duplicate receipt fingerprint on the same day is still rejected', async () => {
    await seedVoucher(sql, '1000000004');

    let errorThrown = false;
    try {
      await sql`
        INSERT INTO redemption_logs
          (vehicle_plate, vehicle_plate_hash, receipt_amount, receipt_date, tenant_name,
           voucher_code, receipt_hash, receipt_number, receipt_fingerprint_hash)
        VALUES
          (NULL, NULL, 31.00, CURRENT_DATE, 'Saizeriya',
           '1000000004', ${'f'.repeat(64)}, 'RCPT-0002', ${'d'.repeat(64)});
      `;
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain('uq_redemption_receipt_fingerprint_daily');
    }
    expect(errorThrown).toBe(true);
  });

  test('0005 up: idempotent re-apply does not error', async () => {
    await applyMigration(sql, '0005_shift_to_receipt_number_tracking', 'up');
    expect(await indexExists(sql, 'uq_redemption_vehicle_daily')).toBe(false);
    const plate = await columnInfo(sql, 'redemption_logs', 'vehicle_plate');
    expect(plate!.nullable).toBe(true);
  });

  test('0005 down: cannot be applied once 2+ plate-less redemptions exist on one day (rollback unsafe)', async () => {
    // Boundary probe: the down migration backfills every NULL plate with the same
    // sentinel ('SG-UNKNOWN') before rebuilding the (vehicle_plate, receipt_date)
    // unique index. Two plate-less CLAIMED rows on the same receipt_date therefore
    // collide and the rebuild fails. Wrapped in a transaction so the failure rolls
    // back and leaves the schema on 0005 for the following tests.
    let downError: any = null;
    try {
      await sql.begin(async (tx) => {
        await applyMigration(tx as unknown as SQL, '0005_shift_to_receipt_number_tracking', 'down');
        throw new Error('__FORCE_ROLLBACK__');
      });
    } catch (err: any) {
      downError = err;
    }

    expect(downError).not.toBeNull();
    expect(String(downError.message)).toContain('uq_redemption_vehicle_daily');
  });

  test('0005 down: restores NOT NULL constraints and the vehicle-bound daily index', async () => {
    // Reduce to a single plate-less row so the rebuild can succeed.
    await sql`
      DELETE FROM redemption_logs
      WHERE vehicle_plate IS NULL
        AND receipt_number = 'RCPT-0002';
    `;

    await applyMigration(sql, '0005_shift_to_receipt_number_tracking', 'down');

    const plate = await columnInfo(sql, 'redemption_logs', 'vehicle_plate');
    expect(plate!.nullable).toBe(false);

    const plateHash = await columnInfo(sql, 'redemption_logs', 'vehicle_plate_hash');
    expect(plateHash!.nullable).toBe(false);

    const auditPlate = await columnInfo(sql, 'redemption_audit_logs', 'vehicle_plate');
    expect(auditPlate!.nullable).toBe(false);

    expect(await indexExists(sql, 'uq_redemption_vehicle_daily')).toBe(true);

    // Backfilled historical row is queryable again
    const backfilled = await sql`
      SELECT vehicle_plate FROM redemption_logs WHERE receipt_number = 'RCPT-0001';
    `;
    expect((backfilled[0] as any).vehicle_plate).toBe('SG-UNKNOWN');
  });

  test('0005 up → down → up round trip is repeatable', async () => {
    await applyMigration(sql, '0005_shift_to_receipt_number_tracking', 'up');
    expect(await indexExists(sql, 'uq_redemption_vehicle_daily')).toBe(false);

    const plate = await columnInfo(sql, 'redemption_logs', 'vehicle_plate');
    expect(plate!.nullable).toBe(true);
  });
});
