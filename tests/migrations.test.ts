import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CONTAINER_NAME = 'test-clementi-pg16-runner';
const PG_PORT = 55435;
const DB_USER = 'clementi_admin';
const DB_PASS = 'clementi_secret_123';
const DB_NAME = 'clementi_test_db';
const PG_URL = `postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}`;

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

let sql: SQL;

beforeAll(async () => {
  // 1. Clean up any leftover container
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

  // 3. Wait for PostgreSQL 16 init process to complete fully
  let ready = false;
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(200);
    const logs = spawnSync('docker', ['logs', CONTAINER_NAME], { encoding: 'utf-8' });
    const logText = logs.stdout || '';

    // Alpine postgres restarts after initdb, so wait for final ready state
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

  // 4. Initialize Bun SQL client
  sql = new SQL(PG_URL);
});

afterAll(async () => {
  if (sql) {
    await sql.close();
  }
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
});

describe('PostgreSQL 16 Schema Migrations (PAN-59)', () => {
  test('PostgreSQL server version is confirmed 16.x', async () => {
    const res = await sql`SELECT version() as ver;`;
    expect(res.length).toBe(1);
    expect(res[0].ver).toContain('PostgreSQL 16');
  });

  test('Up migration applies cleanly on PostgreSQL 16', async () => {
    const upSql = await readFile(join(MIGRATIONS_DIR, '0001_create_voucher_pool_and_redemption_logs.up.sql'), 'utf-8');
    await sql.unsafe(upSql);

    // Verify tables exist
    const tables = await sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename;
    `;
    const tableNames = tables.map((t: any) => t.tablename);
    expect(tableNames).toContain('voucher_pool');
    expect(tableNames).toContain('redemption_logs');
  });

  test('Required indexes and partial FIFO index exist in pg_indexes', async () => {
    const indexes = await sql`
      SELECT indexname, tablename, indexdef 
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY indexname;
    `;
    const indexMap = new Map(indexes.map((idx: any) => [idx.indexname, idx]));

    // 1. Partial FIFO index on voucher_pool
    expect(indexMap.has('idx_voucher_pool_fifo_available')).toBe(true);
    const fifoDef = (indexMap.get('idx_voucher_pool_fifo_available') as any).indexdef;
    expect(fifoDef).toContain('idx_voucher_pool_fifo_available');
    expect(fifoDef).toContain('status');
    expect(fifoDef).toContain('AVAILABLE');

    // 2. Unique daily constraint index on redemption_logs
    expect(indexMap.has('uq_redemption_vehicle_daily')).toBe(true);
    const dailyDef = (indexMap.get('uq_redemption_vehicle_daily') as any).indexdef;
    expect(dailyDef).toContain('UNIQUE INDEX');
    expect(dailyDef).toContain('vehicle_plate_hash');
    expect(dailyDef).toContain('receipt_date');

    // 3. Foreign key and lookup indexes
    expect(indexMap.has('idx_redemption_logs_voucher_code')).toBe(true);
    expect(indexMap.has('idx_redemption_logs_created_at')).toBe(true);
    expect(indexMap.has('idx_redemption_logs_receipt_date')).toBe(true);
    expect(indexMap.has('idx_voucher_pool_batch_id')).toBe(true);
    expect(indexMap.has('idx_voucher_pool_status')).toBe(true);
  });

  test('Voucher pool check constraint enforces valid statuses', async () => {
    // Valid status succeeds
    await sql`
      INSERT INTO voucher_pool (voucher_code, barcode_format, status, batch_id)
      VALUES ('V-TEST-STATUS-OK', 'CODE128', 'AVAILABLE', 'BATCH-INIT');
    `;

    // Invalid status throws check constraint violation
    let errorThrown = false;
    try {
      await sql`
        INSERT INTO voucher_pool (voucher_code, status)
        VALUES ('V-TEST-STATUS-BAD', 'INVALID_STATUS');
      `;
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain('ck_voucher_pool_status');
    }
    expect(errorThrown).toBe(true);
  });

  test('Daily duplicate plate insertion throws unique constraint violation', async () => {
    const plateHash = 'hash_plate_sg_car_sba1234a';
    const testDate = '2026-09-16';

    // Seed voucher pool
    await sql`
      INSERT INTO voucher_pool (voucher_code, status)
      VALUES 
        ('V-CLM-DAILY-1', 'AVAILABLE'),
        ('V-CLM-DAILY-2', 'AVAILABLE');
    `;

    // First redemption on date succeeds
    await sql`
      INSERT INTO redemption_logs (
        vehicle_plate_hash,
        receipt_amount,
        receipt_date,
        tenant_name,
        voucher_code
      ) VALUES (
        ${plateHash},
        35.50,
        ${testDate},
        'FairPrice Finest',
        'V-CLM-DAILY-1'
      );
    `;

    // Attempting duplicate redemption for SAME plate on SAME date must throw unique constraint violation
    let errorThrown = false;
    try {
      await sql`
        INSERT INTO redemption_logs (
          vehicle_plate_hash,
          receipt_amount,
          receipt_date,
          tenant_name,
          voucher_code
        ) VALUES (
          ${plateHash},
          50.00,
          ${testDate},
          'Toast Box',
          'V-CLM-DAILY-2'
        );
      `;
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain('uq_redemption_vehicle_daily');
    }
    expect(errorThrown).toBe(true);

    // Same plate on a DIFFERENT date succeeds
    const nextDayDate = '2026-09-17';
    await sql`
      INSERT INTO redemption_logs (
        vehicle_plate_hash,
        receipt_amount,
        receipt_date,
        tenant_name,
        voucher_code
      ) VALUES (
        ${plateHash},
        42.00,
        ${nextDayDate},
        'Din Tai Fung',
        'V-CLM-DAILY-2'
      );
    `;
  });

  test('Foreign key constraint restricts orphan voucher codes in redemption_logs', async () => {
    let errorThrown = false;
    try {
      await sql`
        INSERT INTO redemption_logs (
          vehicle_plate_hash,
          receipt_amount,
          receipt_date,
          tenant_name,
          voucher_code
        ) VALUES (
          'hash_plate_orphan',
          35.00,
          '2026-09-16',
          'KFC',
          'DOES_NOT_EXIST_VOUCHER'
        );
      `;
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain('fk_redemption_logs_voucher_code');
    }
    expect(errorThrown).toBe(true);
  });

  test('Atomic SKIP LOCKED query uses FIFO partial index and returns voucher in <2ms', async () => {
    // 1. Seed 1,000 available vouchers
    const vouchers: { voucher_code: string; batch_id: string }[] = [];
    for (let i = 1; i <= 1000; i++) {
      vouchers.push({
        voucher_code: `V-PERF-${String(i).padStart(6, '0')}`,
        batch_id: 'PERF-BATCH-01',
      });
    }

    // Batch insert using VALUES
    const batchValues = vouchers.map(v => `('${v.voucher_code}', '${v.batch_id}', 'AVAILABLE')`).join(',');
    await sql.unsafe(`
      INSERT INTO voucher_pool (voucher_code, batch_id, status)
      VALUES ${batchValues};
    `);

    // Refresh table statistics for query planner
    await sql`ANALYZE voucher_pool;`;

    // 2. Verify query execution plan and internal DB execution time via EXPLAIN ANALYZE
    const explainResult = await sql`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT id, voucher_code
      FROM voucher_pool
      WHERE status = 'AVAILABLE'
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED;
    `;
    const planText = explainResult.map((r: any) => r['QUERY PLAN']).join('\n');
    expect(planText).toContain('idx_voucher_pool_fifo_available');
    expect(planText).toContain('Index Scan');

    // Extract execution time from EXPLAIN ANALYZE output
    const execTimeMatch = planText.match(/Execution Time: ([\d.]+) ms/);
    expect(execTimeMatch).not.toBeNull();
    const explainExecTime = parseFloat(execTimeMatch![1]);
    console.log(`[EXPLAIN ANALYZE] PostgreSQL Query Execution Time: ${explainExecTime} ms`);
    expect(explainExecTime).toBeLessThan(2.0);

    // Warm up the connection
    for (let w = 0; w < 3; w++) {
      await sql`SELECT id FROM voucher_pool WHERE status = 'AVAILABLE' ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED;`;
    }

    // 3. Measure sequential client-side round trip latency across 25 calls
    const latencies: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      const res = await sql`
        SELECT id, voucher_code 
        FROM voucher_pool 
        WHERE status = 'AVAILABLE' 
        ORDER BY id ASC 
        LIMIT 1 
        FOR UPDATE SKIP LOCKED;
      `;
      const elapsed = performance.now() - t0;
      latencies.push(elapsed);
      expect(res.length).toBe(1);
    }

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    latencies.sort((a, b) => a - b);
    const p95Latency = latencies[Math.floor(latencies.length * 0.95)];

    console.log(`[LATENCY BENCHMARK] 25 Sequential SKIP LOCKED queries:`);
    console.log(` - Min Latency: ${latencies[0].toFixed(3)} ms`);
    console.log(` - Avg Latency: ${avgLatency.toFixed(3)} ms`);
    console.log(` - P95 Latency: ${p95Latency.toFixed(3)} ms`);

    // Verify average roundtrip latency is <5ms
    expect(avgLatency).toBeLessThan(5.0);

    // 4. Verify atomic allocations and collision-freedom
    const today = '2026-09-16';
    const allocatedCodes: string[] = [];

    for (let i = 0; i < 20; i++) {
      const plateHash = `hash_allocation_worker_${i + 500}`;
      const result = await sql`
        WITH available_voucher AS (
            SELECT id, voucher_code, barcode_format
            FROM voucher_pool
            WHERE status = 'AVAILABLE'
            ORDER BY id ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        ),
        reserved_voucher AS (
            UPDATE voucher_pool v
            SET status = 'REDEEMED',
                allocated_at = NOW(),
                redeemed_at = NOW(),
                vehicle_plate_hash = ${plateHash}
            FROM available_voucher av
            WHERE v.id = av.id
            RETURNING v.id, v.voucher_code, v.barcode_format
        ),
        inserted_log AS (
            INSERT INTO redemption_logs (
                vehicle_plate_hash,
                receipt_amount,
                receipt_date,
                tenant_name,
                voucher_code,
                created_at
            )
            SELECT
                ${plateHash},
                45.00 + ${i},
                ${today},
                'FairPrice Finest',
                rv.voucher_code,
                NOW()
            FROM reserved_voucher rv
            RETURNING id, voucher_code
        )
        SELECT 
            rv.voucher_code,
            rv.barcode_format
        FROM reserved_voucher rv;
      `;
      allocatedCodes.push(result[0].voucher_code);
    }

    // Verify all allocations received a distinct voucher code (0 collisions)
    const uniqueCodes = new Set(allocatedCodes);
    expect(uniqueCodes.size).toBe(20);
  });

  test('Down migration rolls back cleanly, dropping all tables and indexes', async () => {
    const downSql = await readFile(join(MIGRATIONS_DIR, '0001_create_voucher_pool_and_redemption_logs.down.sql'), 'utf-8');
    await sql.unsafe(downSql);

    const tables = await sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public';
    `;
    const tableNames = tables.map((t: any) => t.tablename);
    expect(tableNames).not.toContain('voucher_pool');
    expect(tableNames).not.toContain('redemption_logs');

    const indexes = await sql`
      SELECT indexname 
      FROM pg_indexes 
      WHERE schemaname = 'public';
    `;
    const indexNames = indexes.map((idx: any) => idx.indexname);
    expect(indexNames).not.toContain('idx_voucher_pool_fifo_available');
    expect(indexNames).not.toContain('uq_redemption_vehicle_daily');
  });

  test('Re-running Up migration succeeds idempotently', async () => {
    const upSql = await readFile(join(MIGRATIONS_DIR, '0001_create_voucher_pool_and_redemption_logs.up.sql'), 'utf-8');
    await sql.unsafe(upSql);

    const tables = await sql`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public';
    `;
    const tableNames = tables.map((t: any) => t.tablename);
    expect(tableNames).toContain('voucher_pool');
    expect(tableNames).toContain('redemption_logs');
  });
});

