import type { ShopItem } from '../types';

/**
 * 21 Active & Eligible Tenant Stores at 321 Clementi (ADR-001)
 * Used as reliable fallback if GET /api/v1/shops is unreachable.
 */
export const FALLBACK_ELIGIBLE_SHOPS: ShopItem[] = [
  // Dine (8)
  { id: 'shop-huang-tu-di', name: "Huang Tu Di Xi'An Delights", slug: 'huang-tu-di-xian-delights', category: 'Dine', level: 'L2', unit: '#02-08', is_eligible: true },
  { id: 'shop-ji-de-chi', name: 'Ji De Chi', slug: 'ji-de-chi', category: 'Dine', level: 'L2', unit: '#02-01', is_eligible: true },
  { id: 'shop-kumar-mess', name: 'Kumar Mess', slug: 'kumar-mess', category: 'Dine', level: 'L1', unit: '#01-01', is_eligible: true },
  { id: 'shop-ocd-mala', name: 'OCD Mala Hotpot', slug: 'ocd-mala-hotpot', category: 'Dine', level: 'L1', unit: '#01-09,10,11', is_eligible: true },
  { id: 'shop-saizeriya', name: 'Saizeriya', slug: 'saizeriya', category: 'Dine', level: 'L2', unit: '#02-05/06/07', is_eligible: true },
  { id: 'shop-shanghai-tan', name: 'Shanghai Tan Pan-Fried Buns', slug: 'shanghai-tan-pan-fried-buns', category: 'Dine', level: 'L1', unit: '#01-12', is_eligible: true },
  { id: 'shop-siam-square', name: 'Siam Square Mookata', slug: 'siam-square-mookata', category: 'Dine', level: 'L3', unit: '#03-01', is_eligible: true },
  { id: 'shop-yans-tomato', name: "Yan's Tomato Hot Pot", slug: 'yans-tomato-hot-pot', category: 'Dine', level: 'L2', unit: '#02-10', is_eligible: true },

  // Learn (5)
  { id: 'shop-agrader', name: 'AGrader Learning Centre', slug: 'agrader-learning-centre', category: 'Learn', level: 'L3', unit: '#03-02', is_eligible: true },
  { id: 'shop-epic-swim', name: 'Epic Swim', slug: 'epic-swim', category: 'Learn', level: 'L7', unit: '#07-01', is_eligible: true },
  { id: 'shop-global-art', name: 'Global Art', slug: 'global-art', category: 'Learn', level: 'L1', unit: '#01-02', is_eligible: true },
  { id: 'shop-think-academy', name: 'Think Academy', slug: 'think-academy', category: 'Learn', level: 'L6', unit: '#06-01,02,03,04,05', is_eligible: true },
  { id: 'shop-wang-learning', name: 'Wang Learning Centre', slug: 'wang-learning-centre', category: 'Learn', level: 'L3', unit: '#03-01A, #03-01B', is_eligible: true },

  // Relax (2)
  { id: 'shop-beauty-full', name: 'Beauty Full Skin Wellness', slug: 'beauty-full-skin-wellness', category: 'Relax', level: 'L2', unit: '#02-03', is_eligible: true },
  { id: 'shop-gofit', name: 'Gofit', slug: 'gofit', category: 'Relax', level: 'L6', unit: '#06-06/07/08', is_eligible: true },

  // Services (6)
  { id: 'shop-arch-angel', name: 'Arch Angel Brow', slug: 'arch-angel-brow', category: 'Services', level: 'L1', unit: '#01-06 & #01-08', is_eligible: true },
  { id: 'shop-caring-skin', name: 'Caring Skin', slug: 'caring-skin', category: 'Services', level: 'L2', unit: '#02-09', is_eligible: true },
  { id: 'shop-indian-barber', name: 'Indian Barber Shop', slug: 'indian-barber-shop', category: 'Services', level: 'L1', unit: '#01-K1', is_eligible: true },
  { id: 'shop-one-spine', name: 'One Spine Chiropractic', slug: 'one-spine-chiropractic', category: 'Services', level: 'L2', unit: '#02-04', is_eligible: true },
  { id: 'shop-qm-dental', name: 'Q & M Dental Surgery', slug: 'qm-dental-surgery', category: 'Services', level: 'L2', unit: '#02-02', is_eligible: true },
  { id: 'shop-spacio-tcm', name: 'Spacio TCM Wellness', slug: 'spacio-tcm-wellness', category: 'Services', level: 'L1', unit: '#01-03/04', is_eligible: true },
];

/**
 * Fetch eligible shops from backend API or fallback to seed list
 */
export async function fetchEligibleShops(): Promise<ShopItem[]> {
  try {
    const res = await fetch('/api/v1/shops?eligible_only=true');
    if (!res.ok) {
      return FALLBACK_ELIGIBLE_SHOPS;
    }
    const json = await res.json() as { success: boolean; data?: ShopItem[] };
    if (json.success && Array.isArray(json.data) && json.data.length > 0) {
      return json.data;
    }
    return FALLBACK_ELIGIBLE_SHOPS;
  } catch {
    return FALLBACK_ELIGIBLE_SHOPS;
  }
}
