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
