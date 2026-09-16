/**
 * 321 Clementi Smart Parking Redemption Engine
 * Receipt Validation Negative Paths Tests (PAN-64)
 * 
 * Verify rejection of: spend < $30.00, yesterday's receipts, blurred/unreadable receipts.
 */

import { describe, test, expect } from 'bun:test';

// ============================================================================
// Core Data Types & Algorithm (mirrors n8n Gemini OCR node + validation)
// ============================================================================

interface ExtractedReceipt {
  total_amount: number | null;
  receipt_date: string | null;        // YYYY-MM-DD
  receipt_time: string | null;        // HH:MM:SS
  tenant_name: string | null;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates an extracted receipt against business rules.
 * Returns structured result with all failures enumerated.
 */
function validateReceipt(
  extracted: ExtractedReceipt,
  referenceDate: Date = new Date()
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const todayStr = formatDate(referenceDate);

  // --- Rule 1: Minimum spend >= $30.00 ---
  if (extracted.total_amount === null) {
    errors.push('AMOUNT_NOT_DETECTED');
  } else if (extracted.total_amount < 30.00) {
    errors.push(`MINIMUM_SPEND_NOT_MET: ${formatCurrency(extracted.total_amount)} < $30.00`);
  }

  // --- Rule 2: Receipt date must be TODAY ---
  if (extracted.receipt_date === null) {
    errors.push('DATE_NOT_DETECTED');
  } else if (extracted.receipt_date !== todayStr) {
    const diffDays = daysBetween(extracted.receipt_date, todayStr);
    if (diffDays > 0) {
      errors.push(`RECEIPT_EXPIRED: ${extracted.receipt_date} is ${diffDays} day(s) ago`);
    } else {
      warnings.push(`RECEIPT_FUTURE: ${extracted.receipt_date} appears to be in the future`);
    }
  }

  // --- Rule 3: Receipt time within operating window ---
  if (extracted.receipt_time !== null) {
    const [hours, minutes] = extracted.receipt_time.split(':').map(Number);
    const totalMinutes = hours * 60 + minutes;
    
    if (totalMinutes < 720 || totalMinutes >= 900) {
      warnings.push(`OFF_HOURS: Receipt time ${extracted.receipt_time} outside 12:00-15:00 window`);
    }
  } else {
    warnings.push('TIME_NOT_DETECTED');
  }

  // --- Rule 4: Tenant verification (soft check) ---
  if (!extracted.tenant_name || extracted.tenant_name.trim() === '') {
    warnings.push('TENANT_NOT_IDENTIFIED');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// Helper functions

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function daysBetween(dateStr1: string, dateStr2: string): number {
  const d1 = new Date(dateStr1);
  const d2 = new Date(dateStr2);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((d2.getTime() - d1.getTime()) / msPerDay);
}

// Mock OCR extraction results for different receipt scenarios
function mockOCRResults(): Record<string, ExtractedReceipt> {
  const today = new Date();
  
  return {
    valid_receipt: {
      total_amount: 45.50,
      receipt_date: formatDate(today),
      receipt_time: '13:15:00',
      tenant_name: 'FairPrice Finest',
    },
    low_spend_exact_29: {
      total_amount: 29.00,
      receipt_date: formatDate(today),
      receipt_time: '13:15:00',
      tenant_name: 'NTUC FairPrice',
    },
    low_spend_exact_29_99: {
      total_amount: 29.99,
      receipt_date: formatDate(today),
      receipt_time: '13:15:00',
      tenant_name: 'Sheng Siong',
    },
    low_spend_5_dollar: {
      total_amount: 5.00,
      receipt_date: formatDate(today),
      receipt_time: '14:00:00',
      tenant_name: 'Costco',
    },
    exactly_30: {
      total_amount: 30.00,
      receipt_date: formatDate(today),
      receipt_time: '12:00:00',
      tenant_name: 'Cold Storage',
    },
    slightly_over_30: {
      total_amount: 30.01,
      receipt_date: formatDate(today),
      receipt_time: '12:05:00',
      tenant_name: 'Giant',
    },
    yesterday_receipt: {
      total_amount: 55.00,
      receipt_date: formatDate(new Date(Date.now() - 86400000)),
      receipt_time: '13:00:00',
      tenant_name: 'Takeaway',
    },
    two_days_ago: {
      total_amount: 42.50,
      receipt_date: formatDate(new Date(Date.now() - 2 * 86400000)),
      receipt_time: '14:00:00',
      tenant_name: 'Makansutra',
    },
    week_old: {
      total_amount: 68.00,
      receipt_date: formatDate(new Date(Date.now() - 7 * 86400000)),
      receipt_time: '12:30:00',
      tenant_name: 'Restaurant',
    },
    empty_fields: {
      total_amount: null,
      receipt_date: null,
      receipt_time: null,
      tenant_name: null,
    },
    only_amount_provided: {
      total_amount: 45.00,
      receipt_date: null,
      receipt_time: null,
      tenant_name: null,
    },
    only_date_provided: {
      total_amount: null,
      receipt_date: formatDate(today),
      receipt_time: null,
      tenant_name: null,
    },
    blurry_receipt_low_confidence: {
      total_amount: 22.50, // Likely misread due to blur
      receipt_date: formatDate(today),
      receipt_time: '11:00:00',
      tenant_name: '', // Empty = unclear tenant
    },
    extreme_spend_values: {
      total_amount: 99999.99, // Unusually high but technically passes threshold
      receipt_date: formatDate(today),
      receipt_time: '13:00:00',
      tenant_name: 'LuxuryStore',
    },
    zero_amount: {
      total_amount: 0.00,
      receipt_date: formatDate(today),
      receipt_time: '13:00:00',
      tenant_name: 'FreeSample',
    },
    negative_amount: {
      total_amount: -10.00,
      receipt_date: formatDate(today),
      receipt_time: '13:00:00',
      tenant_name: 'RefundReceipt',
    },
    fractional_spend: {
      total_amount: 30.50,
      receipt_date: formatDate(today),
      receipt_time: '13:30:00',
      tenant_name: 'Kopitiam',
    },
    exact_boundary_low: {
      total_amount: 29.99,
      receipt_date: formatDate(today),
      receipt_time: '13:30:00',
      tenant_name: 'BoundaryTest',
    },
    exact_boundary_high: {
      total_amount: 30.00,
      receipt_date: formatDate(today),
      receipt_time: '13:30:00',
      tenant_name: 'BoundaryTest',
    },
    future_date: {
      total_amount: 50.00,
      receipt_date: formatDate(new Date(Date.now() + 86400000)),
      receipt_time: '13:00:00',
      tenant_name: 'FutureShop',
    },
    early_morning: {
      total_amount: 35.00,
      receipt_date: formatDate(today),
      receipt_time: '08:30:00',
      tenant_name: 'EarlyBirdCafe',
    },
    late_night: {
      total_amount: 40.00,
      receipt_date: formatDate(today),
      receipt_time: '22:00:00',
      tenant_name: 'LateNiteEats',
    },
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Receipt Validation Negative Paths (PAN-64)', () => {
  
  // --- Section 1: Spend Threshold Tests ---
  describe('Minimum Spend Threshold ($30.00)', () => {
    test('Spend of $29.00 must be rejected', () => {
      const result = validateReceipt(mockOCRResults().low_spend_exact_29);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MINIMUM_SPEND_NOT_MET'))).toBe(true);
    });

    test('Spend of $29.99 must be rejected', () => {
      const result = validateReceipt(mockOCRResults().low_spend_exact_29_99);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MINIMUM_SPEND_NOT_MET'))).toBe(true);
    });

    test('Spend of $5.00 must be rejected', () => {
      const result = validateReceipt(mockOCRResults().low_spend_5_dollar);
      expect(result.valid).toBe(false);
    });

    test('Spend of exactly $30.00 must be accepted', () => {
      const result = validateReceipt(mockOCRResults().exactly_30);
      expect(result.valid).toBe(true);
    });

    test('Spend of $30.01 must be accepted', () => {
      const result = validateReceipt(mockOCRResults().slightly_over_30);
      expect(result.valid).toBe(true);
    });

    test('Spend of $30.50 (fractional) must be accepted', () => {
      const result = validateReceipt(mockOCRResults().fractional_spend);
      expect(result.valid).toBe(true);
    });

    test('Zero spend must be rejected', () => {
      const result = validateReceipt(mockOCRResults().zero_amount);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MINIMUM_SPEND_NOT_MET'))).toBe(true);
    });

    test('Negative amount must be rejected', () => {
      const result = validateReceipt(mockOCRResults().negative_amount);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MINIMUM_SPEND_NOT_MET'))).toBe(true);
    });

    test('Boundary: $29.99 vs $30.00 must be strictly enforced', () => {
      const belowResult = validateReceipt(mockOCRResults().exact_boundary_low);
      const atResult = validateReceipt(mockOCRResults().exact_boundary_high);
      
      expect(belowResult.valid).toBe(false);
      expect(atResult.valid).toBe(true);
    });
  });

  // --- Section 2: Receipt Date Validation ---
  describe('Receipt Date Must Be Today', () => {
    test('Yesterday\'s receipt must be rejected', () => {
      const result = validateReceipt(mockOCRResults().yesterday_receipt);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('RECEIPT_EXPIRED'))).toBe(true);
    });

    test('Two days ago must be rejected', () => {
      const result = validateReceipt(mockOCRResults().two_days_ago);
      expect(result.valid).toBe(false);
    });

    test('One week old must be rejected', () => {
      const result = validateReceipt(mockOCRResults().week_old);
      expect(result.valid).toBe(false);
    });

    test('Today\'s receipt must be accepted', () => {
      const result = validateReceipt(mockOCRResults().valid_receipt);
      expect(result.valid).toBe(true);
    });

    test('Future date produces warning but doesn\'t auto-reject', () => {
      const result = validateReceipt(mockOCRResults().future_date);
      expect(result.warnings.some(w => w.includes('RECEIPT_FUTURE'))).toBe(true);
      // Amount and date don't fail core rules (date mismatch counted as warning not error)
    });

    test('Null date produces error', () => {
      const nullDateResult: ExtractedReceipt = {
        total_amount: 45.00,
        receipt_date: null,
        receipt_time: '13:00:00',
        tenant_name: 'SomeTenant',
      };
      const result = validateReceipt(nullDateResult);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('DATE_NOT_DETECTED'))).toBe(true);
    });
  });

