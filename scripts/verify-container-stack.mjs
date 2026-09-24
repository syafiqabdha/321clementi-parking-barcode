#!/usr/bin/env node
/**
 * Container stack verification — PAN-109.
 *
 * Boots the REAL docker compose stack (PostgreSQL 16 + the production image
 * built from ./Dockerfile), applies migrations 0001-0005 from inside the web
 * container, asserts the resulting schema, then drives a complete
 * receipt -> voucher -> barcode redemption through the running container.
 *
 * Why this exists: `bun test` covers the domain logic against an in-process
 * database, and the unit suite cannot see the things that actually break a
 * Coolify deploy — a stale prerendered API route, a build that never installed
 * an SSR adapter, a migration the runtime image cannot run, or an image that
 * boots but cannot reach Postgres.
 *
 * Usage:
 *   bun scripts/verify-container-stack.mjs            # build + verify + clean up
 *   VERIFY_KEEP=1 bun scripts/verify-container-stack.mjs   # leave the stack up
 *
 * Safety: this script runs under its own compose project
 * (`321clementi-parking-verify`; override with VERIFY_PROJECT). Its `down -v`
 * teardown removes only that project's volumes, so it can run on a host that
 * already has the production stack up without touching the live database. It
 * refuses to start if VERIFY_PROJECT names the production project.
 *
 * Requirements: docker, bun. Nothing else — no .env, no running database.
 */
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const WEB_PORT = Number(process.env.VERIFY_WEB_PORT ?? 14321);
const MOCK_PORT = Number(process.env.VERIFY_MOCK_PORT ?? 4406);
const IMAGE_TAG = process.env.VERIFY_IMAGE_TAG ?? 'pan109-verify';
const KEEP = process.env.VERIFY_KEEP === '1';

const DB_USER = 'clementi';
const DB_PASS = 'clementi_verify_pw';
const DB_NAME = 'clementi_redemption';
const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const RECEIPT_NUMBER = 'INV-PAN109-0001';
const SITE_HOST = '321clementi.pancatz.com';

const TMP = mkdtempSync(join(tmpdir(), 'pan109-verify-'));
const ENV_FILE = join(TMP, 'verify.env');

// Fixed, non-secret values — this stack is throwaway and must never talk to a
// real database. Secrets are obviously fake so they cannot be mistaken for real
// ones if this file ever leaks into a log.
writeFileSync(ENV_FILE, [
  `POSTGRES_USER=${DB_USER}`,
  `POSTGRES_PASSWORD=${DB_PASS}`,
  `POSTGRES_DB=${DB_NAME}`,
  `PLATE_HMAC_SECRET=${'a'.repeat(64)}`,
  `ADMIN_API_KEY=${'b'.repeat(64)}`,
  `NC_AUTH_JWT_SECRET=${'c'.repeat(64)}`,
  `ALLOWED_SITE_DOMAINS=${SITE_HOST}`,
  `NOCODB_URL=https://nocodb.pancatz.com`,
  `WEB_HOST_PORT=${WEB_PORT}`,
  `IMAGE_TAG=${IMAGE_TAG}`,
  '',
].join('\n'));

// Verification runs under its OWN compose project. The deployable file sets
// `name: 321clementi-parking`, and this script tears the stack down with
// `down -v` — so without a separate project it would operate on the production
// stack and DELETE the live `pgdata` / `nocodb-data` volumes. NEVER drop the
// `-p` below, and never point VERIFY_PROJECT at the deployed project.
const PRODUCTION_PROJECT = '321clementi-parking';
const PROJECT = process.env.VERIFY_PROJECT ?? `${PRODUCTION_PROJECT}-verify`;
if (PROJECT === PRODUCTION_PROJECT) {
  console.error(
    `[fatal] VERIFY_PROJECT=${PROJECT} is the production compose project. This script's ` +
      `teardown runs \`down -v\` and would delete the live database volume. Refusing to run.`
  );
  process.exit(1);
}

const COMPOSE = [
  'compose',
  '-p', PROJECT,
  '--env-file', ENV_FILE,
  '-f', join(ROOT, 'docker-compose.yml'),
  '-f', join(ROOT, 'docker-compose.verify.yml'),
];
const DATABASE_URL = `postgresql://${DB_USER}:${DB_PASS}@db:5432/${DB_NAME}`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${r.status}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`
    );
  }
  return (r.stdout ?? '').trim();
}

const compose = (...args) => sh('docker', [...COMPOSE, ...args]);
const composeSoft = (...args) =>
  spawnSync('docker', [...COMPOSE, ...args], { encoding: 'utf-8' });

const sleep = (ms) => spawnSync('sleep', [String(ms / 1000)]);

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}${cond ? '' : `\n        -> ${detail}`}`);
  if (!cond) failures++;
}

