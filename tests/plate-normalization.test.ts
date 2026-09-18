/**
 * 321 Clementi Smart Parking Redemption Engine
 * Canonical Plate Normalization Test Suite (ADR-001 / PAN-76 / PAN-79 / PAN-84)
 *
 * PAN-84 change: normalizeCarPlate now strips ALL whitespace (space-invariant canonical key).
 * All formerly-spaced expectations updated to space-free equivalents.
 */

import { describe, test, expect } from 'bun:test';
import { normalizeCarPlate, PlateValidationError } from '../src/utils/plate-normalization';

describe('Plate Normalization Contract (ADR-001)', () => {
  describe('Standard Singapore Vehicle Plates', () => {
    test('Converts lowercase plate to uppercase without spaces', () => {
      expect(normalizeCarPlate('sgp1234a')).toBe('SGP1234A');
    });

    test('Trims surrounding whitespace and strips internal spaces (PAN-84)', () => {
      expect(normalizeCarPlate('  SGP 1234 A  ')).toBe('SGP1234A');
    });

    test('Collapses and strips multiple consecutive internal spaces (PAN-84)', () => {
      expect(normalizeCarPlate('sgp    1234   a')).toBe('SGP1234A');
    });

    test('Strips single-space from spaced plate (PAN-84)', () => {
      expect(normalizeCarPlate('SBA 1234 A')).toBe('SBA1234A');
    });

    test('Handles mixed case with irregular whitespace — strips all (PAN-84)', () => {
      expect(normalizeCarPlate('\t sBa   9999 z \n')).toBe('SBA9999Z');
    });
  });

  describe('Malaysian & Foreign Vehicle Plates', () => {
    test('Accepts Johor plate format (JQR1234) — strips space (PAN-84)', () => {
      expect(normalizeCarPlate('jqr 1234')).toBe('JQR1234');
    });

    test('Accepts Kuala Lumpur plate format (W1234A) — strips spaces (PAN-84)', () => {
      expect(normalizeCarPlate('w 1234 a')).toBe('W1234A');
    });

    test('Accepts Penang plate format (PBA5678) — strips spaces (PAN-84)', () => {
      expect(normalizeCarPlate('  pba 5678  ')).toBe('PBA5678');
    });

    test('Accepts Diplomatic Corps plates (CD1234) — strips spaces (PAN-84)', () => {
      expect(normalizeCarPlate('cd 12 34')).toBe('CD1234');
    });
  });

  describe('Unicode & Special Characters Sanitization', () => {
    test('Strips zero-width space characters (\\u200B, \\uFEFF)', () => {
      const input = 'SBA\u200B1234\uFEFFA';
      expect(normalizeCarPlate(input)).toBe('SBA1234A');
    });

    test('Performs NFKC normalization on full-width characters, strips spaces (PAN-84)', () => {
      // Full-width Latin: ＳＢＡ １２３４ Ａ
      const fullWidth = '\uFF33\uFF22\uFF21 \uFF11\uFF12\uFF13\uFF14 \uFF21';
      expect(normalizeCarPlate(fullWidth)).toBe('SBA1234A');
    });

    test('Rejects plates with emojis', () => {
      expect(() => normalizeCarPlate('SBA 🚗 1234')).toThrow(PlateValidationError);
      try {
        normalizeCarPlate('SBA 🚗 1234');
      } catch (err: any) {
        expect(err.code).toBe('PLATE_INVALID_CHARS');
      }
    });

    test('Rejects plates with punctuation or symbols (dashes, slashes, dots)', () => {
      expect(() => normalizeCarPlate('SBA-1234-A')).toThrow(PlateValidationError);
      expect(() => normalizeCarPlate('SBA/1234/A')).toThrow(PlateValidationError);
      expect(() => normalizeCarPlate('SBA.1234.A')).toThrow(PlateValidationError);
    });

    test('Rejects SQL injection payload attempts', () => {
      expect(() => normalizeCarPlate("SBA 1234'; DROP TABLE shops; --")).toThrow(PlateValidationError);
      expect(() => normalizeCarPlate("' OR 1=1 --")).toThrow(PlateValidationError);
    });
  });

  describe('Length Bounds Validation', () => {
    test('Accepts 2-character minimum plate', () => {
      expect(normalizeCarPlate('SG')).toBe('SG');
      expect(normalizeCarPlate('E1')).toBe('E1');
    });

    test('Rejects 1-character string (too short)', () => {
      expect(() => normalizeCarPlate('A')).toThrow(PlateValidationError);
      try {
        normalizeCarPlate('A');
      } catch (err: any) {
        expect(err.code).toBe('PLATE_TOO_SHORT');
      }
    });

    test('Accepts 16-character maximum plate', () => {
      const sixteenChars = 'A1B2C3D4E5F6G7H8';
      expect(normalizeCarPlate(sixteenChars)).toBe('A1B2C3D4E5F6G7H8');
      expect(normalizeCarPlate(sixteenChars).length).toBe(16);
    });

    test('Rejects strings exceeding 16 characters (too long)', () => {
      const seventeenChars = 'A1B2C3D4E5F6G7H89';
      expect(() => normalizeCarPlate(seventeenChars)).toThrow(PlateValidationError);
      try {
        normalizeCarPlate(seventeenChars);
      } catch (err: any) {
        expect(err.code).toBe('PLATE_TOO_LONG');
      }
    });

    test('Rejects empty or whitespace-only input', () => {
      expect(() => normalizeCarPlate('')).toThrow(PlateValidationError);
      expect(() => normalizeCarPlate('    ')).toThrow(PlateValidationError);
      try {
        normalizeCarPlate('   ');
      } catch (err: any) {
        expect(err.code).toBe('PLATE_TOO_SHORT');
      }
    });
  });

  describe('Type Safety & Null Checks', () => {
    test('Rejects non-string inputs with PLATE_INVALID_TYPE', () => {
      expect(() => normalizeCarPlate(null)).toThrow(PlateValidationError);
      expect(() => normalizeCarPlate(undefined)).toThrow(PlateValidationError);
      expect(() => normalizeCarPlate(12345)).toThrow(PlateValidationError);
      expect(() => normalizeCarPlate({})).toThrow(PlateValidationError);

      try {
        normalizeCarPlate(null);
      } catch (err: any) {
        expect(err.code).toBe('PLATE_INVALID_TYPE');
      }
    });
  });

  describe('Canonical Identity Invariance (History Lookup Key Consistency) — PAN-84', () => {
    test('All representations of the same vehicle plate (with or without spaces) produce identical canonical keys', () => {
      const variants = [
        'sba1234a',
        'SBA1234A',
        '  sba1234a  ',
        '\tsba1234a\n',
        'SBA\u200B1234A',
        'SBA 1234 A',       // now also strips spaces
        'sba 1234 a',
        '  sba   1234   a  ',
        '\tsba  1234  a\t',
      ];
      const expected = 'SBA1234A';
      for (const variant of variants) {
        expect(normalizeCarPlate(variant)).toBe(expected);
      }
    });

    test('Space-stripped result is always the same regardless of input spacing', () => {
      const spaced = normalizeCarPlate('SBA 1234 A');
      const unspaced = normalizeCarPlate('SBA1234A');
      expect(spaced).toBe(unspaced);
      expect(spaced).toBe('SBA1234A');
    });
  });
});
