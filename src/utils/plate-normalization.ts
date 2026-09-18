/**
 * 321 Clementi Smart Parking Barcode Redemption Engine
 * Canonical Vehicle Plate Normalization (ADR-001)
 *
 * Implements plain-text normalization without restrictive checksums:
 * - Unicode NFKC normalization
 * - Strip zero-width & control characters
 * - Collapse consecutive whitespace to a single ASCII space
 * - Convert to uppercase
 * - Length bounds: 2 to 16 characters
 * - Whitelist: Alphanumeric characters and single internal spaces
 */

export class PlateValidationError extends Error {
  public code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlateValidationError';
    this.code = code;
  }
}

export function normalizeCarPlate(rawInput: unknown): string {
  if (typeof rawInput !== 'string') {
    throw new PlateValidationError('PLATE_INVALID_TYPE', 'Vehicle plate number must be a string');
  }

  // 1. Unicode NFKC Normalization & surrounding trim
  let plate = rawInput.normalize('NFKC').trim();

  // 2. Strip non-printable / control / zero-width characters
  plate = plate.replace(/[\u200B-\u200D\uFEFF\u0000-\u001F\u007F-\u009F]/g, '');

  // 3. Strip ALL whitespace (spaces, tabs, newlines) — PAN-84: space-invariant canonical key
  plate = plate.replace(/\s+/g, '');

  // 4. Uppercase Latin / ASCII characters
  plate = plate.toUpperCase();

  // 5. Length Validation Bounds (2 to 16 chars)
  if (plate.length < 2) {
    throw new PlateValidationError('PLATE_TOO_SHORT', 'Vehicle plate number must be at least 2 characters');
  }
  if (plate.length > 16) {
    throw new PlateValidationError('PLATE_TOO_LONG', 'Vehicle plate number cannot exceed 16 characters');
  }

  // 6. Whitelist character validation: uppercase letters and digits only (no spaces after strip)
  if (!/^[A-Z0-9]+$/.test(plate)) {
    throw new PlateValidationError(
      'PLATE_INVALID_CHARS',
      'Vehicle plate number may only contain alphanumeric characters'
    );
  }

  return plate;
}
