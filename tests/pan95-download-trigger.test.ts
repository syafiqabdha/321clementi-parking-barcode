/**
 * PAN-95 — Quality Gate: "Download Barcode" trigger behaviour.
 *
 * The download path is EXTRACTED from the shipped source (src/components/RedemptionCard.astro)
 * and executed against DOM/canvas stubs, so this asserts the real implementation rather than
 * a re-implementation of it. Complements the in-browser E2E check.
 */
import { describe, test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const REDEMPTION_CARD = join(ROOT, 'src', 'components', 'RedemptionCard.astro');
const EXAMPLE_CODE = '1234567890';

const source = await readFile(REDEMPTION_CARD, 'utf-8');
const fnSource = source.match(/function downloadBarcodePng\(\)\s*\{[\s\S]*?\n  \}/);
if (!fnSource) throw new Error('downloadBarcodePng() not found in RedemptionCard.astro — did the handler get renamed?');
const FN: string = fnSource[0];

interface Harness {
  run: () => void;
  events: {
    toDataURL: Array<string | undefined>;
    jsbarcode: Array<{ value: string; options: any }>;
    appended: any[];
    removed: any[];
    clicks: string[];
    created: string[];
    errors: string[];
  };
  link: { href: string; download: string; click: () => void };
  canvas: { toDataURL: (t?: string) => string };
}

function makeHarness(voucherCode: string, jsbarcodeThrows = false): Harness {
  const events: Harness['events'] = {
    toDataURL: [], jsbarcode: [], appended: [], removed: [], clicks: [], created: [], errors: [],
  };
  const link = {
    href: '',
    download: '',
    click() { events.clicks.push(this.download); },
  };
  const documentStub = {
    body: {
      appendChild(node: any) { events.appended.push(node); },
      removeChild(node: any) { events.removed.push(node); },
    },
    createElement(tag: string) { events.created.push(tag); return link; },
  };
  const canvas = {
    toDataURL(type?: string) { events.toDataURL.push(type); return 'data:image/png;base64,QQ=='; },
  };
  const JsBarcodeStub = (_target: any, value: string, options: any) => {
    if (jsbarcodeThrows) throw new Error('Invalid character');
    events.jsbarcode.push({ value, options });
  };
  const factory = new Function(
    'document', 'JsBarcode', 'downloadCanvas', 'currentVoucherCode', 'console',
    `${FN}\nreturn downloadBarcodePng;`
  );
  const run = factory(
    documentStub, JsBarcodeStub, canvas, voucherCode,
    { error: (msg: string) => events.errors.push(String(msg)) }
  ) as () => void;
  return { run, events, link, canvas };
}

describe('PAN-95 download trigger — rasterization', () => {
  test('renders the CURRENT voucher code as CODE128 with white background / black bars', () => {
    const h = makeHarness(EXAMPLE_CODE);
    h.run();

    expect(h.events.jsbarcode.length).toBe(1);
    expect(h.events.jsbarcode[0].value).toBe(EXAMPLE_CODE);
    expect(h.events.jsbarcode[0].options.format).toBe('CODE128');
    expect(h.events.jsbarcode[0].options.background).toBe('#FFFFFF');
    expect(h.events.jsbarcode[0].options.lineColor).toBe('#000000');
    expect(h.events.jsbarcode[0].options.height).toBeGreaterThan(0);
    expect(h.events.jsbarcode[0].options.width).toBeGreaterThan(0);
  });

  test('exports PNG (mobile gallery compatible) — not JPEG/SVG', () => {
    const h = makeHarness(EXAMPLE_CODE);
    h.run();
    expect(h.events.toDataURL).toEqual(['image/png']);
  });
});

describe('PAN-95 download trigger — anchor behaviour', () => {
  test('filename follows the 321Clementi-Barcode-[VoucherCode].png contract', () => {
    const h = makeHarness('0000012345');
    h.run();
    expect(h.events.created).toEqual(['a']);
    expect(h.link.download).toBe('321Clementi-Barcode-0000012345.png');
  });

  test('uses the rasterized data URL as href and triggers a real click', () => {
    const h = makeHarness(EXAMPLE_CODE);
    h.run();
    expect(h.link.href).toBe('data:image/png;base64,QQ==');
    expect(h.events.clicks).toEqual([`321Clementi-Barcode-${EXAMPLE_CODE}.png`]);
  });

  test('removes the temporary anchor from the DOM after the click (no leak)', () => {
    const h = makeHarness(EXAMPLE_CODE);
    h.run();
    expect(h.events.appended.length).toBe(1);
    expect(h.events.removed).toEqual(h.events.appended);
  });
});

describe('PAN-95 download trigger — failure and empty-state paths', () => {
  test('no voucher code yet → silent no-op (no canvas work, no anchor, no throw)', () => {
    const h = makeHarness('');
    expect(() => h.run()).not.toThrow();
    expect(h.events.jsbarcode).toEqual([]);
    expect(h.events.toDataURL).toEqual([]);
    expect(h.events.created).toEqual([]);
  });

  test('unencodable code → error contained, no anchor created, no unhandled exception', () => {
    const h = makeHarness('••••••••••', true);
    expect(() => h.run()).not.toThrow();
    expect(h.events.errors.length).toBe(1);
    expect(h.events.created).toEqual([]);
    expect(h.events.clicks).toEqual([]);
  });
});

describe('PAN-95 download trigger — markup wiring', () => {
  test('button and hidden canvas exist and the handler is bound to the button', () => {
    expect(source).toContain('id="download-barcode-btn"');
    expect(source).toMatch(/id="download-barcode-btn"[\s\S]{0,120}type="button"|type="button"[\s\S]{0,120}id="download-barcode-btn"/);
    expect(source).toContain('id="barcode-download-canvas"');
    expect(source).toMatch(/id="barcode-download-canvas"[\s\S]{0,200}aria-hidden="true"/);
    expect(source).toContain("downloadBarcodeBtn?.addEventListener('click', downloadBarcodePng)");
    expect(source).toMatch(/<span>Download Barcode<\/span>/);
  });

  test('download button lives inside the post-redemption result section (not always visible)', () => {
    const resultSectionIndex = source.indexOf('id="barcode-result-section"');
    const buttonIndex = source.indexOf('id="download-barcode-btn"');
    const scriptIndex = source.indexOf('<script');
    expect(resultSectionIndex).toBeGreaterThan(-1);
    expect(buttonIndex).toBeGreaterThan(resultSectionIndex);
    expect(buttonIndex).toBeLessThan(scriptIndex);
  });
});