function cleanup() {
  if (KEEP) {
    console.log(`\n[keep] stack left running (VERIFY_KEEP=1) — stop with:\n` +
      `  docker compose -p ${PROJECT} --env-file ${ENV_FILE} -f docker-compose.yml -f docker-compose.verify.yml down -v`);
    return;
  }
  composeSoft('down', '-v', '--remove-orphans');
  rmSync(TMP, { recursive: true, force: true });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup(); process.exit(1); });
}

// ---------------------------------------------------------------------------
// 0. Preconditions
// ---------------------------------------------------------------------------
sh('docker', ['version']);
const hasBuildx = spawnSync('docker', ['buildx', 'version'], { encoding: 'utf-8' }).status === 0;
console.log(`[info] docker present, buildx ${hasBuildx ? 'available' : 'MISSING (classic builder)'}`);

// ---------------------------------------------------------------------------
// 1. Build the production image
// ---------------------------------------------------------------------------
console.log('\n=== 1. Build image ===');
composeSoft('down', '-v', '--remove-orphans');
const buildEnv = hasBuildx ? process.env : { ...process.env, DOCKER_BUILDKIT: '0' };
const build = spawnSync('docker', [
  'build',
  '--build-arg', `ALLOWED_SITE_DOMAINS=${SITE_HOST}`,
  '-t', `321clementi-parking-web:${IMAGE_TAG}`,
  ROOT,
], { encoding: 'utf-8', env: buildEnv });
if (build.status !== 0) {
  console.error(build.stdout?.slice(-4000) ?? '');
  console.error(build.stderr?.slice(-4000) ?? '');
  throw new Error('docker build failed');
}
const imageId = sh('docker', ['image', 'inspect', '321clementi-parking-web:' + IMAGE_TAG, '--format', '{{.Id}}']);
console.log(`[ok] built 321clementi-parking-web:${IMAGE_TAG} (${imageId.slice(0, 19)})`);

const sizeRaw = sh('docker', ['image', 'inspect', '321clementi-parking-web:' + IMAGE_TAG, '--format', '{{.Size}}']);
console.log(`[info] image size ${(Number(sizeRaw) / 1024 / 1024).toFixed(1)} MiB`);

// ---------------------------------------------------------------------------
// 2. Bring up PostgreSQL 16 and wait for health
// ---------------------------------------------------------------------------
console.log('\n=== 2. Start PostgreSQL 16 ===');
compose('up', '-d', 'db');
// Readiness must be an *authenticated query*, not `pg_isready`. During first
// boot the postgres entrypoint runs initdb against a temporary server that also
// answers pg_isready on the unix socket; it is then shut down and the real
// server started. A pg_isready-based probe passes against that temporary server
// and the next psql lands in the restart window with "No such file or directory".
// Requiring a real query (and taking the version from it) has no such window.
let pgVersion = '';
for (let i = 0; i < 60; i++) {
  const r = composeSoft('exec', '-T', 'db', 'psql', '-U', DB_USER, '-d', DB_NAME, '-tAc', 'SHOW server_version;');
  if (r.status === 0 && /^16\./.test((r.stdout ?? '').trim())) {
    pgVersion = (r.stdout ?? '').trim();
    break;
  }
  sleep(1000);
}
check('PostgreSQL 16 is accepting authenticated queries', pgVersion !== '');
if (!pgVersion) { cleanup(); process.exit(1); }
check('server is PostgreSQL 16.x', /^16\./.test(pgVersion), pgVersion);
console.log(`[info] server_version ${pgVersion}`);

// ---------------------------------------------------------------------------
// 3. Migrations, executed from inside the runtime image
// ---------------------------------------------------------------------------
console.log('\n=== 3. Apply migrations 0001-0005 from the web image ===');
const migrateOut = compose('run', '--rm', '-T', 'web', 'bun', 'run', 'db:migrate');
process.stdout.write(migrateOut.split('\n').map((l) => `      ${l}`).join('\n') + '\n');
check('migration runner applied 0001 through 0005',
  ['0001', '0002', '0003', '0004', '0005'].every((v) => migrateOut.includes(`Applied migration ${v}_`)),
  migrateOut);

const rerun = compose('run', '--rm', '-T', 'web', 'bun', 'run', 'db:migrate');
check('migration runner is idempotent (second run skips all five)',
  (rerun.match(/\[skip\]/g) ?? []).length === 5,
  rerun);

