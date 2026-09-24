/**
 * 321 Clementi Smart Parking Redemption Engine
 * PAN-104 Quality Gate — Criteria 3 & 4: single-receipt copy + address removal / copyright footer
 *
 * Criterion 3: every mention of 2 receipts / combining receipts is replaced by
 *              "Must be single receipt. Not combined."
 * Criterion 4: the premises-address block is removed from every frontend view and
 *              a single-line, small, centred copyright footer is present at the end
 *              of the page, clearing the fixed bottom navigation.
 *
 * Assertions run against BOTH the Astro source and the built static output so a
 * source-only change that never reaches dist/ is still caught.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

/**
 * The client build lands in `dist/client/` once an SSR adapter is configured
 * (@astrojs/node or @astrojs/vercel), and directly in `dist/` for a plain static
 * build. Resolve at runtime so this suite passes under either layout — the
 * deployment target is a build concern, not a frontend contract.
 */
function resolveDistDir(): string {
  const nested = join(ROOT, 'dist', 'client');
  return existsSync(join(nested, 'index.html')) ? nested : join(ROOT, 'dist');
}

const DIST_INDEX = join(resolveDistDir(), 'index.html');
const DIST_ASTRO = join(resolveDistDir(), '_astro');

const CURRENT_YEAR = new Date().getFullYear();

/** Every .astro / .ts file under src/ — the full frontend surface. */
async function frontendSources(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (/\.(astro|ts)$/.test(entry.name)) out.push(p);
    }
  }
  await walk(SRC);
  return out;
}

/** Files whose rendered output is a frontend view (excludes the API routes). */
async function viewSources(): Promise<string[]> {
  return (await frontendSources()).filter((p) => !p.includes(`${join('src', 'pages', 'api')}`));
}

let distHtml = '';

beforeAll(async () => {
  if (!existsSync(DIST_INDEX)) {
    const res = spawnSync('bun', ['run', 'build'], { cwd: ROOT, encoding: 'utf-8' });
    if (res.status !== 0) {
      throw new Error(`bun run build failed:\n${res.stdout}\n${res.stderr}`);
    }
  }
  distHtml = await readFile(DIST_INDEX, 'utf-8');
}, 180_000);

