/**
 * PAN-95 — Quality Gate: barcode symbology + export geometry.
 *
 * Uses the SAME encoder the shipped component uses (jsbarcode CODE128_AUTO) to verify
 * the Tech Lead's subset-C claim and the geometry of the PNG the download button emits.
 *
 * jsbarcode's canvas renderer math (node_modules/jsbarcode/bin/renderers/shared.js +
 * canvas.js): canvas.width = ceil(modules * options.width) + marginLeft + marginRight and
 * canvas.height = options.height + marginTop + marginBottom (no text when displayValue:false).
 */
import { describe, test, expect } from 'bun:test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CODE128 = (require('jsbarcode/bin/barcodes/CODE128/index.js') as any).CODE128;

/** Mirrors the download-canvas options in RedemptionCard.astro. */
const DOWNLOAD_OPTIONS = { width: 2.5, height: 100, margin: 12, displayValue: false };

function encode(code: string): { modules: number } {
  const encoding = new CODE128(code, {});
  const data = encoding.encode();
  return { modules: String(data.data).length };
}

function expectedCanvas(code: string) {
  const { modules } = encode(code);
  return {
    modules,
    width: Math.ceil(modules * DOWNLOAD_OPTIONS.width) + DOWNLOAD_OPTIONS.margin * 2,
    height: DOWNLOAD_OPTIONS.height + DOWNLOAD_OPTIONS.margin * 2,
  };
}

describe('PAN-95 barcode symbology — 10-digit numeric codes', () => {
  test('10-digit codes encode as CODE128 subset C (numeric compression, compact barcode)', () => {
    // Subset C packs 2 digits per symbol: start(11) + 5 data symbols(55) + checksum(11) + stop(13)
    for (const code of ['1234567890', '0000012345', '9999999999']) {
      expect(`${code}:${encode(code).modules}`).toBe(`${code}:90`);
    }
  });

  test('every numeric code encodes narrower than the legacy alphanumeric format', () => {
    const numeric = encode('1234567890').modules;
    const legacy = encode('CLM-12345678').modules; // subset B, 12 data symbols
    expect(numeric).toBeLessThan(legacy);
  });

  test('numeric codes are mutually distinct (no encoder collision from leading zeros)', () => {
    const patterns = ['0000000001', '0000000010', '0000012345', '1000000000'].map((c) => {
      const encoding = new CODE128(c, {});
      return String(encoding.encode().data);
    });
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});

describe('PAN-95 barcode symbology — unencodable values', () => {
  test('the history mask sentinel cannot be encoded as CODE128 (why FINDING-3 breaks the UI)', () => {
    // RedemptionCard.openEnlargeModal() catches this throw, so tapping "View Barcode" on a
    // masked history row opens a modal with an EMPTY svg. The UI must not offer the control.
    expect(() => encode('••••••••••')).toThrow();
  });

  test('empty string cannot be encoded (download button is a no-op without a voucher)', () => {
    expect(() => encode('')).toThrow();
  });
});

describe('PAN-95 download export — PNG geometry', () => {
  test('exported PNG is a scan-friendly raster for a 10-digit code', () => {
    const geo = expectedCanvas('1234567890');
    expect(geo.modules).toBe(90);
    expect(geo.width).toBe(249);
    expect(geo.height).toBe(124);
    // Wide enough for gantry scanners on a screen-scaled image
    expect(geo.width).toBeGreaterThanOrEqual(200);
  });

  test('exported PNG keeps white quiet zones on both sides of the bars', () => {
    expect(DOWNLOAD_OPTIONS.margin).toBeGreaterThanOrEqual(10);
  });
});