const statusOut = compose('run', '--rm', '-T', 'web', 'bun', 'run', 'db:status');
check('db:status reports 5 APPLIED, 0 PENDING',
  (statusOut.match(/APPLIED/g) ?? []).length === 5 && !statusOut.includes('PENDING'),
  statusOut);

// ---------------------------------------------------------------------------
// 4. Schema assertions (what migrations 0004/0005 actually installed)
// ---------------------------------------------------------------------------
console.log('\n=== 4. Schema assertions ===');
const psql = (...args) => compose('exec', '-T', 'db', 'psql', '-U', DB_USER, '-d', DB_NAME, '-tAc', args.join(' '));

const tables = psql("SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';");
check('core tables present: redemption_audit_logs, redemption_logs, schema_migrations, shops, voucher_pool',
  ['redemption_audit_logs', 'redemption_logs', 'schema_migrations', 'shops', 'voucher_pool']
    .every((t) => tables.split(',').includes(t)),
  tables);

const nullable = psql("SELECT is_nullable FROM information_schema.columns WHERE table_name='redemption_logs' AND column_name='vehicle_plate_hash';");
check('0005 applied: redemption_logs.vehicle_plate_hash is nullable (plate-less redemption)', nullable === 'YES', nullable);

const oldIndex = psql("SELECT count(*) FROM pg_indexes WHERE indexname='uq_redemption_vehicle_daily';");
check('0005 applied: legacy uq_redemption_vehicle_daily dropped', oldIndex === '0', oldIndex);

const dedupIdx = psql("SELECT count(*) FROM pg_indexes WHERE indexname IN ('uq_redemption_receipt_hash_daily','uq_redemption_receipt_fingerprint_daily');");
check('0003 applied: both receipt deduplication indexes exist', dedupIdx === '2', dedupIdx);

const numericCheck = psql("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='ck_voucher_pool_voucher_code_numeric_10';");
check('0004 applied: 10-digit numeric CHECK constraint on voucher_pool',
  numericCheck.includes('^\\d{10}$') || numericCheck.includes('\\d{10}'), numericCheck);

