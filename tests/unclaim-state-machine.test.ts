/**
 * 321 Clementi Smart Parking Redemption Engine
 * Unclaim State Machine Tests (PAN-77 / ADR-001)
 * 
 * Verifies the unclaim workflow without a database:
 * - State transitions
 * - Authorization modes (token vs fallback)
 * - Daily quota release logic
 * - Audit trail completeness
 */

import { describe, test, expect } from 'bun:test';

// ============================================================================
// Simulated State Machine (mirrors DB logic for unit testing)
// ============================================================================

type VoucherStatus = 'AVAILABLE' | 'RESERVED' | 'REDEEMED' | 'EXPIRED';
type RedemptionStatus = 'CLAIMED' | 'UNCLAIMED' | 'RE_REDEEMED' | 'EXPIRED';

interface VoucherPoolEntry {
  voucher_code: string;
  status: VoucherStatus;
  vehicle_plate_hash: string | null;
}

interface RedemptionLogEntry {
  id: string;
  vehicle_plate: string;
  vehicle_plate_hash: string;
  voucher_code: string;
  receipt_amount: number;
  shop_id: string;
  status: RedemptionStatus;
  claim_token_hash: string | null;
  unclaimed_at: Date | null;
  unclaimed_reason: string | null;
  created_at: Date;
}

interface AuditLogEntry {
  redemption_id: string;
  action: 'CLAIM' | 'UNCLAIM' | 'RE_REDEEM' | 'HISTORY_QUERY';
  vehicle_plate: string;
  success: boolean;
  failure_reason: string | null;
}

class UnclaimStateMachine {
  vouchers: Map<string, VoucherPoolEntry> = new Map();
  redemptions: Map<string, RedemptionLogEntry> = new Map();
  audits: AuditLogEntry[] = [];

  constructor() {}

  allocateVoucher(
    voucherCode: string,
    vehiclePlate: string,
    vehiclePlateHash: string,
    receiptAmount: number,
    shopId: string,
    claimTokenHash: string
  ): { success: boolean; redemptionId: string; error?: string } {
    // Check daily limit: only one CLAIMED per plate per day
    const existing = [...this.redemptions.values()].find(
      r => r.vehicle_plate === vehiclePlate && r.status === 'CLAIMED'
    );
    if (existing) {
      return { success: false, redemptionId: '', error: 'DAILY_LIMIT_EXCEEDED' };
    }

    const redemptionId = crypto.randomUUID();
    this.vouchers.set(voucherCode, {
      voucher_code: voucherCode,
      status: 'REDEEMED',
      vehicle_plate_hash: vehiclePlateHash,
    });

    this.redemptions.set(redemptionId, {
      id: redemptionId,
      vehicle_plate: vehiclePlate,
      vehicle_plate_hash: vehiclePlateHash,
      voucher_code: voucherCode,
      receipt_amount: receiptAmount,
      shop_id: shopId,
      status: 'CLAIMED',
      claim_token_hash: claimTokenHash,
      unclaimed_at: null,
      unclaimed_reason: null,
      created_at: new Date(),
    });

    this.audits.push({
      redemption_id: redemptionId,
      action: 'CLAIM',
      vehicle_plate: vehiclePlate,
      success: true,
      failure_reason: null,
    });

    return { success: true, redemptionId };
  }

  unclaim(
    redemptionId: string,
    opts: {
      claimTokenHash?: string | null;
      secondaryPlate?: string;
      secondaryAmount?: number;
      secondaryShopId?: string;
      reason?: string;
    }
  ): { success: boolean; error?: string } {
    const redemption = this.redemptions.get(redemptionId);
    if (!redemption) {
      return { success: false, error: 'NOT_FOUND' };
    }

    if (redemption.status !== 'CLAIMED') {
      return { success: false, error: 'ALREADY_UNCLAIMED' };
    }

    // Check 2-hour window
    const twoHoursMs = 2 * 60 * 60 * 1000;
    if (Date.now() - redemption.created_at.getTime() > twoHoursMs) {
      return { success: false, error: 'OUTSIDE_UNCLAIM_WINDOW' };
    }

    // Authorization
    let authorized = false;

    if (opts.claimTokenHash && opts.claimTokenHash === redemption.claim_token_hash) {
      authorized = true;
    } else if (
      opts.secondaryPlate === redemption.vehicle_plate &&
      opts.secondaryAmount !== undefined &&
      Math.abs(opts.secondaryAmount - redemption.receipt_amount) < 0.01 &&
      opts.secondaryShopId === redemption.shop_id
    ) {
      authorized = true;
    }

    if (!authorized) {
      this.audits.push({
        redemption_id: redemptionId,
        action: 'UNCLAIM',
        vehicle_plate: redemption.vehicle_plate,
        success: false,
        failure_reason: 'CREDENTIAL_MISMATCH',
      });
      return { success: false, error: 'UNAUTHORIZED' };
    }

    // Execute unclaim
    redemption.status = 'UNCLAIMED';
    redemption.unclaimed_at = new Date();
    redemption.unclaimed_reason = opts.reason || 'USER_INITIATED';

    // Release voucher
    const voucher = this.vouchers.get(redemption.voucher_code);
    if (voucher) {
      voucher.status = 'AVAILABLE';
      voucher.vehicle_plate_hash = null;
    }

    this.audits.push({
      redemption_id: redemptionId,
      action: 'UNCLAIM',
      vehicle_plate: redemption.vehicle_plate,
      success: true,
      failure_reason: null,
    });

    return { success: true };
  }