// ============================================================================
// Migration 0004: 10-digit Numeric Voucher Code Enforcement (PAN-95)
// Each test in this suite is sequential and builds on prior state.
// ============================================================================
describe('Migration 0004: 10-digit numeric voucher code enforcement (PAN-95)', () => {
  // Apply full migration chain (0001→0003) before 0004 tests.
  // These run after the 0001 suite above which leaves the schema clean (idempotent re-apply).
  test('0001→0003 applied as baseline for 0004 tests', async () => {
    // 0001 is already applied by the prior suite's idempotent re-run test.
    // Apply 0002 and 0003 to get the full real schema.
    const m0002 = await readFile(join(MIGRATIONS_DIR, '0002_create_shops_and_unclaim_support.up.sql'), 'utf-8');
    const m0003 = await readFile(join(MIGRATIONS_DIR, '0003_add_receipt_deduplication_and_verification.up.sql'), 'utf-8');
    await sql.unsafe(m0002);
    await sql.unsafe(m0003);

    const tables = await sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
    `;
    const tableNames = tables.map((t: any) => t.tablename);
    expect(tableNames).toContain('voucher_pool');
    expect(tableNames).toContain('shops');
    expect(tableNames).toContain('redemption_logs');
    expect(tableNames).toContain('redemption_audit_logs');
  });

  test('Seed: compliant + non-compliant AVAILABLE + legacy REDEEMED rows', async () => {
    // Compliant AVAILABLE (10-digit numeric) — must survive the migration and remain available
    await sql`
      INSERT INTO voucher_pool (voucher_code, status, batch_id)
      VALUES
        ('0000000001', 'AVAILABLE', 'BATCH-NUMERIC'),
        ('9999999999', 'AVAILABLE', 'BATCH-NUMERIC'),
        ('1234567890', 'AVAILABLE', 'BATCH-NUMERIC');
    `;

    // Non-compliant AVAILABLE (old alpha-prefix format) — must be EXPIRED by migration
    await sql`
      INSERT INTO voucher_pool (voucher_code, status, batch_id)
      VALUES
        ('CLM-0000001', 'AVAILABLE', 'BATCH-LEGACY'),
        ('CLM-0000002', 'AVAILABLE', 'BATCH-LEGACY'),
        ('TOOSHORT', 'AVAILABLE', 'BATCH-LEGACY');
    `;

    // Legacy REDEEMED rows with non-compliant codes — must be UNTOUCHED by migration
    await sql`
      INSERT INTO voucher_pool (voucher_code, status, batch_id)
      VALUES
        ('CLM-HIST-001', 'REDEEMED', 'BATCH-LEGACY'),
        ('CLM-HIST-002', 'REDEEMED', 'BATCH-LEGACY');
    `;

    const counts = await sql`
      SELECT status, count(*)::int as cnt
      FROM voucher_pool
      GROUP BY status
      ORDER BY status;
    `;
    const byStatus = Object.fromEntries(counts.map((r: any) => [r.status, r.cnt]));
    expect(byStatus['AVAILABLE']).toBe(6);
    expect(byStatus['REDEEMED']).toBe(2);
  });

  test('0004 up: non-compliant AVAILABLE rows expired, compliant rows untouched', async () => {
    const m0004up = await readFile(join(MIGRATIONS_DIR, '0004_enforce_10digit_numeric_voucher_codes.up.sql'), 'utf-8');
    await sql.unsafe(m0004up);

    // Non-compliant AVAILABLE must now be EXPIRED
    const expired = await sql`
      SELECT voucher_code FROM voucher_pool WHERE status = 'EXPIRED' ORDER BY voucher_code;
    `;
    const expiredCodes = expired.map((r: any) => r.voucher_code);
    expect(expiredCodes).toContain('CLM-0000001');
    expect(expiredCodes).toContain('CLM-0000002');
    expect(expiredCodes).toContain('TOOSHORT');

    // Compliant AVAILABLE rows must still be AVAILABLE
    const available = await sql`
      SELECT voucher_code FROM voucher_pool WHERE status = 'AVAILABLE' ORDER BY voucher_code;
    `;
    const availableCodes = available.map((r: any) => r.voucher_code);
    expect(availableCodes).toContain('0000000001');
    expect(availableCodes).toContain('1234567890');
    expect(availableCodes).toContain('9999999999');
    expect(availableCodes).not.toContain('CLM-0000001');

    // Legacy REDEEMED rows must be completely untouched
    const redeemed = await sql`
      SELECT voucher_code FROM voucher_pool WHERE status = 'REDEEMED' ORDER BY voucher_code;
    `;
    const redeemedCodes = redeemed.map((r: any) => r.voucher_code);
    expect(redeemedCodes).toContain('CLM-HIST-001');
    expect(redeemedCodes).toContain('CLM-HIST-002');
  });

  test('0004 up: CHECK constraint (NOT VALID) exists and is table-scoped', async () => {
    const constraints = await sql`
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conname   = 'ck_voucher_pool_voucher_code_numeric_10'
        AND conrelid  = 'voucher_pool'::regclass;
    `;
    expect(constraints.length).toBe(1);
    // NOT VALID means convalidated = false
    expect((constraints[0] as any).convalidated).toBe(false);
  });

  test('0004 up: constraint blocks non-compliant INSERT on new rows', async () => {
    let errorThrown = false;
    try {
      await sql`
        INSERT INTO voucher_pool (voucher_code, status, batch_id)
        VALUES ('BAD-CODE-XX', 'AVAILABLE', 'BATCH-BAD');
      `;
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain('ck_voucher_pool_voucher_code_numeric_10');
    }
    expect(errorThrown).toBe(true);
  });

  test('0004 up: constraint allows compliant INSERT', async () => {
    await sql`
      INSERT INTO voucher_pool (voucher_code, status, batch_id)
      VALUES ('5555555555', 'AVAILABLE', 'BATCH-NUMERIC-NEW');
    `;
    const row = await sql`
      SELECT voucher_code, status FROM voucher_pool WHERE voucher_code = '5555555555';
    `;
    expect(row.length).toBe(1);
    expect((row[0] as any).status).toBe('AVAILABLE');
  });

  test('0004 up: idempotent re-apply does not error', async () => {
    const m0004up = await readFile(join(MIGRATIONS_DIR, '0004_enforce_10digit_numeric_voucher_codes.up.sql'), 'utf-8');
    // Should not throw — DO block guards with IF NOT EXISTS (scoped to conrelid)
    await sql.unsafe(m0004up);

    const constraints = await sql`
      SELECT count(*)::int as cnt
      FROM pg_constraint
      WHERE conname   = 'ck_voucher_pool_voucher_code_numeric_10'
        AND conrelid  = 'voucher_pool'::regclass;
    `;
    // Still exactly one constraint — no duplicate created
    expect((constraints[0] as any).cnt).toBe(1);
  });

  test('0004 down: constraint dropped, legacy REDEEMED rows still intact', async () => {
    const m0004down = await readFile(join(MIGRATIONS_DIR, '0004_enforce_10digit_numeric_voucher_codes.down.sql'), 'utf-8');
    await sql.unsafe(m0004down);

    const constraints = await sql`
      SELECT count(*)::int as cnt
      FROM pg_constraint
      WHERE conname   = 'ck_voucher_pool_voucher_code_numeric_10'
        AND conrelid  = 'voucher_pool'::regclass;
    `;
    expect((constraints[0] as any).cnt).toBe(0);

    // Legacy REDEEMED rows still untouched
    const redeemed = await sql`
      SELECT voucher_code FROM voucher_pool WHERE status = 'REDEEMED' ORDER BY voucher_code;
    `;
    const redeemedCodes = redeemed.map((r: any) => r.voucher_code);
    expect(redeemedCodes).toContain('CLM-HIST-001');
    expect(redeemedCodes).toContain('CLM-HIST-002');

    // Non-compliant INSERT now succeeds (constraint gone)
    await sql`
      INSERT INTO voucher_pool (voucher_code, status, batch_id)
      VALUES ('ROLLBACK-TEST', 'AVAILABLE', 'BATCH-DOWN');
    `;
    const row = await sql`SELECT voucher_code FROM voucher_pool WHERE voucher_code = 'ROLLBACK-TEST';`;
    expect(row.length).toBe(1);
  });
});
