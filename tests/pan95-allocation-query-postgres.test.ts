/**
 * PAN-95 — Quality Gate: allocation-path behaviour (Sentinel MEDIUM 4).
 *
 * The fix moved the 10-digit predicate into the ATOMIC_ALLOCATION_CTE selector. This file
 * runs the REAL exported query text against a real PostgreSQL 16 server, because that is the
 * only way to catch the two failure modes a static review misses:
 *
 *   a) the `\d` escaping trap — `queries.ts` embeds the regex in a JS template literal, so a
 *      single-backslash source literal would silently cook to `^d{10}$` and match nothing;
 *   b) a selector that pops non-compliant rows anyway (the original MEDIUM 4 defect: slot
 *      burned, no code delivered).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ATOMIC_ALLOCATION_CTE, COUNT_AVAILABLE_VOUCHERS_QUERY, VOUCHER_CODE_REGEX } from '../src/db/queries';

const CONTAINER_NAME = 'test-clementi-pg16-pan95-alloc';
const PG_PORT = 55437;
const DB_USER = 'clementi_admin';
const DB_PASS = 'clementi_secret_123';
const DB_NAME = 'clementi_pan95_alloc';
const PG_URL = `postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}`;

const ROOT = join(import.meta.dir, '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const REDEMPTIONS_API = join(ROOT, 'src', 'pages', 'api', 'v1', 'redemptions.ts');
const BASE_MIGRATIONS = [
  '0001_create_voucher_pool_and_redemption_logs.up.sql',
  '0002_create_shops_and_unclaim_support.up.sql',
  '0003_add_receipt_deduplication_and_verification.up.sql',
];

let sql: SQL;

/** Mirrors scripts/migrate.ts: each file runs inside one transaction. */
async function applyMigration(name: string) {
  const content = await readFile(join(MIGRATIONS_DIR, name), 'utf-8');
  await sql.begin(async (tx: any) => {
    await tx.unsafe(content);
  });
}

async function resetToBase() {
  await sql.unsafe(`
    DROP TABLE IF EXISTS redemption_audit_logs CASCADE;
    DROP TABLE IF EXISTS redemption_logs CASCADE;
    DROP TABLE IF EXISTS voucher_pool CASCADE;
    DROP TABLE IF EXISTS shops CASCADE;
  `);
  for (const m of BASE_MIGRATIONS) await applyMigration(m);
}

/** Exactly how src/pages/api/v1/redemptions.ts:299 calls the CTE (sql.unsafe, no transaction). */
let allocSeq = 0;
async function allocate(plateHash: string, plate: string) {
  // Each call needs a unique receipt hash/number: uq_redemption_receipt_hash_daily and
  // uq_redemption_receipt_fingerprint_daily are global per receipt_date.
  const n = String(++allocSeq).padStart(4, '0');
  return sql.unsafe(ATOMIC_ALLOCATION_CTE, [
    plateHash,                     // $1 vehicle_plate_hash
    plate,                         // $2 vehicle_plate
    35.5,                          // $3 receipt_amount
    '2026-09-21',                  // $4 receipt_date
    'Saizeriya',                   // $5 tenant_name
    null,                          // $6 shop_id
    'a'.repeat(64),                // $7 claim_token_hash
    '203.0.113.9',                 // $8 ip_address
    'qa-suite',                    // $9 user_agent
    `hash${n}`.padEnd(64, '0'),    // $10 receipt_hash
    `RCPT-${n}`,                   // $11 receipt_number
    `fp${n}`.padEnd(64, '0'),      // $12 receipt_fingerprint_hash
  ]);
}

async function poolState() {
  const rows = await sql`SELECT voucher_code, status FROM voucher_pool ORDER BY id`;
  return rows.map((r: any) => `${r.voucher_code}:${r.status}`);
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
  if (start.status !== 0) throw new Error(`postgres start failed: ${start.stderr.toString()}`);

  let ready = false;
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(250);
    if (spawnSync('docker', ['exec', CONTAINER_NAME, 'pg_isready', '-U', DB_USER, '-d', DB_NAME]).status === 0) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
    throw new Error('PostgreSQL 16 container timed out waiting for ready state');
  }
  sql = new SQL(PG_URL);
  const v = await sql`SELECT version() AS v`;
  expect((v[0] as any).v).toContain('PostgreSQL 16');
}, 60_000);

