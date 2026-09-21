/**
 * PAN-95 — Quality Gate: migration 0004 (strict 10-digit numeric voucher codes)
 * verified against a real PostgreSQL 16 server.
 *
 * Scope:
 *  - 0004 up installs the CHECK constraint and enforces it (incl. leading zeros)
 *  - 0004 up is idempotent; 0004 down drops the constraint and is idempotent
 *  - 0004 up does NOT destroy voucher history / redemption_logs data
 *  - 0004 up survives the production-shaped starting state it was written for
 *    (legacy non-compliant codes already in voucher_pool)
 *  - the proposed NOT VALID variant is validated as a viable fix
 *
 * Container is isolated from tests/migrations.test.ts (distinct name + port) so
 * the two files can run in parallel.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CONTAINER_NAME = 'test-clementi-pg16-pan95';
const PG_PORT = 55436;
const DB_USER = 'clementi_admin';
const DB_PASS = 'clementi_secret_123';
const DB_NAME = 'clementi_pan95_db';
const PG_URL = `postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}`;

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');
const M0004 = '0004_enforce_10digit_numeric_voucher_codes.up.sql';
const M0004_DOWN = '0004_enforce_10digit_numeric_voucher_codes.down.sql';
const BASE_MIGRATIONS = [
  '0001_create_voucher_pool_and_redemption_logs.up.sql',
  '0002_create_shops_and_unclaim_support.up.sql',
  '0003_add_receipt_deduplication_and_verification.up.sql',
];

const CONSTRAINT = 'ck_voucher_pool_voucher_code_numeric_10';

let sql: SQL;

const readMigration = (name: string) => readFile(join(MIGRATIONS_DIR, name), 'utf-8');

/** Mirrors scripts/migrate.ts: every migration file runs inside one transaction. */
async function applyMigration(name: string) {
  const content = await readMigration(name);
  await sql.begin(async (tx: any) => {
    await tx.unsafe(content);
  });
}

/** Applies a migration and returns the error message instead of throwing (null = success). */
async function applyMigrationCapturingError(name: string): Promise<string | null> {
  const content = await readMigration(name);
  try {
    await sql.begin(async (tx: any) => {
      await tx.unsafe(content);
    });
    return null;
  } catch (err: any) {
    return err?.message ?? String(err);
  }
}

