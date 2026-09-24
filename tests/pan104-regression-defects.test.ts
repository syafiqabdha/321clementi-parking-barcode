/**
 * 321 Clementi Smart Parking Redemption Engine
 * PAN-104 Quality Gate — defect regression guards
 *
 * These tests encode the contracts PAN-104 must not break. They reproduced four
 * real defects during the first gate run; all four are now fixed on
 * `feature/pan-104-receipt-tracking` and these tests pass. They stay in the suite
 * so the same defects cannot silently return.
 *
 *   D1  src/components/RedemptionCard.astro referenced the undeclared identifier
 *       `currentPlate` — a ReferenceError on the Claim History offline/mock path.
 *       Fixed: the dead comparison was removed.
 *   D2  openEnlargeModal() was narrowed to 1 parameter but a call site still
 *       passed 2 — an `astro check` error invisible to `tsc --noEmit`.
 *       Fixed: call site and data-plate plumbing removed.
 *   D3  The unclaim recovery path changed from vehicle_plate to receipt_number on
 *       the backend while the frontend still sent vehicle_plate, so recovery
 *       authentication could never succeed.
 *       Fixed: the frontend now sends receipt_number.
 *   D4  Claim History was keyed on vehicle_plate, but the redemption form no
 *       longer collects a plate, so no patron could look up or unclaim their own
 *       redemption.
 *       Fixed: ?receipt= lookup + GET_RECEIPT_HISTORY_QUERY. Behavioural proof in
 *       tests/pan104-history-receipt-lookup.test.ts.
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

describe('PAN-104 defect D4 (FIXED): Claim History is reachable by receipt number', () => {
  // Behavioural proof lives in tests/pan104-history-receipt-lookup.test.ts, which
  // drives the real route handler against a real database. These assertions guard
  // the wiring so the receipt path cannot be quietly dropped again.
  test('the history route accepts ?receipt= and no longer mandates a plate', async () => {
    const api = await read(HISTORY_API);

    expect(api).toContain("url.searchParams.get('receipt')");
    expect(api).toContain('GET_RECEIPT_HISTORY_QUERY');
    // Plate is still supported, but only as one of two alternatives
    expect(api).toContain("url.searchParams.get('plate')");
    expect(api).toContain('MISSING_PARAMETER');
    expect(api).not.toContain('MISSING_PLATE');
  });

  test('a receipt-number history query exists and filters on receipt_number', async () => {
    const queries = await read(QUERIES);

    expect(queries).toContain('GET_RECEIPT_HISTORY_QUERY');
    const receiptQuery = queries.slice(
      queries.indexOf('GET_RECEIPT_HISTORY_QUERY'),
      queries.indexOf('GET_RECEIPT_HISTORY_QUERY') + 1400
    );
    expect(receiptQuery).toContain('rl.receipt_number IS NOT NULL');
    expect(receiptQuery).toContain('UPPER(TRIM(rl.receipt_number))');
    // Must not be gated on a plate the flow no longer collects
    expect(receiptQuery).not.toContain('rl.vehicle_plate');
  });

  test('the Claim History UI asks for a receipt number, not a car plate', async () => {
    const modal = await read(join(ROOT, 'src', 'components', 'ClaimHistoryModal.astro'));
    const card = await read(CARD);

    expect(modal.toLowerCase()).not.toContain('car plate');
    expect(modal.toLowerCase()).toContain('receipt');
    // The form must query the receipt-parameterised endpoint
    expect(card).toContain('/api/v1/redemptions/history?receipt=');
    expect(card).not.toContain('history?plate=');
  });
});

describe('PAN-104 defect D5: fabricated voucher could render in production', () => {
  test('the mock fallback is gated behind a development build', async () => {
    const src = await read(CARD);
    const idx = src.indexOf('Math.floor(1000000000');
    expect(idx).toBeGreaterThan(-1);

    // The fallback fabricates a voucher code, a claim token and a receipt number,
    // then falls through to renderBarcodeScreen(). In a production build that
    // renders a barcode for a redemption that never happened — the shopper cannot
    // open the gate with it. It must be preceded by a dev-only guard and an early
    // return, so production shows an honest error instead.
    const preceding = src.slice(Math.max(0, idx - 900), idx);
    expect(preceding).toContain('import.meta.env.DEV');
    expect(preceding).toContain('return;');
  });
});