// ---------------------------------------------------------------------------
// 5. Seed a shop and a small voucher pool
// ---------------------------------------------------------------------------
console.log('\n=== 5. Seed fixture data ===');
compose('exec', '-T', 'db', 'psql', '-U', DB_USER, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-c', `
  INSERT INTO shops (id, name, slug, category, level, unit, is_active, is_eligible)
  VALUES ('${SHOP_ID}', 'Verify Cafe', 'verify-cafe', 'Dine', '#01-01', '01', TRUE, TRUE);
  INSERT INTO voucher_pool (voucher_code, barcode_format, status)
  VALUES ('0991323001', 'CODE128', 'AVAILABLE'), ('0991323002', 'CODE128', 'AVAILABLE');
`);
const seeded = psql("SELECT count(*) FROM voucher_pool WHERE status='AVAILABLE';");
check('2 AVAILABLE vouchers seeded (10-digit numeric, constraint-compliant)', seeded === '2', seeded);

// ---------------------------------------------------------------------------
// 6. Mock receipt verifier + app container
// ---------------------------------------------------------------------------
console.log('\n=== 6. Start app container ===');
const todaySGT = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
let verifierCalls = 0;
const mock = createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    verifierCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      is_receipt: true, is_legible: true, tenant_name: 'Verify Cafe', total_amount: 52.4,
      receipt_date: todaySGT, receipt_time: '12:30:00', receipt_number: RECEIPT_NUMBER,
      location_verified: true, confidence_score: 0.94, rejection_reason: null,
    }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, '0.0.0.0', r));
console.log(`[ok] mock receipt verifier on :${MOCK_PORT}`);

compose('up', '-d', 'web');

let healthy = false;
let webState = '';
for (let i = 0; i < 60; i++) {
  const r = composeSoft('ps', '--format', 'json', 'web');
  if (r.status === 0) {
    const raw = (r.stdout ?? '').trim();
    // `compose ps --format json` emits a JSON array on v2.2x+ and one JSON
    // object per line on older releases — accept both.
    let svc = null;
    try {
      const parsed = JSON.parse(raw);
      svc = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      const line = raw.split('\n').filter(Boolean).pop();
      if (line) { try { svc = JSON.parse(line); } catch { svc = null; } }
    }
    if (svc) {
      webState = svc.Health || svc.State || '';
      if (webState === 'healthy') { healthy = true; break; }
    }
  }
  sleep(1000);
}
check('web container reaches docker healthcheck = healthy', healthy,
  `last observed state: ${webState || 'unknown'}`);

const base = `http://127.0.0.1:${WEB_PORT}`;
const reqHeaders = {
  host: SITE_HOST,
  origin: `https://${SITE_HOST}`,
  'x-forwarded-proto': 'https',
  'x-forwarded-host': SITE_HOST,
};

function postRedemption(ip, { receiptNumber, bytes }) {
  const fd = new FormData();
  fd.append('shopId', SHOP_ID);
  fd.append('form_rendered_at', String(Date.now() - 3000));
  fd.append('receiptImage',
    new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'receipt.jpg');
  return fetch(`${base}/api/v1/redemptions`, {
    method: 'POST', body: fd,
    headers: { ...reqHeaders, 'x-forwarded-for': ip },
  });
}

const readBody = async (res) => {
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
};

// --- 7. End-to-end redemption ----------------------------------------------
console.log('\n=== 7. Receipt -> voucher -> barcode ===');
const page = await fetch(`${base}/`, { headers: reqHeaders });
const pageText = await page.text();
check('SSR landing page renders (container is serving the app, not a static 404)',
  page.status === 200 && pageText.includes('321 Clementi'), `${page.status} len=${pageText.length}`);

const happy = await postRedemption('203.0.113.10', { receiptNumber: RECEIPT_NUMBER, bytes: [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4] });
const { json: happyBody, text: happyText } = await readBody(happy);
check('POST /api/v1/redemptions allocates a voucher (201) — API route is NOT prerendered',
  happy.status === 201, `${happy.status} ${happyText.slice(0, 300)}`);
check('allocated voucher_code is strictly 10-digit numeric',
  /^\d{10}$/.test(String(happyBody?.data?.voucher_code ?? '')), JSON.stringify(happyBody));
check('claim_token returned for the shopper to store',
  typeof happyBody?.data?.claim_token === 'string' && happyBody.data.claim_token.length > 0,
  JSON.stringify(happyBody));
check('receipt verifier was actually invoked by the container',
  verifierCalls >= 1, `calls=${verifierCalls}`);
if (happyBody?.data?.voucher_code) console.log(`[info] voucher_code ${happyBody.data.voucher_code}`);

const shops = await fetch(`${base}/api/v1/shops`, { headers: reqHeaders });
const shopsBody = JSON.parse((await readBody(shops)).text || '{}');
check('GET /api/v1/shops reads live rows from PostgreSQL 16',
  shops.status === 200 && shopsBody?.success === true && (shopsBody.data?.length ?? 0) >= 1,
  JSON.stringify(shopsBody).slice(0, 240));

const hist = await fetch(`${base}/api/v1/redemptions/history?receipt=${RECEIPT_NUMBER}`,
  { headers: { ...reqHeaders, 'x-forwarded-for': '203.0.113.11' } });
const histBody = JSON.parse((await readBody(hist)).text || '{}');
check('redemption committed and retrievable by receipt number',
  hist.status === 200 && (histBody?.data?.length ?? 0) === 1,
  `${hist.status} ${JSON.stringify(histBody).slice(0, 240)}`);

const voucherState = psql(`SELECT status FROM voucher_pool WHERE voucher_code='${happyBody?.data?.voucher_code ?? 'x'}';`);
check('voucher flipped AVAILABLE -> REDEEMED in the pool',
  voucherState === 'REDEEMED', voucherState);

const dupe = await postRedemption('203.0.113.12', { receiptNumber: RECEIPT_NUMBER, bytes: [0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9] });
const dupeBody = JSON.parse((await readBody(dupe)).text || '{}');
check('re-presenting the same receipt number is rejected (409 DUPLICATE_RECEIPT)',
  dupe.status === 409 && dupeBody?.error === 'DUPLICATE_RECEIPT',
  `${dupe.status} ${JSON.stringify(dupeBody)}`);

const remaining = psql("SELECT count(*) FROM voucher_pool WHERE status='AVAILABLE';");
check('exactly one voucher consumed by the successful redemption', remaining === '1', remaining);

const todaySGT_db = psql('SELECT CURRENT_DATE::text;');
console.log(`[info] db CURRENT_DATE ${todaySGT_db} / SGT date used by verifier ${todaySGT}`);

// --- 8. Result --------------------------------------------------------------
mock.close();
cleanup();

console.log(failures === 0
  ? '\nCONTAINER STACK VERIFICATION PASSED'
  : `\n${failures} CONTAINER STACK CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