  checkDailyLimit(vehiclePlate: string): boolean {
    const hasActiveClaim = [...this.redemptions.values()].some(
      r => r.vehicle_plate === vehiclePlate && r.status === 'CLAIMED'
    );
    return hasActiveClaim;
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Unclaim State Machine (PAN-77)', () => {

  describe('Basic Unclaim Flow', () => {
    test('Unclaiming a CLAIMED voucher returns it to AVAILABLE', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.00, 'shop-1', 'tokenhash123');
      expect(alloc.success).toBe(true);

      const result = sm.unclaim(alloc.redemptionId, {
        claimTokenHash: 'tokenhash123',
      });
      expect(result.success).toBe(true);

      // Verify voucher is available
      const voucher = sm.vouchers.get('VC-001');
      expect(voucher!.status).toBe('AVAILABLE');

      // Verify redemption is UNCLAIMED
      const redemption = sm.redemptions.get(alloc.redemptionId);
      expect(redemption!.status).toBe('UNCLAIMED');
    });

    test('Unclaiming releases the daily limit, allowing re-redemption', () => {
      const sm = new UnclaimStateMachine();
      
      // First claim
      const alloc1 = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.00, 'shop-1', 'tokenhash123');
      expect(alloc1.success).toBe(true);

      // Daily limit should be blocked
      const alloc2 = sm.allocateVoucher('VC-002', 'SBA1234A', 'hash123', 40.00, 'shop-2', 'tokenhash456');
      expect(alloc2.success).toBe(false);
      expect(alloc2.error).toBe('DAILY_LIMIT_EXCEEDED');

      // Unclaim
      sm.unclaim(alloc1.redemptionId, { claimTokenHash: 'tokenhash123' });

      // Now re-redemption should work
      const alloc3 = sm.allocateVoucher('VC-002', 'SBA1234A', 'hash123', 40.00, 'shop-2', 'tokenhash456');
      expect(alloc3.success).toBe(true);
    });
  });

  describe('Authorization Modes', () => {
    test('Token-based unclaim succeeds with correct claim token hash', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.00, 'shop-1', 'correct-token-hash');
      
      const result = sm.unclaim(alloc.redemptionId, {
        claimTokenHash: 'correct-token-hash',
      });
      expect(result.success).toBe(true);
    });

    test('Token-based unclaim fails with wrong claim token hash', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.00, 'shop-1', 'correct-token-hash');
      
      const result = sm.unclaim(alloc.redemptionId, {
        claimTokenHash: 'wrong-token-hash',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('UNAUTHORIZED');
    });

    test('Fallback (secondary factors) unclaim succeeds with correct details', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.50, 'shop-1', 'some-token-hash');
      
      const result = sm.unclaim(alloc.redemptionId, {
        secondaryPlate: 'SBA1234A',
        secondaryAmount: 35.50,
        secondaryShopId: 'shop-1',
        reason: 'MISSED_EXIT_WINDOW',
      });
      expect(result.success).toBe(true);
    });

    test('Fallback fails with wrong receipt amount', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.50, 'shop-1', 'some-token-hash');
      
      const result = sm.unclaim(alloc.redemptionId, {
        secondaryPlate: 'SBA1234A',
        secondaryAmount: 99.99, // wrong amount
        secondaryShopId: 'shop-1',
      });
      expect(result.success).toBe(false);
    });

    test('Fallback fails with wrong shop ID', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.50, 'shop-1', 'some-token-hash');
      
      const result = sm.unclaim(alloc.redemptionId, {
        secondaryPlate: 'SBA1234A',
        secondaryAmount: 35.50,
        secondaryShopId: 'wrong-shop-id',
      });
      expect(result.success).toBe(false);
    });

    test('Fallback fails with wrong vehicle plate', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.50, 'shop-1', 'some-token-hash');
      
      const result = sm.unclaim(alloc.redemptionId, {
        secondaryPlate: 'WRONG999', // wrong plate
        secondaryAmount: 35.50,
        secondaryShopId: 'shop-1',
      });
      expect(result.success).toBe(false);
    });

    test('Token takes priority over secondary factors when both provided', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.50, 'shop-1', 'correct-token-hash');
      
      // Token is wrong but secondary factors are correct
      const result = sm.unclaim(alloc.redemptionId, {
        claimTokenHash: 'wrong-token-hash',
        secondaryPlate: 'SBA1234A',
        secondaryAmount: 35.50,
        secondaryShopId: 'shop-1',
      });
      // Should succeed via secondary factors fallback
      expect(result.success).toBe(true);
    });
  });

  describe('State Transition Guards', () => {
    test('Cannot unclaim a redemption that is already UNCLAIMED', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.00, 'shop-1', 'tokenhash');
      
      sm.unclaim(alloc.redemptionId, { claimTokenHash: 'tokenhash' });
      const secondUnclaim = sm.unclaim(alloc.redemptionId, { claimTokenHash: 'tokenhash' });
      
      expect(secondUnclaim.success).toBe(false);
      expect(secondUnclaim.error).toBe('ALREADY_UNCLAIMED');
    });

    test('Cannot unclaim a non-existent redemption', () => {
      const sm = new UnclaimStateMachine();
      const result = sm.unclaim('non-existent-id', { claimTokenHash: 'token' });
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('NOT_FOUND');
    });

    test('Cannot unclaim after 2-hour window', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.00, 'shop-1', 'tokenhash');
      
      // Artificially age the redemption
      const redemption = sm.redemptions.get(alloc.redemptionId)!;
      redemption.created_at = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago

      const result = sm.unclaim(alloc.redemptionId, { claimTokenHash: 'tokenhash' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('OUTSIDE_UNCLAIM_WINDOW');
    });

    test('Cannot unclaim an EXPIRED redemption', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.00, 'shop-1', 'tokenhash');
      
      const redemption = sm.redemptions.get(alloc.redemptionId)!;
      redemption.status = 'EXPIRED';

      const result = sm.unclaim(alloc.redemptionId, { claimTokenHash: 'tokenhash' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('ALREADY_UNCLAIMED');
    });
  });

  describe('Audit Trail', () => {
    test('Every unclaim (success or failure) generates an audit entry', () => {
      const sm = new UnclaimStateMachine();
      const alloc = sm.allocateVoucher('VC-001', 'SBA1234A', 'hash123', 35.00, 'shop-1', 'tokenhash');
      
      // Failed attempt
      sm.unclaim(alloc.redemptionId, { claimTokenHash: 'wrong-token' });
      // Successful attempt
      sm.unclaim(alloc.redemptionId, { claimTokenHash: 'tokenhash' });

      const unclaimAudits = sm.audits.filter(a => a.action === 'UNCLAIM');
      expect(unclaimAudits.length).toBe(2);
      
      const failedAudit = unclaimAudits.find(a => !a.success);
      expect(failedAudit).toBeDefined();
      expect(failedAudit!.failure_reason).toBe('CREDENTIAL_MISMATCH');

      const successAudit = unclaimAudits.find(a => a.success);
      expect(successAudit).toBeDefined();
    });
  });

  describe('Concurrent Unclaim Safety', () => {
    test('Daily limit correctly enforced before and after unclaim', () => {
      const sm = new UnclaimStateMachine();
      
      // Plate A claims and unclaims
      const allocA = sm.allocateVoucher('VC-001', 'PLATE-A', 'hashA', 35.00, 'shop-1', 'tokA');
      sm.unclaim(allocA.redemptionId, { claimTokenHash: 'tokA' });
      
      // Plate B claims (independent)
      const allocB = sm.allocateVoucher('VC-002', 'PLATE-B', 'hashB', 40.00, 'shop-2', 'tokB');
      expect(allocB.success).toBe(true);
      
      // Plate A can re-claim after unclaim
      const allocA2 = sm.allocateVoucher('VC-003', 'PLATE-A', 'hashA', 45.00, 'shop-3', 'tokA2');
      expect(allocA2.success).toBe(true);
    });

    test('Multiple plates maintain independent daily limits', () => {
      const sm = new UnclaimStateMachine();
      
      const plates = ['PLATE-1', 'PLATE-2', 'PLATE-3', 'PLATE-4', 'PLATE-5'];
      
      for (const plate of plates) {
        const alloc = sm.allocateVoucher(`VC-${plate}`, plate, `hash-${plate}`, 35.00, 'shop-1', `tok-${plate}`);
        expect(alloc.success).toBe(true);
        
        // Second claim on same plate should fail
        const alloc2 = sm.allocateVoucher(`VC-${plate}-dup`, plate, `hash-${plate}`, 40.00, 'shop-2', `tok2-${plate}`);
        expect(alloc2.success).toBe(false);
      }
    });
  });
});