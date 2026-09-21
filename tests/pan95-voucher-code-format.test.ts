/**
 * PAN-95 — Quality Gate: voucher code format contract.
 *
 * "10 digits of numbers only (no alphabet)" must hold at every layer that can
 * produce or accept a code:
 *   1. DB CHECK constraint (migration 0004)
 *   2. API validation (VOUCHER_CODE_REGEX — the declared single source of truth)
 *   3. client mock/preview fallback generator (RedemptionCard.astro)
 *
 * The DB and API regexes are compared by BEHAVIOUR over one shared corpus, so the
 * "single source of truth" claim is verified rather than assumed.
 */
import { describe, test, expect } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { VOUCHER_CODE_REGEX } from '../src/db/queries';

const ROOT = join(import.meta.dir, '..');
const REDEMPTION_CARD = join(ROOT, 'src', 'components', 'RedemptionCard.astro');
const M0004 = join(ROOT, 'migrations', '0004_enforce_10digit_numeric_voucher_codes.up.sql');

/** Corpus: every string either layer must agree on. true = valid 10-digit numeric code. */
const CORPUS: Array<[string, boolean]> = [
  ['0000000000', true],
  ['0000000001', true],
  ['0000012345', true],
  ['1234567890', true],
  ['9999999999', true],
  ['CLM-12345678', false],
  ['CLM-98765432', false],
  ['V-CLM-DAILY-1', false],
  ['123456789', false],
  ['12345678901', false],
  ['12345abcde', false],
  ['123456789a', false],
  ['-123456789', false],
  ['+1234567890', false],
  [' 1234567890', false],
  ['1234567890 ', false],
  ['12345 6789', false],
  ['1234567890.0', false],
  ['１２３４５６７８９０', false], // full-width digits
  ['••••••••••', false],          // history mask sentinel
  ['', false],
];

describe('PAN-95 voucher code format — API layer (single source of truth)', () => {
  test('VOUCHER_CODE_REGEX accepts every 10-digit numeric code', () => {
    for (const [code, valid] of CORPUS.filter(([, v]) => v)) {
      expect(`${code}:${VOUCHER_CODE_REGEX.test(code)}`).toBe(`${code}:true`);
    }
  });

  test('VOUCHER_CODE_REGEX rejects everything else', () => {
    for (const [code, valid] of CORPUS.filter(([, v]) => !v)) {
      expect(`${code}:${VOUCHER_CODE_REGEX.test(code)}`).toBe(`${code}:false`);
    }
  });

  test('VOUCHER_CODE_REGEX is anchored (no substring match)', () => {
    const re = new RegExp(VOUCHER_CODE_REGEX.source.replace(/^\^|\$$/g, ''));
    expect(re.test('1234567890')).toBe(true); // control: unanchored pattern would match
    expect(VOUCHER_CODE_REGEX.source.startsWith('^')).toBe(true);
    expect(VOUCHER_CODE_REGEX.source.endsWith('$')).toBe(true);
  });
});

describe('PAN-95 voucher code format — DB layer (migration 0004)', () => {
  test('migration 0004 declares a CHECK constraint on voucher_code', async () => {
    const upSql = await readFile(M0004, 'utf-8');
    expect(upSql).toContain('ADD CONSTRAINT ck_voucher_pool_voucher_code_numeric_10');
    expect(upSql).toContain('CHECK (voucher_code ~');
  });

  test('DB constraint pattern and VOUCHER_CODE_REGEX agree over the whole corpus', async () => {
    const upSql = await readFile(M0004, 'utf-8');
    const match = upSql.match(/CHECK \(voucher_code ~ '([^']+)'\)/);
    expect(match).not.toBeNull();

    // The migration literal is read from disk, so '\d' stays a literal backslash-d,
    // which is exactly what PostgreSQL's ARE engine expects.
    const dbRegex = new RegExp(match![1]);
    for (const [code, valid] of CORPUS) {
      const dbVerdict = dbRegex.test(code);
      expect(`db:${code}:${dbVerdict}`).toBe(`db:${code}:${VOUCHER_CODE_REGEX.test(code)}`);
      expect(`corpus:${code}:${dbVerdict}`).toBe(`corpus:${code}:${valid}`);
    }
  });

  test('migration 0004 purges non-compliant AVAILABLE inventory before constraining', async () => {
    const upSql = await readFile(M0004, 'utf-8');
    const purgeIndex = upSql.indexOf("SET    status     = 'EXPIRED'");
    const constraintIndex = upSql.indexOf('ADD CONSTRAINT');
    expect(purgeIndex).toBeGreaterThan(-1);
    expect(constraintIndex).toBeGreaterThan(purgeIndex);
    expect(upSql).toContain("status     = 'AVAILABLE'");
  });
});

describe('PAN-95 voucher code format — client generation', () => {
  test('RedemptionCard mock/preview fallback only ever emits 10-digit numeric codes', async () => {
    const source = await readFile(REDEMPTION_CARD, 'utf-8');
    const capture = source.match(/voucherCode = (String\(Math\.floor\(.+?\)\));/);
    expect(capture).not.toBeNull();

    const generate = new Function(`return ${capture![1]}`) as () => string;
    for (let i = 0; i < 5000; i++) {
      const code = generate();
      if (!VOUCHER_CODE_REGEX.test(code)) {
        throw new Error(`non-compliant mock voucher code generated: "${code}"`);
      }
    }
    // Boundary sanity: the generator's numeric range must stay inside 10 digits.
    const min = new Function(`return ${capture![1].replace('Math.random()', '0')}`)() as string;
    const max = new Function(`return ${capture![1].replace('Math.random()', '0.999999999999')}`)() as string;
    expect(min).toBe('1000000000');
    expect(Number(max)).toBeLessThan(10000000000);
    expect(max.length).toBe(10);
  });

  test('no client/production code still generates the legacy CLM- prefix', async () => {
    const offenders: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', '.git', '.astro'].includes(entry.name)) continue;
          await walk(full);
          continue;
        }
        if (!/\.(ts|astro|js|mts|cts)$/.test(entry.name)) continue;
        const text = await readFile(full, 'utf-8');
        // A template/expression that BUILDS a code — static display placeholders are out of scope.
        if (/`CLM-\$\{/.test(text) || /'CLM-'\s*\+/.test(text)) offenders.push(full.replace(ROOT + '/', ''));
      }
    };
    await walk(join(ROOT, 'src'));
    await walk(join(ROOT, 'scripts'));
    expect(offenders).toEqual([]);
  });
});