async function constraintCount(): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS c FROM pg_constraint WHERE conname = ${CONSTRAINT}
  `;
  return (rows[0] as any).c;
}

async function constraintValidated(): Promise<boolean | null> {
  const rows = await sql`
    SELECT convalidated FROM pg_constraint WHERE conname = ${CONSTRAINT}
  `;
  return rows.length ? (rows[0] as any).convalidated : null;
}

/** Drops everything and rebuilds the 0001→0003 baseline (i.e. production before PAN-95). */
async function resetToBase() {
  await sql.unsafe(`
    DROP TABLE IF EXISTS redemption_audit_logs CASCADE;
    DROP TABLE IF EXISTS redemption_logs CASCADE;
    DROP TABLE IF EXISTS voucher_pool CASCADE;
    DROP TABLE IF EXISTS shops CASCADE;
  `);
  for (const m of BASE_MIGRATIONS) await applyMigration(m);
}

/** Inserts a non-compliant legacy voucher (allowed before the constraint exists). */
async function seedVoucher(code: string, status: string, batch = 'LEGACY-BATCH-01') {
  await sql`INSERT INTO voucher_pool (voucher_code, status, batch_id) VALUES (${code}, ${status}, ${batch})`;
}

async function seedLegacyRedemptionLog(voucherCode: string) {
  await sql`
    INSERT INTO redemption_logs (vehicle_plate_hash, vehicle_plate, receipt_amount, receipt_date, tenant_name, voucher_code)
    VALUES ('legacy_hash_pan95', 'SBA1234A', 35.50, '2026-08-01', 'Saizeriya', ${voucherCode})
  `;
}

async function insertVoucher(code: string): Promise<string | null> {
  try {
    await sql`INSERT INTO voucher_pool (voucher_code, status) VALUES (${code}, 'AVAILABLE')`;
    return null;
  } catch (err: any) {
    return err?.message ?? String(err);
  }
}

beforeAll(async () => {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });

  const start = spawnSync('docker', [
    'run', '-d', '--rm', '--name', CONTAINER_NAME,
    '-e', `POSTGRES_DB=${DB_NAME}`,
    '-e', `POSTGRES_USER=${DB_USER}`,
    '-e', `POSTGRES_PASSWORD=${DB_PASS}`,
    '-p', `${PG_PORT}:5432`,
    'postgres:16-alpine',
  ]);
  if (start.status !== 0) {
    throw new Error(`Failed to start postgres:16-alpine container: ${start.stderr.toString()}`);
  }

  let ready = false;
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(250);
    const check = spawnSync('docker', ['exec', CONTAINER_NAME, 'pg_isready', '-U', DB_USER, '-d', DB_NAME]);
    if (check.status === 0) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
    throw new Error('PostgreSQL 16 container timed out waiting for ready state');
  }

  sql = new SQL(PG_URL);
  const version = await sql`SELECT version() AS v`;
  expect((version[0] as any).v).toContain('PostgreSQL 16');
}, 60_000);

afterAll(async () => {
  if (sql) await sql.close();
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
});

describe('PAN-95 migration 0004 — clean-database application', () => {
  test('0004 up applies cleanly and installs a VALIDATED CHECK constraint', async () => {
    await resetToBase();
    expect(await applyMigrationCapturingError(M0004)).toBeNull();
    expect(await constraintCount()).toBe(1);
    expect(await constraintValidated()).toBe(true);
  });

  test('constraint accepts exactly 10 decimal digits (incl. leading zeros)', async () => {
    await resetToBase();
    await applyMigration(M0004);

    for (const code of ['0000000001', '0000012345', '1234567890', '9999999999']) {
      expect(`${code} → ${await insertVoucher(code)}`).toBe(`${code} → null`);
    }
  });

  test('constraint rejects legacy, alpha and wrong-length codes', async () => {
    await resetToBase();
    await applyMigration(M0004);

    const rejected = [
      'CLM-12345678',   // legacy production format
      'CLM-98765432',
      ' 12345678',      // whitespace padding
      '123456789',      // 9 digits
      '12345678901',    // 11 digits
      '12345abcde',     // alpha
      'V-CLM-DAILY-1',  // ops batch format
      '',               // empty
    ];
    for (const code of rejected) {
      const err = await insertVoucher(code);
      expect(`${code} → ${err ? 'rejected' : 'ACCEPTED'}`).toBe(`${code} → rejected`);
      expect(err).toContain(CONSTRAINT);
    }
  });

  test('0004 up is idempotent (re-run is a no-op, not an error)', async () => {
    await resetToBase();
    await applyMigration(M0004);
    expect(await applyMigrationCapturingError(M0004)).toBeNull();
    expect(await constraintCount()).toBe(1);
  });

  test('0004 down drops the constraint and is idempotent', async () => {
    await resetToBase();
    await applyMigration(M0004);
    expect(await constraintCount()).toBe(1);

    await applyMigration(M0004_DOWN);
    expect(await constraintCount()).toBe(0);

    expect(await applyMigrationCapturingError(M0004_DOWN)).toBeNull();

    // Constraint gone → legacy inserts are possible again (documented rollback behaviour)
    expect(await insertVoucher('CLM-12345678')).toBeNull();
  });

  test('0004 up preserves voucher history and redemption logs (no data loss)', async () => {
    await resetToBase();
    await seedVoucher('0000000011', 'REDEEMED');
    await seedLegacyRedemptionLog('0000000011');
    await seedVoucher('0000000012', 'AVAILABLE');

    const logsBefore = (await sql`SELECT count(*)::int c FROM redemption_logs`)[0] as any;
    expect(await applyMigrationCapturingError(M0004)).toBeNull();

    const rows = await sql`SELECT voucher_code, status FROM voucher_pool ORDER BY voucher_code`;
    expect(rows.map((r: any) => `${r.voucher_code}:${r.status}`)).toEqual([
      '0000000011:REDEEMED',
      '0000000012:AVAILABLE',
    ]);
    expect(((await sql`SELECT count(*)::int c FROM redemption_logs`)[0] as any).c).toBe(logsBefore.c);
  });
});

describe('PAN-95 migration 0004 — production-shaped data (legacy non-compliant codes)', () => {
  test('[PAN-95 FINDING-1] 0004 up must apply when voucher_pool still holds non-compliant AVAILABLE rows', async () => {
    // This is the exact starting state migration 0004 documents itself as written for:
    // "Step 1: EXPIRE non-compliant AVAILABLE vouchers so ops starts with a clean numeric batch".
    await resetToBase();
    await seedVoucher('CLM-11111111', 'AVAILABLE');
    await seedVoucher('0000000021', 'AVAILABLE');

    const err = await applyMigrationCapturingError(M0004);
    expect(
      err === null ? null : `migration 0004 aborted — ${err}`
    ).toBeNull();

    // Step 1 must have purged the non-compliant inventory and step 2 must hold.
    const available = await sql`
      SELECT voucher_code FROM voucher_pool WHERE status = 'AVAILABLE' ORDER BY voucher_code
    `;
    expect(available.map((r: any) => r.voucher_code)).toEqual(['0000000021']);
    expect(await constraintCount()).toBe(1);
  });

  test('[PAN-95 FINDING-2] 0004 up must apply when legacy non-compliant vouchers exist in history', async () => {
    // Redeemed history is explicitly declared "untouched" by the migration, but the
    // table-level ADD CONSTRAINT validates every existing row, including those.
    await resetToBase();
    await seedVoucher('CLM-22222222', 'REDEEMED');
    await seedLegacyRedemptionLog('CLM-22222222');
    await seedVoucher('0000000022', 'AVAILABLE');

    const err = await applyMigrationCapturingError(M0004);
    expect(
      err === null ? null : `migration 0004 aborted — ${err}`
    ).toBeNull();

    // History must survive the migration.
    const history = await sql`
      SELECT voucher_code, status FROM voucher_pool WHERE voucher_code = 'CLM-22222222'
    `;
    expect(history.length).toBe(1);
    expect((history[0] as any).status).toBe('REDEEMED');
    expect(await constraintCount()).toBe(1);
  });

  test('proposed fix: ADD CONSTRAINT ... NOT VALID survives legacy rows and still blocks new bad inserts', async () => {
    await resetToBase();
    await seedVoucher('CLM-11111111', 'AVAILABLE');
    await seedVoucher('CLM-22222222', 'REDEEMED');
    await seedLegacyRedemptionLog('CLM-22222222');
    await seedVoucher('0000000023', 'AVAILABLE');

    // Build the fix from the migration's own CHECK expression so it cannot drift.
    const upSql = await readMigration(M0004);
    const checkExpr = upSql.match(/ADD CONSTRAINT[\s\S]*?CHECK \([^)]*\)/);
    expect(checkExpr).not.toBeNull();

    await sql.unsafe(`ALTER TABLE voucher_pool ${checkExpr![0]} NOT VALID`);

    expect(await constraintCount()).toBe(1);
    expect(await constraintValidated()).toBe(false);

    // History and non-compliant rows are preserved…
    const preserved = await sql`
      SELECT voucher_code, status FROM voucher_pool ORDER BY voucher_code
    `;
    expect(preserved.map((r: any) => `${r.voucher_code}:${r.status}`)).toEqual([
      '0000000023:AVAILABLE',
      'CLM-11111111:AVAILABLE',
      'CLM-22222222:REDEEMED',
    ]);

    // …while every NEW write must be compliant.
    expect(await insertVoucher('CLM-33333333')).toContain(CONSTRAINT);
    expect(await insertVoucher('123456789')).toContain(CONSTRAINT);
    expect(await insertVoucher('0000000024')).toBeNull();

    // Documented residual: a NOT VALID constraint is still enforced on UPDATE of the
    // touched row, so legacy non-compliant rows become immutable (they cannot even be
    // re-statused). Ops must DELETE them instead — and referenced rows are protected by
    // fk_redemption_logs_voucher_code ON DELETE RESTRICT.
    let updateErr: string | null = null;
    try {
      await sql`UPDATE voucher_pool SET status = 'EXPIRED' WHERE voucher_code = 'CLM-11111111'`;
    } catch (err: any) {
      updateErr = err?.message ?? String(err);
    }
    expect(updateErr).toContain(CONSTRAINT);
  });
});