// ============================================================================
// Criterion 4 — premises address removal
// ============================================================================
describe('PAN-104 Criterion 4: premises address removed from every frontend view', () => {
  const REMOVED_ADDRESS_STRINGS = [
    '321 Clementi Ave 3',
    'Carpark Entry via Clementi Ave 3',
    'Singapore 129905',
  ];

  test('no frontend view source still renders the premises address block', async () => {
    const offenders: string[] = [];
    for (const file of await viewSources()) {
      const text = await readFile(file, 'utf-8');
      for (const needle of REMOVED_ADDRESS_STRINGS) {
        if (text.includes(needle)) offenders.push(`${file.replace(ROOT + '/', '')} :: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the built static output contains none of the removed address strings', () => {
    for (const needle of REMOVED_ADDRESS_STRINGS) {
      expect(distHtml).not.toContain(needle);
    }
  });

  test('the address block markup (bold "321 Clementi" heading + postcode line) is gone from the footer', async () => {
    const footer = await readFile(join(SRC, 'components', 'Footer.astro'), 'utf-8');
    expect(footer).not.toContain('Premises Address');
    expect(footer).not.toContain('Carpark Entry');
    expect(footer).not.toContain('129905');
  });
});

// ============================================================================
// Criterion 4 — copyright footer
// ============================================================================
describe('PAN-104 Criterion 4: copyright footer', () => {
  test('Footer.astro renders the exact required copyright wording', async () => {
    const footer = await readFile(join(SRC, 'components', 'Footer.astro'), 'utf-8');
    expect(footer).toContain('&copy; {new Date().getFullYear()} Eng Wah Global Pte Ltd. All Rights Reserved.');
    // The old entity name must be gone
    expect(footer).not.toContain('Engwah Private Limited');
  });

  test('the built output renders the copyright with the current year', () => {
    expect(distHtml).toContain(`&copy; ${CURRENT_YEAR} Eng Wah Global Pte Ltd. All Rights Reserved.`);
  });

  test('the copyright is a single <p> line, small (10px) and centred', () => {
    const match = distHtml.match(/<p class="([^"]*)">\s*&copy; [^<]*Eng Wah Global Pte Ltd[^<]*<\/p>/);
    expect(match).not.toBeNull();
    const cls = match![1];
    expect(cls).toContain('text-center');
    expect(cls).toContain('text-[10px]');
    expect(cls).toContain('leading-none');
    // Exactly one copyright line in the whole document
    expect(distHtml.match(/Eng Wah Global Pte Ltd\. All Rights Reserved\./g)?.length).toBe(1);
  });

  test('the footer clears the fixed bottom navigation (>= 64px nav height)', async () => {
    const footer = await readFile(join(SRC, 'components', 'Footer.astro'), 'utf-8');
    // BottomNav inner container is h-16 (64px); the footer must pad at least that much.
    const nav = await readFile(join(SRC, 'components', 'BottomNav.astro'), 'utf-8');
    expect(nav).toContain('fixed bottom-0');
    expect(nav).toContain('h-16');
    expect(footer).toContain('pb-20'); // 80px > 64px
    expect(distHtml).toContain('pb-20');
  });

  test('the footer is the last in-flow block on the page (rendered after the T&C card)', async () => {
    const footer = await readFile(join(SRC, 'components', 'Footer.astro'), 'utf-8');
    const termsIdx = footer.indexOf('terms-list');
    const copyrightIdx = footer.indexOf('Eng Wah Global Pte Ltd');
    expect(termsIdx).toBeGreaterThan(-1);
    expect(copyrightIdx).toBeGreaterThan(termsIdx);
  });
});

// ============================================================================
// Criterion 3 — single-receipt copy
// ============================================================================
describe('PAN-104 Criterion 3: single-receipt (not combined) copy', () => {
  test('no frontend source still advertises 2 receipts or combining receipts', async () => {
    const banned = [
      /Max\s*2\s*Receipts/i,
      /Combine up to 2/i,
      /maximum of two \(2\) same-day receipts/i,
      /combine.{0,20}receipts?/i,
      /consolidated from/i,
      /2 receipts/i,
    ];
    const offenders: string[] = [];
    for (const file of await viewSources()) {
      const text = await readFile(file, 'utf-8');
      for (const re of banned) {
        if (re.test(text)) offenders.push(`${file.replace(ROOT + '/', '')} :: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the built output contains none of the removed multi-receipt copy', () => {
    expect(distHtml).not.toContain('Max 2 Receipts');
    expect(distHtml).not.toContain('Combine up to 2');
    expect(distHtml).not.toMatch(/maximum of two \(2\) same-day receipts/i);
  });

  test('StepGuide states the mandatory single-receipt wording', async () => {
    const stepGuide = await readFile(join(SRC, 'components', 'StepGuide.astro'), 'utf-8');
    expect(stepGuide).toContain('Must be single receipt. Not combined.');
    expect(distHtml).toContain('Must be single receipt. Not combined.');
  });

  test('the T&C clause states the mandatory single-receipt wording', async () => {
    const footer = await readFile(join(SRC, 'components', 'Footer.astro'), 'utf-8');
    expect(footer).toContain('Must be single receipt. Not combined.');
  });

  test('RedemptionBanner badge reads "Single Receipt"', async () => {
    const banner = await readFile(join(SRC, 'components', 'RedemptionBanner.astro'), 'utf-8');
    expect(banner).toContain('Single Receipt');
    expect(banner).not.toContain('Max 2 Receipts');
    expect(distHtml).toContain('Single Receipt');
  });

  test('the redemption form no longer collects a vehicle registration number', async () => {
    const card = await readFile(join(SRC, 'components', 'RedemptionCard.astro'), 'utf-8');
    expect(card).not.toContain('Vehicle Registration Number');
    expect(card).not.toContain('id="vehicle-plate"');
    expect(distHtml).not.toContain('Vehicle Registration Number');
    expect(distHtml).not.toContain('id="vehicle-plate"');
  });

  test('the redemption form submits receipt + shopId + timestamp only', async () => {
    const card = await readFile(join(SRC, 'components', 'RedemptionCard.astro'), 'utf-8');
    const block = card.slice(card.indexOf('const formData = new FormData();'), card.indexOf('let voucherCode: string'));
    expect(block).toContain("formData.append('receipt'");
    expect(block).toContain("formData.append('shopId'");
    expect(block).toContain("formData.append('timestamp'");
    expect(block).not.toContain('vehiclePlate');
  });

  test('the new LOCATION_NOT_VERIFIED error code is mapped to user-facing copy', async () => {
    const card = await readFile(join(SRC, 'components', 'RedemptionCard.astro'), 'utf-8');
    expect(card).toContain('LOCATION_NOT_VERIFIED');

    // Astro bundles component <script> blocks into dist/_astro/*.js
    const bundles = (await readdir(DIST_ASTRO)).filter((f) => f.endsWith('.js'));
    let found = false;
    for (const f of bundles) {
      const js = await readFile(join(DIST_ASTRO, f), 'utf-8');
      if (js.includes('LOCATION_NOT_VERIFIED')) found = true;
    }
    expect({ bundles: bundles.length, foundInBundle: found }).toEqual({
      bundles: bundles.length,
      foundInBundle: true,
    });
  });
});
