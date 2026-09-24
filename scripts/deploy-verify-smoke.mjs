/**
 * Serverless deployment smoke test — PAN-106.
 *
 * Boots the BUILT Vercel function artifact (`.vercel/output/functions/_render.func`)
 * under the real Node.js runtime, against a throwaway PostgreSQL 16 container and
 * a mock receipt verifier, then asserts the behaviours that unit tests and the
 * `config.json` route gate cannot see:
 *
 *  1. CSRF origin check — a same-origin browser POST carrying Vercel's real
 *     `x-forwarded-host`/`x-forwarded-proto` headers must NOT be 403.
 *     Regression guard for the `security.allowedDomains` defect: with an empty
 *     list Astro derives the request origin as `https://localhost` and rejects
 *     every form POST from the real domain with
 *     `403 Cross-site POST form submissions are forbidden`.
 *  2. The `postgres` driver actually talks to Postgres on the Node runtime
 *     (the suite runs under Bun, which is not the Vercel runtime).
 *  3. `POST /api/v1/redemptions` allocates a voucher end to end — the route is
 *     imported by no unit test, and it holds the most complex query.
 *  4. Production fails closed when the Turnstile secret is absent.
 *
 * Requires: docker, bun, node, and a completed `bun run build`.
 * Usage: node scripts/deploy-verify-smoke.mjs   (or `bun run verify:deploy`)
 */
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ENTRY = join(ROOT, '.vercel/output/functions/_render.func/dist/server/entry.mjs');

const PG_PORT = Number(process.env.SMOKE_PG_PORT ?? 55443);
const APP_PORT = Number(process.env.SMOKE_APP_PORT ?? 4405);
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT ?? 4406);
const DB_USER = 'clementi_smoke';
const DB_PASS = 'clementi_smoke_pw';
const DB_NAME = 'clementi_smoke';
const CONTAINER = process.env.SMOKE_CONTAINER ?? 'clementi-smoke-pg16';
const DATABASE_URL = `postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${PG_PORT}/${DB_NAME}`;

const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const SITE_HOST = process.env.SMOKE_SITE_HOST ?? '321clementi-parking-barcode.vercel.app';
const RECEIPT_NUMBER = 'INV-SMOKE-0001';

const sleep = (ms) => spawnSync('sleep', [String(ms / 1000)]);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  }
  return r.stdout ?? '';
}

const dropContainer = () => spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf-8' });
process.on('exit', dropContainer);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { dropContainer(); process.exit(1); });
}

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '[PASS]' : '[FAIL]'} ${label}${cond ? '' : `\n        -> ${detail}`}`);
  if (!cond) failures++;
};

/** Astro's CSRF rejection is a plain-text 403 body, not JSON — never assume. */
async function readBody(res) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

if (!existsSync(ENTRY)) {
  console.error(`[fatal] built function entry not found: ${ENTRY}\n        Run \`bun run build\` first.`);
  process.exit(1);
}
if (spawnSync('docker', ['version'], { encoding: 'utf-8' }).status !== 0) {
  console.error('[fatal] docker is not available; this smoke test needs a throwaway Postgres container.');
  process.exit(1);
}

// --- 1. throwaway database ---------------------------------------------------
dropContainer();
sh('docker', ['run', '-d', '--name', CONTAINER,
  '-e', `POSTGRES_USER=${DB_USER}`,
  '-e', `POSTGRES_PASSWORD=${DB_PASS}`,
  '-e', `POSTGRES_DB=${DB_NAME}`,
  '-p', `${PG_PORT}:5432`,
  'postgres:16-alpine']);
console.log('[ok] postgres 16 container started');

let ready = false;
for (let i = 0; i < 60; i++) {
  if (spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', DB_USER, '-d', DB_NAME]).status === 0) {
    ready = true;
    break;
  }
  sleep(1000);
}
if (!ready) {
  console.error('[fatal] postgres never became ready');
  dropContainer();
  process.exit(1);
}
console.log('[ok] postgres ready');

sh('bun', ['run', 'scripts/migrate.ts', 'up'], { cwd: ROOT, env: { ...process.env, DATABASE_URL } });
console.log('[ok] migrations applied');

