/**
 * 321 Clementi Smart Parking Redemption Engine
 * PAN-104 Quality Gate — defect reproduction tests
 *
 * These tests encode the contracts PAN-104 must not break. They are EXPECTED TO
 * FAIL on the current PAN-104 change set: each failure is a reproducible defect
 * found during the quality gate, not a flaky test. They exist so the defects are
 * fixed deliberately rather than by accident, and so they cannot silently return.
 *
 * Defect summary
 *   D1  src/components/RedemptionCard.astro references the undeclared identifier
 *       `currentPlate` — a ReferenceError on the Claim History offline/mock path.
 *   D2  openEnlargeModal() was narrowed to 1 parameter but a call site still
 *       passes 2 — an `astro check` type error that `tsc --noEmit` cannot see.
 *   D3  The unclaim recovery path changed from vehicle_plate to receipt_number on
 *       the backend, but the frontend still sends vehicle_plate, so recovery
 *       authentication can never succeed.
 *   D4  Claim History is still keyed on vehicle_plate, but the redemption form no
 *       longer collects a plate — redemptions made under PAN-104 cannot be looked
 *       up, resumed, or unclaimed by the patron.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CARD = join(ROOT, 'src', 'components', 'RedemptionCard.astro');
const UNCLAIM_API = join(ROOT, 'src', 'pages', 'api', 'v1', 'redemptions', 'unclaim.ts');
const HISTORY_API = join(ROOT, 'src', 'pages', 'api', 'v1', 'redemptions', 'history.ts');
const QUERIES = join(ROOT, 'src', 'db', 'queries.ts');

const read = (p: string) => readFile(p, 'utf-8');

describe('PAN-104 defect D1: undeclared identifier in RedemptionCard.astro', () => {
  test('`currentPlate` is declared before it is referenced', async () => {
    const src = await read(CARD);
    const references = [...src.matchAll(/\bcurrentPlate\b/g)];
    if (references.length === 0) return; // cleaned up — nothing to assert

    const declared = /(?:let|const|var)\s+currentPlate\b/.test(src);
    expect(declared).toBe(true);
  });

  test('the Claim History fallback path does not throw a ReferenceError', async () => {
    const src = await read(CARD);
    // The catch-block fallback compares against the previously submitted plate.
    // Any comparison must reference a declared binding, otherwise the browser
    // raises "ReferenceError: currentPlate is not defined" instead of rendering.
    const fallbackUses = /plate\s*===\s*currentPlate/.test(src);
    if (!fallbackUses) return;
    expect(/(?:let|const|var)\s+currentPlate\b/.test(src)).toBe(true);
  });
});

describe('PAN-104 defect D2: openEnlargeModal arity mismatch', () => {
  test('every openEnlargeModal() call passes exactly the number of declared parameters', async () => {
    const src = await read(CARD);

    const decl = src.match(/function\s+openEnlargeModal\s*\(([^)]*)\)/);
    expect(decl).not.toBeNull();
    const params = decl![1].trim() === '' ? 0 : decl![1].split(',').length;

    const callSites = [...src.matchAll(/(^|[^a-zA-Z0-9_])openEnlargeModal\s*\(([^)]*)\)/g)]
      .filter((m) => !/\bfunction\s+$/.test(m[1]))
      .map((m) => ({
        line: src.slice(0, m.index).split('\n').length,
        argCount: m[2].trim() === '' ? 0 : m[2].split(',').length,
      }));

    const mismatched = callSites.filter((c) => c.argCount !== params);
    expect({ declaredParams: params, mismatched }).toEqual({ declaredParams: 1, mismatched: [] });
  });
});

describe('PAN-104 defect D3: unclaim recovery field contract mismatch', () => {
  test('the frontend sends every recovery field the unclaim API reads from the body', async () => {
    const api = await read(UNCLAIM_API);
    const card = await read(CARD);

    // Fields the API pulls off the JSON body for the recovery (fallback) path.
    const apiFields = new Set(
      [...api.matchAll(/\bbody\.([a-z_]+)\b/g)].map((m) => m[1])
    );
    expect(apiFields.has('receipt_number')).toBe(true);
    expect(apiFields.has('vehicle_plate')).toBe(false);

    // Fields the frontend actually posts for an unclaim: object-literal keys plus
    // conditional `body.X = ...` assignments.
    const bodyBlock = card.slice(
      card.indexOf('async function executeUnclaim'),
      card.indexOf("const response = await fetch('/api/v1/redemptions/unclaim'")
    );
    const sentKeys = new Set([
      ...[...bodyBlock.matchAll(/^\s*([a-z_]+):\s/gm)].map((m) => m[1]),
      ...[...bodyBlock.matchAll(/\bbody\.([a-z_]+)\s*=/g)].map((m) => m[1]),
    ]);

    const missing = [...apiFields].filter((f) => f !== 'id' && !sentKeys.has(f));
    // Compact, readable failure: only the missing fields are printed.
    expect(missing).toEqual([]);
  });
});

describe('PAN-104 defect D4: Claim History is unreachable for plate-less redemptions', () => {
  test('history lookup can be performed with a receipt number, not only a vehicle plate', async () => {
    const api = await read(HISTORY_API);
    const queries = await read(QUERIES);

    // The API hard-requires a plate query parameter...
    expect(api).toContain("url.searchParams.get('plate')");
    expect(api).toContain('MISSING_PLATE');

    // ...and the only history query filters on vehicle_plate.
    const historyQuery = queries.slice(
      queries.indexOf('GET_PLATE_HISTORY_QUERY'),
      queries.indexOf('GET_PLATE_HISTORY_QUERY') + 900
    );
    expect(historyQuery).toContain('rl.vehicle_plate');

    // A receipt-number lookup path must exist, because PAN-104 stops collecting
    // plates at redemption time (vehicle_plate is NULL for every new claim).
    const hasReceiptLookup =
      /searchParams\.get\('receipt/.test(api) ||
      /GET_RECEIPT_HISTORY_QUERY/.test(queries) ||
      /receipt_number\s*=\s*\$\d/.test(queries);

    expect({ hasReceiptLookup }).toEqual({ hasReceiptLookup: true });
  });
});
