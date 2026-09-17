/**
 * 321 Clementi Parking Barcode - Cryptographic Utilities
 * SHA-256 claim token generation & verification per ADR-001.
 */

export function generateClaimToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `ct_${hex}`;
}

export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyClaimToken(
  token: string,
  storedHash: string | null
): Promise<boolean> {
  if (!storedHash) return false;
  const hash = await sha256(token);
  return hash === storedHash;
}