afterAll(async () => {
  if (sql) await sql.close();
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
});

describe('PAN-95 allocation selector — SQL text integrity (no DB)', () => {
  test('the template literal sends a real digit class to PostgreSQL (escape safety)', () => {
    // If this ever shows `^d{10}$`, every allocation silently returns zero rows.
    expect(ATOMIC_ALLOCATION_CTE).toContain("voucher_code ~ '^\\d{10}$'");
    expect(ATOMIC_ALLOCATION_CTE).not.toContain("voucher_code ~ '^d{10}$'");
  });

  test('the selector predicate and VOUCHER_CODE_REGEX agree on the whole corpus', () => {
    const match = ATOMIC_ALLOCATION_CTE.match(/voucher_code ~ '([^']+)'/);
    expect(match).not.toBeNull();
    const selectorRegex = new RegExp(match![1]);

    const corpus = [
      '0000000000', '1234567890', '9999999999', '0000012345',
      'CLM-12345678', 'V-CLM-DAILY-1', '123456789', '12345678901', 'dddddddddd', '',
    ];
    for (const code of corpus) {
      expect(`sel:${code}:${selectorRegex.test(code)}`).toBe(`sel:${code}:${VOUCHER_CODE_REGEX.test(code)}`);
    }
  });

  test('the post-allocation invariant guard uses the same shared regex (no drift)', async () => {
    const api = await readFile(REDEMPTIONS_API, 'utf-8');
    expect(api).toContain('VOUCHER_CODE_REGEX.test(String(row.voucher_code');
    expect(api).toContain('VOUCHER_CODE_REGEX');
  });
});

describe('PAN-95 allocation selector — real PostgreSQL behaviour (constraint NOT applied yet)', () => {
  test('[MEDIUM-4] allocator skips non-compliant inventory and delivers a 10-digit code', async () => {
    await resetToBase();
    // Non-compliant rows deliberately get the LOWEST ids → plain FIFO would pop them first.
    await sql`INSERT INTO voucher_pool (voucher_code, status, batch_id) VALUES
      ('CLM-0000001', 'AVAILABLE', 'LEGACY'),
      ('CLM-0000002', 'AVAILABLE', 'LEGACY'),
      ('0000000007', 'AVAILABLE', 'NUMERIC'),
      ('0000000008', 'AVAILABLE', 'NUMERIC')`;

    const result = await allocate('hash_alloc_ok', 'SBA1234A');
    expect(result.length).toBe(1);
    expect(String(result[0].voucher_code)).toBe('0000000007');
    expect(VOUCHER_CODE_REGEX.test(String(result[0].voucher_code))).toBe(true);

    // The bad rows were never popped: still AVAILABLE, no plate bound to them.
    expect(await poolState()).toEqual([
      'CLM-0000001:AVAILABLE',
      'CLM-0000002:AVAILABLE',
      '0000000007:REDEEMED',
      '0000000008:AVAILABLE',
    ]);

    const logs = await sql`SELECT voucher_code, status FROM redemption_logs ORDER BY created_at`;
    expect(logs.map((r: any) => `${r.voucher_code}:${r.status}`)).toEqual(['0000000007:CLAIMED']);
  });

  test('[MEDIUM-4] a pool of only non-compliant codes yields no allocation and burns nothing', async () => {
    await resetToBase();
    await sql`INSERT INTO voucher_pool (voucher_code, status, batch_id) VALUES
      ('CLM-0000003', 'AVAILABLE', 'LEGACY'),
      ('V-CLM-DAILY-9', 'AVAILABLE', 'LEGACY')`;

    // Route maps an empty result to VOUCHER_POOL_EXHAUSTED (503) — a retryable state,
    // versus the pre-fix behaviour of burning a slot and returning VOUCHER_FORMAT_INVALID.
    const result = await allocate('hash_alloc_empty', 'SBB2222B');
    expect(result.length).toBe(0);

    expect(await poolState()).toEqual(['CLM-0000003:AVAILABLE', 'V-CLM-DAILY-9:AVAILABLE']);
    expect(((await sql`SELECT count(*)::int c FROM redemption_logs`)[0] as any).c).toBe(0);
  });

  test('compliant inventory is still allocated in FIFO id order', async () => {
    await resetToBase();
    await sql`INSERT INTO voucher_pool (voucher_code, status, batch_id) VALUES
      ('CLM-0000004', 'AVAILABLE', 'LEGACY'),
      ('0000000011', 'AVAILABLE', 'NUMERIC'),
      ('0000000012', 'AVAILABLE', 'NUMERIC')`;

    const first = await allocate('hash_fifo_1', 'SBC3333C');
    const second = await allocate('hash_fifo_2', 'SBD4444D');
    expect([String(first[0].voucher_code), String(second[0].voucher_code)]).toEqual([
      '0000000011',
      '0000000012',
    ]);
  });

  test('leading-zero codes are allocatable and survive the round trip', async () => {
    await resetToBase();
    await sql`INSERT INTO voucher_pool (voucher_code, status, batch_id) VALUES ('0000012345', 'AVAILABLE', 'NUMERIC')`;

    const result = await allocate('hash_zero', 'SBE5555E');
    expect(String(result[0].voucher_code)).toBe('0000012345');
    const logs = await sql`SELECT voucher_code FROM redemption_logs`;
    expect((logs[0] as any).voucher_code).toBe('0000012345');
  });

  test('the allocation commits immediately — a later throw does NOT roll it back', async () => {
    // Characterises the residual behind the code comment at src/pages/api/v1/redemptions.ts:349
    // ("throw so the outer catch rolls any partial state back cleanly"): the route calls
    // sql.unsafe with no surrounding transaction, so an invariant breach after this point
    // leaves the voucher REDEEMED and the daily slot consumed.
    await resetToBase();
    await sql`INSERT INTO voucher_pool (voucher_code, status, batch_id) VALUES ('0000000009', 'AVAILABLE', 'NUMERIC')`;

    const result = await allocate('hash_throw', 'SBF6666F');
    try {
      // Simulates the invariant branch throwing after allocation.
      throw new Error('INVARIANT_VIOLATED');
    } catch {
      // swallow
    }

    expect(String(result[0].voucher_code)).toBe('0000000009');
    expect(await poolState()).toEqual(['0000000009:REDEEMED']);
    expect(((await sql`SELECT count(*)::int c FROM redemption_logs`)[0] as any).c).toBe(1);
  });
});

