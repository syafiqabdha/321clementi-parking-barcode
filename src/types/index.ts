export interface BrandColorToken {
  name: string;
  hex: string;
  rgb: string;
  role: string;
  meaning: string;
}

export interface RedemptionStep {
  stepNumber: number;
  title: string;
  description: string;
  badgeColor: string;
  icon: string;
}

export interface OperatingHours {
  startHour: number; // e.g. 12
  startMinute: number; // e.g. 0
  endHour: number; // e.g. 15
  endMinute: number; // e.g. 0
  days: string; // "Weekdays only (Mon - Fri)"
  minSpend: number; // 30.00
  complimentaryHours: number; // 2
}

/**
 * Tenant shop entry for frontend selection dropdown (ADR-001)
 */
export interface ShopItem {
  id: string;
  name: string;
  slug: string;
  category: 'Dine' | 'Learn' | 'Relax' | 'Services';
  level: string;
  unit: string;
  is_eligible: boolean;
}

/**
 * Claim history record returned to user UI (ADR-001)
 */
export interface ClaimHistoryRecord {
  id: string;
  voucher_code: string;
  barcode_format: string;
  receipt_amount: number;
  receipt_date: string;
  shop_name: string;
  status: 'CLAIMED' | 'UNCLAIMED' | 'RE_REDEEMED' | 'EXPIRED';
  can_unclaim: boolean;
  can_resume: boolean;
  expires_at: string;
  created_at: string;
}

/**
 * Unclaim request payload (ADR-001)
 */
export interface UnclaimPayload {
  vehicle_plate?: string;
  receipt_amount?: number;
  shop_id?: string;
  reason?: string;
}
