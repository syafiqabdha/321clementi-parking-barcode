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
