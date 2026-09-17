/**
 * 321 Clementi Parking Barcode - In-Memory Rate Limiter
 * Per ADR-001: 10 history queries/min/IP, 5 distinct plates/hr/IP,
 * 3 unclaim attempts/plate/day, 60s cooldown between unclaims.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface PlateRateLimitEntry {
  count: number;
  plates: Set<string>;
  resetAt: number;
}

const historyBuckets = new Map<string, RateLimitEntry>();  // IP → bucket
const plateLookupBuckets = new Map<string, PlateRateLimitEntry>(); // IP → plates seen
const unclaimBuckets = new Map<string, RateLimitEntry>();  // plate → bucket
const unclaimCooldowns = new Map<string, number>();         // redemption_id → next allowed time

const MAX_HISTORY_PER_MINUTE = 10;
const MAX_DISTINCT_PLATES_PER_HOUR = 5;
const MAX_UNCLAIM_PER_PLATE_PER_DAY = 3;
const UNCLAIM_COOLDOWN_MS = 60_000;

function pruneExpired(map: Map<string, RateLimitEntry>) {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now > entry.resetAt) {
      map.delete(key);
    }
  }
}

function prunePlateBuckets() {
  const now = Date.now();
  for (const [key, entry] of plateLookupBuckets) {
    if (now > entry.resetAt) {
      plateLookupBuckets.delete(key);
    }
  }
}

// --- History endpoint rate limiting ---

export function checkHistoryRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
  pruneExpired(historyBuckets);
  
  const now = Date.now();
  const bucket = historyBuckets.get(ip);
  
  if (!bucket || now > bucket.resetAt) {
    historyBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return { allowed: true };
  }
  
  if (bucket.count >= MAX_HISTORY_PER_MINUTE) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  
  bucket.count++;
  return { allowed: true };
}

// --- Distinct plate lookup rate limiting ---

export function checkPlateHistoryScanLimit(ip: string, plate: string): { allowed: boolean; retryAfterMs?: number } {
  prunePlateBuckets();
  
  const now = Date.now();
  let bucket = plateLookupBuckets.get(ip);
  
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 1, plates: new Set([plate]), resetAt: now + 3_600_000 };
    plateLookupBuckets.set(ip, bucket);
    return { allowed: true };
  }
  
  if (!bucket.plates.has(plate)) {
    if (bucket.plates.size >= MAX_DISTINCT_PLATES_PER_HOUR) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    bucket.plates.add(plate);
  }
  
  bucket.count++;
  return { allowed: true };
}

// --- Unclaim rate limiting ---

export function checkUnclaimRateLimit(plate: string): { allowed: boolean; retryAfterMs?: number } {
  pruneExpired(unclaimBuckets);
  
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const resetAt = todayStart.getTime() + 86_400_000; // midnight
  
  const bucket = unclaimBuckets.get(plate);
  
  if (!bucket || now > bucket.resetAt) {
    unclaimBuckets.set(plate, { count: 1, resetAt });
    return { allowed: true };
  }
  
  if (bucket.count >= MAX_UNCLAIM_PER_PLATE_PER_DAY) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }
  
  bucket.count++;
  return { allowed: true };
}

export function checkUnclaimCooldown(redemptionId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const cooldownUntil = unclaimCooldowns.get(redemptionId);
  
  if (cooldownUntil && now < cooldownUntil) {
    return { allowed: false, retryAfterMs: cooldownUntil - now };
  }
  
  unclaimCooldowns.set(redemptionId, now + UNCLAIM_COOLDOWN_MS);
  return { allowed: true };
}

// --- Get client IP from request ---

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return '127.0.0.1';
}