/**
 * 321 Clementi Smart Parking Redemption Engine
 * Cryptographic Utilities Tests (PAN-77 / ADR-001)
 * 
 * Verifies claim token generation, SHA-256 hashing, and verification.
 */

import { describe, test, expect } from 'bun:test';
import { generateClaimToken, sha256, verifyClaimToken } from '../src/utils/crypto';

describe('Cryptographic Utilities (PAN-77)', () => {

  describe('generateClaimToken', () => {
    test('Generates a token with "ct_" prefix', () => {
      const token = generateClaimToken();
      expect(token.startsWith('ct_')).toBe(true);
    });

    test('Generates a 48-character hex token (ct_ + 46 hex chars)', () => {
      const token = generateClaimToken();
      expect(token.length).toBe(51); // 'ct_' + 48 hex = 51
      expect(token.slice(3)).toMatch(/^[0-9a-f]{48}$/);
    });

    test('Multiple calls generate unique tokens', () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateClaimToken());
      }
      expect(tokens.size).toBe(100); // No collisions in 100 generations
    });

    test('Tokens have sufficient entropy (24 random bytes)', () => {
      // 24 bytes = 192 bits of entropy
      const token = generateClaimToken();
      const hexPart = token.slice(3);
      // 24 bytes → 48 hex chars
      expect(hexPart.length).toBe(48);
    });
  });

  describe('sha256', () => {
    test('Hashes a string and returns 64 hex characters', async () => {
      const hash = await sha256('test');
      expect(hash.length).toBe(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('Same input produces identical hash', async () => {
      const hash1 = await sha256('SBA1234A');
      const hash2 = await sha256('SBA1234A');
      expect(hash1).toBe(hash2);
    });

    test('Different inputs produce different hashes', async () => {
      const hash1 = await sha256('SBA1234A');
      const hash2 = await sha256('SBA1234B');
      expect(hash1).not.toBe(hash2);
    });

    test('Empty string hashes correctly', async () => {
      const hash = await sha256('');
      expect(hash.length).toBe(64);
    });
  });

  describe('verifyClaimToken', () => {
    test('Verifies a valid token against its stored hash', async () => {
      const token = generateClaimToken();
      const hash = await sha256(token);
      const valid = await verifyClaimToken(token, hash);
      expect(valid).toBe(true);
    });

    test('Rejects a wrong token against a stored hash', async () => {
      const token = generateClaimToken();
      const hash = await sha256(token);
      const wrongToken = generateClaimToken();
      const valid = await verifyClaimToken(wrongToken, hash);
      expect(valid).toBe(false);
    });

    test('Rejects verification against null hash', async () => {
      const token = generateClaimToken();
      const valid = await verifyClaimToken(token, null);
      expect(valid).toBe(false);
    });

    test('Rejects verification against empty string hash', async () => {
      const token = generateClaimToken();
      const valid = await verifyClaimToken(token, '');
      expect(valid).toBe(false);
    });

    test('Case-sensitive verification', async () => {
      const token = generateClaimToken();
      const hash = await sha256(token);
      // Tokens are lowercase hex; modify case and it should fail
      const modifiedToken = token.toUpperCase();
      const valid = await verifyClaimToken(modifiedToken, hash);
      expect(valid).toBe(false);
    });
  });

  describe('End-to-end: claim → store → verify', () => {
    test('Full claim token lifecycle', async () => {
      // Simulate the redemption flow
      const token = generateClaimToken();
      const storedHash = await sha256(token);

      // Later, client sends token back
      const isValid = await verifyClaimToken(token, storedHash);
      expect(isValid).toBe(true);

      // Attacker tries random token
      const attackerToken = generateClaimToken();
      const isAttackerValid = await verifyClaimToken(attackerToken, storedHash);
      expect(isAttackerValid).toBe(false);
    });
  });
});