const todaySGT = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Singapore' });
sh('docker', ['exec', '-i', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-c', `
  INSERT INTO shops (id, name, slug, category, level, unit, is_active, is_eligible)
  VALUES ('${SHOP_ID}','Smoke Cafe','smoke-cafe','Dine','#01-01','01',TRUE,TRUE);
  INSERT INTO voucher_pool (voucher_code, barcode_format, status)
  VALUES ('1234567890','CODE128','AVAILABLE'),('2234567890','CODE128','AVAILABLE');
`]);
console.log('[ok] seeded 1 shop + 2 vouchers');

// --- 2. mock receipt verifier ------------------------------------------------
let verifierCalls = 0;
const mock = createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    verifierCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      is_receipt: true, is_legible: true, tenant_name: 'Smoke Cafe', total_amount: 52.4,
      receipt_date: todaySGT, receipt_time: '12:30:00', receipt_number: RECEIPT_NUMBER,
      location_verified: true, confidence_score: 0.94, rejection_reason: null,
    }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

// --- 3. the built function, under Node --------------------------------------
process.env.DATABASE_URL = DATABASE_URL;
process.env.N8N_RECEIPT_VERIFIER_URL = `http://127.0.0.1:${MOCK_PORT}/verify`;
process.env.PLATE_HMAC_SECRET = 'b'.repeat(64);
process.env.NODE_ENV = 'development';

const { default: handler } = await import(ENTRY);
const app = createServer((req, res) =>
  Promise.resolve(handler(req, res)).catch((e) => {
    console.error('[app crash]', e);
    res.statusCode = 500;
    res.end('crash');
  }));
await new Promise((r) => app.listen(APP_PORT, r));
console.log('[ok] built Vercel function listening on', APP_PORT);

/** Mimics Vercel's edge: real host in x-forwarded-host, same-origin browser Origin. */
function postRedemption(fields, ip, imageField = 'receiptImage') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append(imageField,
    new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: 'image/jpeg' }),
    'receipt.jpg');
  return fetch(`http://127.0.0.1:${APP_PORT}/api/v1/redemptions`, {
    method: 'POST',
    body: fd,
    headers: {
      host: SITE_HOST,
      origin: `https://${SITE_HOST}`,
      'x-forwarded-proto': 'https',
      'x-forwarded-host': SITE_HOST,
      'x-forwarded-for': ip,
    },
  });
}

// (1)+(3) same-origin form POST from a real deployment host
const happy = await postRedemption({
  shopId: SHOP_ID,
  form_rendered_at: String(Date.now() - 3000), // rendered 3s before submit
}, '203.0.113.10');
const { json: happyBody, text: happyText } = await readBody(happy);
console.log('(1) same-origin form POST ->', happy.status, (happyText || '').slice(0, 240));

check(`CSRF origin check accepts the deployment host (${SITE_HOST})`,
  happy.status !== 403,
  `${happy.status} ${happyText.slice(0, 200)} — security.allowedDomains does not match this hostname`);
check('patched contract produces a 201 redemption', happy.status === 201, `got ${happy.status}`);
check('allocated voucher code is 10-digit numeric',
  /^\d{10}$/.test(String(happyBody?.data?.voucher_code ?? '')), JSON.stringify(happyBody));
check('claim_token returned for the client to store',
  typeof happyBody?.data?.claim_token === 'string' && happyBody.data.claim_token.length > 0,
  JSON.stringify(happyBody));
check('receipt verifier was actually called', verifierCalls >= 1, `calls=${verifierCalls}`);

// (2) the driver reads real rows back on the Node runtime
const shops = await fetch(`http://127.0.0.1:${APP_PORT}/api/v1/shops`, {
  headers: { host: SITE_HOST, 'x-forwarded-proto': 'https', 'x-forwarded-host': SITE_HOST },
});
const shopsBody = (await readBody(shops)).json;
console.log('(2) GET /api/v1/shops ->', shops.status, JSON.stringify(shopsBody).slice(0, 160));
check('postgres driver returns live rows on the Node runtime',
  shops.status === 200 && shopsBody?.success === true && (shopsBody.data?.length ?? 0) >= 1,
  JSON.stringify(shopsBody));

const hist = await fetch(
  `http://127.0.0.1:${APP_PORT}/api/v1/redemptions/history?receipt=${RECEIPT_NUMBER}`,
  { headers: { host: SITE_HOST, 'x-forwarded-proto': 'https', 'x-forwarded-host': SITE_HOST, 'x-forwarded-for': '203.0.113.12' } });
const histBody = (await readBody(hist)).json;
check('redemption is committed and retrievable by receipt number',
  hist.status === 200 && histBody?.data?.length === 1, JSON.stringify(histBody).slice(0, 200));

// (4) production posture: Turnstile fails closed without the secret
process.env.NODE_ENV = 'production';
const prod = await postRedemption({ shopId: SHOP_ID, form_rendered_at: String(Date.now() - 3000) }, '203.0.113.13');
const { json: prodBody, text: prodText } = await readBody(prod);
console.log('(4) production, no Turnstile token ->', prod.status, (prodText || '').slice(0, 160));
check('production fails closed without Turnstile (both keys are mandatory)',
  prod.status === 400 && prodBody?.error === 'BOT_CHALLENGE_FAILED', JSON.stringify(prodBody));
process.env.NODE_ENV = 'development';

app.close();
mock.close();
dropContainer();

console.log(failures === 0
  ? '\nSERVERLESS SMOKE TEST PASSED'
  : `\n${failures} SERVERLESS SMOKE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
