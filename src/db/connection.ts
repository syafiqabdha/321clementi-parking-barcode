/**
 * 321 Clementi Parking Barcode - Database Connection
 * Singleton Bun SQL client, reused across API routes.
 */

import { SQL } from 'bun';

let _client: SQL | null = null;

export function getDb(): SQL {
  if (_client) return _client;
  
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  
  _client = new SQL(url);
  return _client;
}