/**
 * 321 Clementi Mall - Store Directory Seed Data
 * Source: 2026-09-17 mall directory scrape (27 entries)
 * Policy: ADR-001 deduplication & inclusion rules applied.
 * 
 *   - 27 scraped rows → 26 DB records (duplicate "Carpark" B1/B2 collapsed into one)
 *   - Non-retail facilities: is_active=false, is_eligible=false
 *   - Mall-excluded tenants: is_active=false, is_eligible=false
 *   - 22 active, eligible stores visible to shoppers
 */

export interface ShopSeed {
  name: string;
  slug: string;
  category: 'Dine' | 'Learn' | 'Relax' | 'Services';
  level: string;
  unit: string;
  is_active: boolean;
  is_eligible: boolean;
  ineligibility_reason: string | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[&]/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const SHOP_SEED_DATA: ShopSeed[] = [
  {
    name: 'AGrader Learning Centre',
    slug: slugify('AGrader Learning Centre'),
    category: 'Learn',
    level: 'L3',
    unit: '#03-02',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Arch Angel Brow',
    slug: slugify('Arch Angel Brow'),
    category: 'Services',
    level: 'L1',
    unit: '#01-06 & #01-08',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Beauty Full Skin Wellness',
    slug: slugify('Beauty Full Skin Wellness'),
    category: 'Relax',
    level: 'L2',
    unit: '#02-03',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Caring Skin',
    slug: slugify('Caring Skin'),
    category: 'Services',
    level: 'L2',
    unit: '#02-09',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Carpark',
    slug: slugify('Carpark'),
    category: 'Services',
    level: 'B1/B2',
    unit: 'B1, B2',
    is_active: false,
    is_eligible: false,
    ineligibility_reason: 'Facility exclusion: mall amenity, not a commercial store. Merged B1 & B2 duplicate rows.',
  },
  {
    name: 'Clementi Family & Aesthetic Clinic',
    slug: slugify('Clementi Family & Aesthetic Clinic'),
    category: 'Services',
    level: 'L1',
    unit: '#01-14/15',
    is_active: false,
    is_eligible: false,
    ineligibility_reason: 'Promotion exclusion: explicitly excluded by mall policy terms.',
  },
  {
    name: 'Epic Swim',
    slug: slugify('Epic Swim'),
    category: 'Learn',
    level: 'L7',
    unit: '#07-01',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Global Art',
    slug: slugify('Global Art'),
    category: 'Learn',
    level: 'L1',
    unit: '#01-02',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Gofit',
    slug: slugify('Gofit'),
    category: 'Relax',
    level: 'L6',
    unit: '#06-06/07/08',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'GynaeMD Women\'s Clinic',
    slug: slugify('GynaeMD Women\'s Clinic'),
    category: 'Services',
    level: 'L1',
    unit: '#01-05',
    is_active: false,
    is_eligible: false,
    ineligibility_reason: 'Promotion exclusion: explicitly excluded by mall policy terms.',
  },
  {
    name: 'Huang Tu Di Xi\'An Delights',
    slug: slugify('Huang Tu Di Xi\'An Delights'),
    category: 'Dine',
    level: 'L2',
    unit: '#02-08',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Indian Barber Shop',
    slug: slugify('Indian Barber Shop'),
    category: 'Services',
    level: 'L1',
    unit: '#01-K1',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Ji De Chi',
    slug: slugify('Ji De Chi'),
    category: 'Dine',
    level: 'L2',
    unit: '#02-01',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Kumar Mess',
    slug: slugify('Kumar Mess'),
    category: 'Dine',
    level: 'L1',
    unit: '#01-01',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'OCD Mala Hotpot',
    slug: slugify('OCD Mala Hotpot'),
    category: 'Dine',
    level: 'L1',
    unit: '#01-09,10,11',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'One Spine Chiropractic',
    slug: slugify('One Spine Chiropractic'),
    category: 'Services',
    level: 'L2',
    unit: '#02-04',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Q & M Dental Surgery',
    slug: slugify('Q & M Dental Surgery'),
    category: 'Services',
    level: 'L2',
    unit: '#02-02',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Roof top playground',
    slug: slugify('Roof top playground'),
    category: 'Services',
    level: 'L7',
    unit: 'L7',
    is_active: false,
    is_eligible: false,
    ineligibility_reason: 'Facility exclusion: mall amenity, not a commercial store.',
  },
  {
    name: 'Saizeriya',
    slug: slugify('Saizeriya'),
    category: 'Dine',
    level: 'L2',
    unit: '#02-05/06/07',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Shanghai Tan Pan-Fried Buns',
    slug: slugify('Shanghai Tan Pan-Fried Buns'),
    category: 'Dine',
    level: 'L1',
    unit: '#01-12',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Siam Square Mookata',
    slug: slugify('Siam Square Mookata'),
    category: 'Dine',
    level: 'L3',
    unit: '#03-01',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Spacio TCM Wellness',
    slug: slugify('Spacio TCM Wellness'),
    category: 'Services',
    level: 'L1',
    unit: '#01-03/04',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Think Academy',
    slug: slugify('Think Academy'),
    category: 'Learn',
    level: 'L6',
    unit: '#06-01,02,03,04,05',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Wang Learning Centre',
    slug: slugify('Wang Learning Centre'),
    category: 'Learn',
    level: 'L3',
    unit: '#03-01A, #03-01B',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
  {
    name: 'Western Union',
    slug: slugify('Western Union'),
    category: 'Services',
    level: 'L1',
    unit: '#01-13',
    is_active: false,
    is_eligible: false,
    ineligibility_reason: 'Promotion exclusion: remittance/money changer excluded under terms.',
  },
  {
    name: 'Yan\'s Tomato Hot Pot',
    slug: slugify('Yan\'s Tomato Hot Pot'),
    category: 'Dine',
    level: 'L2',
    unit: '#02-10',
    is_active: true,
    is_eligible: true,
    ineligibility_reason: null,
  },
];