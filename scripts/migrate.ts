#!/usr/bin/env bun
/**
 * 321 Clementi Parking Barcode - Database Migration Runner
 * Usage:
 *   bun run scripts/migrate.ts up
 *   bun run scripts/migrate.ts down
 *   bun run scripts/migrate.ts status
 */

import { SQL } from 'bun';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://TodXm21YM2da2T4p:Gbm9xPgRwYPKBHrXaPrDCTc8QZia53w7@172.21.0.2:5432/clementi_redemption';
const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');

async function getClient() {
  return new SQL(DATABASE_URL);
}

async function ensureMigrationTable(sql: SQL) {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

async function runUp(sql: SQL) {
  await ensureMigrationTable(sql);

  const files = await readdir(MIGRATIONS_DIR);
  const upFiles = files.filter(f => f.endsWith('.up.sql')).sort();

  for (const file of upFiles) {
    const version = file.replace('.up.sql', '');
    const existing = await sql`
      SELECT version FROM schema_migrations WHERE version = ${version}
    `;

    if (existing.length > 0) {
      console.log(`[skip] Migration ${version} already applied.`);
      continue;
    }

    console.log(`[apply] Executing ${file}...`);
    const sqlContent = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');

    // Execute within transaction
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlContent);
      await tx`
        INSERT INTO schema_migrations (version, applied_at)
        VALUES (${version}, NOW())
      `;
    });

    console.log(`[done] Applied migration ${version}`);
  }
}

async function runDown(sql: SQL) {
  await ensureMigrationTable(sql);

  const applied = await sql`
    SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1
  `;

  if (applied.length === 0) {
    console.log('[info] No migrations to roll back.');
    return;
  }

  const latestVersion = applied[0].version;
  const downFile = `${latestVersion}.down.sql`;
  const downPath = join(MIGRATIONS_DIR, downFile);

  console.log(`[rollback] Executing ${downFile}...`);
  const sqlContent = await readFile(downPath, 'utf-8');

  await sql.begin(async (tx) => {
    await tx.unsafe(sqlContent);
    await tx`
      DELETE FROM schema_migrations WHERE version = ${latestVersion}
    `;
  });

  console.log(`[done] Rolled back migration ${latestVersion}`);
}

async function showStatus(sql: SQL) {
  await ensureMigrationTable(sql);

  const files = await readdir(MIGRATIONS_DIR);
  const upFiles = files.filter(f => f.endsWith('.up.sql')).sort();

  const appliedRows = await sql`
    SELECT version, applied_at FROM schema_migrations ORDER BY version ASC
  `;
  const appliedMap = new Map(appliedRows.map((r: any) => [r.version, r.applied_at]));

  console.log('\nMigration Status:');
  console.log('--------------------------------------------------');
  for (const file of upFiles) {
    const version = file.replace('.up.sql', '');
    const appliedAt = appliedMap.get(version);
    const status = appliedAt ? `APPLIED (${appliedAt})` : 'PENDING';
    console.log(` ${version.padEnd(45)} : ${status}`);
  }
  console.log('--------------------------------------------------\n');
}

async function main() {
  const command = process.argv[2] || 'up';
  const sql = await getClient();

  try {
    if (command === 'up') {
      await runUp(sql);
    } else if (command === 'down') {
      await runDown(sql);
    } else if (command === 'status') {
      await showStatus(sql);
    } else {
      console.error(`Unknown command: ${command}. Use "up", "down", or "status".`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[error] Migration failed:`, err);
    process.exit(1);
  } finally {
    await sql.close();
  }
}

main();
