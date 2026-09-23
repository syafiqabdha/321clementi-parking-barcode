/**
 * 321 Clementi Parking Barcode - Database Connection
 * Singleton PostgreSQL client, reused across API routes.
 *
 * Runtime portability: this module runs inside Vercel's Node.js function
 * runtime, so it uses the `postgres` npm driver instead of Bun's built-in SQL
 * client (`require('bun')`, which cannot resolve on Node).
 *
 * The returned object deliberately keeps the same call surface the codebase
 * already uses, so no route file changes:
 *   sql.unsafe(text, params)     -> Promise<row[]>
 *   sql`SELECT ... ${value}`     -> Promise<row[]>
 *
 * Connection tuning is env-driven because the deployment target (serverless
 * functions) and the connection endpoint (direct Postgres vs. a transaction
 * pooler) both change what is correct.
 */

import postgres from 'postgres';

let _client: any = null;

/** Transaction-mode poolers (PgBouncer, Supabase :6543, Neon pooled) cannot
 *  keep prepared statements alive between queries. Off by default because it is
 *  the safe setting on both pooled and direct endpoints. */
function shouldPrepare(): boolean {
  return process.env.PG_PREPARE === 'true';
}

/** postgres.js honours `sslmode=` in the connection string, but a managed
 *  Postgres behind a private network/VPN may still need TLS forced on, and a
 *  self-signed cert needs verification relaxed. Both are opt-in. */
function sslOptions(url: string): false | { rejectUnauthorized: boolean } | undefined {
  const fromUrl = /[?&]sslmode=(require|prefer|verify-ca|verify-full|no-verify)/.test(url);
  const forced = process.env.PG_SSL === 'true';
  if (!fromUrl && !forced) return undefined;
  if (/sslmode=(prefer|no-verify)/.test(url) || process.env.PG_SSL_NO_VERIFY === 'true') {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

export function getDb(): any {
  if (_client) return _client;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  _client = postgres(url, {
    // On Vercel every warm function instance holds its own pool, so a pool
    // larger than 1 multiplies concurrent connections against Postgres and
    // exhausts its connection limit under load. Long-lived local/self-hosted
    // processes can afford a real pool.
    max: Number(process.env.PG_POOL_MAX ?? (process.env.VERCEL ? 1 : 10)),
    idle_timeout: Number(process.env.PG_IDLE_TIMEOUT ?? 20),
    connect_timeout: Number(process.env.PG_CONNECT_TIMEOUT ?? 10),
    prepare: shouldPrepare(),
    ssl: sslOptions(url),
  });

  return _client;
}
