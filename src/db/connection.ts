/**
 * 321 Clementi Parking Barcode - Database Connection
 * Singleton Bun SQL client, reused across API routes.
 * Uses dynamic import to avoid static build bundling issues.
 */

let _client: any = null;

export function getDb(): any {
  if (_client) return _client;
  
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  
  // Dynamic import of Bun's SQL — only resolves at runtime
  const { SQL } = require('bun');
  _client = new SQL(url);
  return _client;
}