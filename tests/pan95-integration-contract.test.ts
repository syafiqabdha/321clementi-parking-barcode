/**
 * PAN-95 — Quality Gate: cross-layer contracts.
 *
 * The frontend and backend changes for PAN-95 live on separate branches. These tests
 * verify the interfaces BETWEEN them — the seams that per-branch suites cannot see —
 * by reading both shipped sources and comparing them.
 *
 *   API  (src/pages/api/v1/redemptions/history.ts)  → masked voucher_code sentinel
 *   UI   (src/components/RedemptionCard.astro)      → the sentinel it recognises as masked
 */
import { describe, test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const HISTORY_API = join(ROOT, 'src', 'pages', 'api', 'v1', 'redemptions', 'history.ts');
const REDEMPTION_CARD = join(ROOT, 'src', 'components', 'RedemptionCard.astro');

const historySource = await readFile(HISTORY_API, 'utf-8');
const cardSource = await readFile(REDEMPTION_CARD, 'utf-8');

/** Sentinel the API substitutes for unauthorised callers. */
function apiMaskSentinel(src: string): string | null {
  const match = src.match(/\/\/\s*Unauthenticated[\s\S]*?voucher_code:\s*'([^']*)'/);
  return match ? match[1] : null;
}

/** Sentinel the UI treats as "masked → hide barcode actions". */
function uiMaskSentinel(src: string): string | null {
  const match = src.match(/record\.voucher_code\s*===\s*'([^']*)'/);
  return match ? match[1] : null;
}

describe('PAN-95 contract — history masking sentinel', () => {
  test('API still masks voucher_code for unauthenticated callers', () => {
    const sentinel = apiMaskSentinel(historySource);
    expect(sentinel).not.toBeNull();
    expect(sentinel!.length).toBeGreaterThan(0);
  });

  test('mask sentinel carries no legacy CLM- prefix and matches the 10-digit width', () => {
    const sentinel = apiMaskSentinel(historySource)!;
    expect(sentinel.startsWith('CLM-')).toBe(false);
    expect(sentinel).toBe('•'.repeat(10));
  });

  test('[PAN-95 FINDING-3] UI recognises the sentinel the API actually returns', () => {
    const apiSentinel = apiMaskSentinel(historySource);
    const uiSentinel = uiMaskSentinel(cardSource);

    expect(uiSentinel).not.toBeNull();

    const drift = [
      uiSentinel !== apiSentinel
        ? `masked-row UI drift — API masks with "${apiSentinel}" but RedemptionCard.astro isMasked compares against "${uiSentinel}"`
        : null,
      cardSource.includes('CLM-••••••••')
        ? 'stale masked sentinel "CLM-••••••••" still present in RedemptionCard.astro'
        : null,
    ].filter(Boolean);

    expect(drift.length ? drift.join('; ') : null).toBeNull();
  });
});