describe('PAN-95 allocation selector — with migration 0004 applied', () => {
  test('legacy inventory is expired and compliant inventory remains allocatable', async () => {
    await resetToBase();
    await sql`INSERT INTO voucher_pool (voucher_code, status, batch_id) VALUES
      ('CLM-0000005', 'AVAILABLE', 'LEGACY'),
      ('0000000013', 'AVAILABLE', 'NUMERIC')`;

    await applyMigration('0004_enforce_10digit_numeric_voucher_codes.up.sql');

    expect(await poolState()).toEqual(['CLM-0000005:EXPIRED', '0000000013:AVAILABLE']);

    const result = await allocate('hash_post_mig', 'SBG7777G');
    expect(String(result[0].voucher_code)).toBe('0000000013');
  });

  test('availability pre-check and allocator agree in the post-migration steady state', async () => {
    await resetToBase();
    await sql`INSERT INTO voucher_pool (voucher_code, status, batch_id) VALUES
      ('CLM-0000006', 'AVAILABLE', 'LEGACY'),
      ('0000000016', 'AVAILABLE', 'NUMERIC'),
      ('0000000017', 'AVAILABLE', 'NUMERIC')`;

    await applyMigration('0004_enforce_10digit_numeric_voucher_codes.up.sql');

    const counted = Number(((await sql.unsafe(COUNT_AVAILABLE_VOUCHERS_QUERY))[0] as any).available_count);
    expect(counted).toBe(2); // legacy row expired by step 1

    // Every counted voucher must actually be allocatable — otherwise the pre-check
    // promises inventory the selector cannot deliver.
    const first = await allocate('hash_steady_1', 'SBH8888H');
    const second = await allocate('hash_steady_2', 'SBJ9999J');
    expect([String(first[0].voucher_code), String(second[0].voucher_code)]).toEqual([
      '0000000016',
      '0000000017',
    ]);
    const third = await allocate('hash_steady_3', 'SBK1010K');
    expect(third.length).toBe(0); // pool genuinely drained
  });
});