  // --- Section 3: Blurred/Unreadable Receipt Handling ---
  describe('Blurred/Unreadable Receipt Rejection', () => {
    test('Fully null receipt fields produces multiple errors', () => {
      const result = validateReceipt(mockOCRResults().empty_fields);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.errors.some(e => e.includes('AMOUNT_NOT_DETECTED'))).toBe(true);
      expect(result.errors.some(e => e.includes('DATE_NOT_DETECTED'))).toBe(true);
    });

    test('Only amount detected (blurry date/time) produces warnings', () => {
      const result = validateReceipt(mockOCRResults().only_amount_provided);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('DATE_NOT_DETECTED'))).toBe(true);
    });

    test('Blurry receipt with misread low amount fails spend check', () => {
      const result = validateReceipt(mockOCRResults().blurry_receipt_low_confidence);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('MINIMUM_SPEND_NOT_MET'))).toBe(true);
    });

    test('Empty tenant name on otherwise valid receipt produces warning', () => {
      const result = validateReceipt(mockOCRResults().blurry_receipt_low_confidence);
      expect(result.warnings.some(w => w.includes('TENANT_NOT_IDENTIFIED'))).toBe(true);
    });
  });

  // --- Section 4: Operating Hours on Receipt Time ---
  describe('Receipt Time Outside Operating Window', () => {
    test('Early morning receipt (08:30) produces off-hours warning', () => {
      const result = validateReceipt(mockOCRResults().early_morning);
      expect(result.warnings.some(w => w.includes('OFF_HOURS'))).toBe(true);
    });

    test('Late night receipt (22:00) produces off-hours warning', () => {
      const result = validateReceipt(mockOCRResults().late_night);
      expect(result.warnings.some(w => w.includes('OFF_HOURS'))).toBe(true);
    });

    test('In-window receipt (13:15) produces no timing warnings', () => {
      const result = validateReceipt(mockOCRResults().valid_receipt);
      expect(result.warnings.some(w => w.includes('OFF_HOURS'))).toBe(false);
    });

    test('Edge-case boundary times (11:59, 15:01) flagged', () => {
      const beforeWindow: ExtractedReceipt = {
        total_amount: 45.00,
        receipt_date: formatDate(new Date()),
        receipt_time: '11:59:00',
        tenant_name: 'EdgeTest',
      };
      const afterWindow: ExtractedReceipt = {
        total_amount: 45.00,
        receipt_date: formatDate(new Date()),
        receipt_time: '15:01:00',
        tenant_name: 'EdgeTest',
      };

      const beforeResult = validateReceipt(beforeWindow);
      const afterResult = validateReceipt(afterWindow);

      expect(beforeResult.warnings.some(w => w.includes('OFF_HOURS'))).toBe(true);
      expect(afterResult.warnings.some(w => w.includes('OFF_HOURS'))).toBe(true);
    });
  });

  // --- Section 5: Composite Failure Scenarios ---
  describe('Multiple Failure Combinations', () => {
    test('Low spend + old receipt produces both errors', () => {
      const multiFailure: ExtractedReceipt = {
        total_amount: 15.00,
        receipt_date: formatDate(new Date(Date.now() - 86400000)), // yesterday
        receipt_time: '13:00:00',
        tenant_name: 'FailCombo',
      };
      const result = validateReceipt(multiFailure);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.errors.some(e => e.includes('MINIMUM_SPEND_NOT_MET'))).toBe(true);
      expect(result.errors.some(e => e.includes('RECEIPT_EXPIRED'))).toBe(true);
    });

    test('All-null receipt + low spend edge case', () => {
      const fullyBroken: ExtractedReceipt = {
        total_amount: null,
        receipt_date: null,
        receipt_time: null,
        tenant_name: null,
      };
      const result = validateReceipt(fullyBroken);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(2); // AMOUNT_NOT_DETECTED + DATE_NOT_DETECTED
    });

    test('Valid receipt passes cleanly with no errors or warnings', () => {
      const result = validateReceipt(mockOCRResults().valid_receipt);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(0);
    });
  });

  // --- Section 6: Extremes ---
  describe('Extreme Value Testing', () => {
    test('Very large spend still passes threshold', () => {
      const result = validateReceipt(mockOCRResults().extreme_spend_values);
      expect(result.valid).toBe(true);
    });

    test('High-value receipt is functionally equivalent to moderate values', () => {
      const moderate: ExtractedReceipt = {
        total_amount: 35.00,
        receipt_date: formatDate(new Date()),
        receipt_time: '13:00:00',
        tenant_name: 'Moderate',
      };
      const extreme = mockOCRResults().extreme_spend_values;
      
      const modResult = validateReceipt(moderate);
      const extResult = validateReceipt(extreme);
      
      // Both should pass the same set of rules
      expect(modResult.valid).toBe(extResult.valid);
    });

    test('Rapid fire 100 validations all produce consistent results', () => {
      const base = mockOCRResults().valid_receipt;
      const results: boolean[] = [];
      
      for (let i = 0; i < 100; i++) {
        const r = validateReceipt(base);
        results.push(r.valid);
      }
      
      // All should match first result
      const first = results[0];
      for (const r of results) {
        expect(r).toBe(first);
      }
    });
  });
});
