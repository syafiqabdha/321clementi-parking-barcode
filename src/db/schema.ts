/**
 * 321 Clementi Smart Parking Barcode Redemption Engine
 * Database Schema Models & Types
 * Reference: ADR-001 (PAN-75 / PAN-76)
 */

export type VoucherStatus = 'AVAILABLE' | 'RESERVED' | 'REDEEMED' | 'EXPIRED';

export type RedemptionStatus = 'CLAIMED' | 'UNCLAIMED' | 'RE_REDEEMED' | 'EXPIRED';

export type ShopCategory = 'Dine' | 'Learn' | 'Relax' | 'Services';

export interface VoucherPool {
  id: number;
  voucher_code: string;
  barcode_format: string; // 'CODE128'
  status: VoucherStatus;
  allocated_at: Date | null;
  redeemed_at: Date | null;
  vehicle_plate_hash: string | null;
  batch_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Shop {
  id: string; // UUID
  name: string;
  slug: string;
  category: ShopCategory;
  level: string;
  unit: string;
  is_active: boolean;
  is_eligible: boolean;
  ineligibility_reason?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RedemptionLog {
  id: string; // UUID
  vehicle_plate: string; // Canonical plain-text car plate (e.g. 'SBA 1234 A')
  vehicle_plate_hash: string;
  receipt_amount: number;
  receipt_date: string; // YYYY-MM-DD
  tenant_name: string | null;
  shop_id?: string | null; // UUID referencing shops(id)
  voucher_code: string;
  status: RedemptionStatus;
  claim_token_hash?: string | null;
  unclaimed_at?: Date | null;
  unclaimed_reason?: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
}

export interface RedemptionAuditLog {
  id: number;
  redemption_id: string;
  action: 'CLAIM' | 'UNCLAIM' | 'RE_REDEEM' | 'HISTORY_QUERY';
  vehicle_plate: string;
  voucher_code: string | null;
  ip_address: string | null;
  user_agent: string | null;
  success: boolean;
  failure_reason?: string | null;
  metadata?: Record<string, any>;
  created_at: Date;
}

export interface AllocateVoucherParams {
  vehiclePlate: string; // Canonical plain-text plate
  vehiclePlateHash: string;
  receiptAmount: number;
  receiptDate: string; // YYYY-MM-DD
  tenantName?: string | null;
  shopId?: string | null;
  claimTokenHash?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AllocatedVoucherResult {
  redemption_id: string;
  voucher_code: string;
  barcode_format: string;
  vehicle_plate: string;
  claim_token: string;
  expires_at: Date;
}

export interface UnclaimParams {
  redemptionId: string;
  claimToken?: string | null;
  vehiclePlate?: string | null;
  receiptAmount?: number | null;
  shopId?: string | null;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface UnclaimResult {
  redemption_id: string;
  vehicle_plate: string;
  voucher_code: string;
  status: 'UNCLAIMED';
  unclaimed_at: Date;
}
