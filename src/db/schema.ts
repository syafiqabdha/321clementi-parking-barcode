/**
 * 321 Clementi Smart Parking Barcode Redemption Engine
 * Database Schema Models & Types
 */

export type VoucherStatus = 'AVAILABLE' | 'RESERVED' | 'REDEEMED' | 'EXPIRED';

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

export interface RedemptionLog {
  id: string; // UUID
  vehicle_plate_hash: string;
  receipt_amount: number;
  receipt_date: string; // YYYY-MM-DD
  tenant_name: string | null;
  voucher_code: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
}

export interface AllocateVoucherParams {
  vehiclePlateHash: string;
  receiptAmount: number;
  receiptDate: string; // YYYY-MM-DD
  tenantName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AllocatedVoucherResult {
  voucher_code: string;
  barcode_format: string;
}
