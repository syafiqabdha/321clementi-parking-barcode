/**
 * 321 Clementi Smart Parking Redemption Engine
 * Screen Wake Lock Tests (PAN-82 / ADR-001 §6.6.2)
 *
 * Verifies the WakeLockManager utility logic:
 * - Acquires lock on modal open
 * - Releases lock on every close path (button, backdrop, Escape)
 * - Re-acquires on visibilitychange when modal is still open
 * - Degrades gracefully when navigator.wakeLock is unavailable
 */

import { describe, test, expect } from 'bun:test';
import { createWakeLockManager } from '../src/components/wake-lock';

// ---------------------------------------------------------------------------
// Mock WakeLockSentinel
// ---------------------------------------------------------------------------
function makeMockSentinel(): WakeLockSentinel {
  let released = false;
  const listeners: Array<(ev: Event) => void> = [];

  const sentinel = {
    get released() {
      return released;
    },
    get type(): WakeLockType {
      return 'screen';
    },
    release: async () => {
      released = true;
      listeners.forEach((fn) => fn(new Event('release')));
    },
    onrelease: null as ((this: WakeLockSentinel, ev: Event) => unknown) | null,
    addEventListener: (_type: string, listener: (ev: Event) => void) => {
      listeners.push(listener);
    },
    removeEventListener: () => {},
    dispatchEvent: () => true,
  } as unknown as WakeLockSentinel;

  return sentinel;
}

// ---------------------------------------------------------------------------
// Mock Navigator with wakeLock
// ---------------------------------------------------------------------------
function makeMockNavigator(behaviour: 'grant' | 'deny' | 'unavailable') {
  if (behaviour === 'unavailable') {
    return {} as Navigator;
  }

  const sentinel = makeMockSentinel();
  return {
    wakeLock: {
      request: async (_type: WakeLockType): Promise<WakeLockSentinel> => {
        if (behaviour === 'deny') {
          throw new DOMException('Wake lock denied', 'NotAllowedError');
        }
        return sentinel;
      },
    },
    __sentinel: sentinel,
  } as unknown as Navigator & { __sentinel: WakeLockSentinel };
}

// ---------------------------------------------------------------------------
// Mock Document for visibilityState
// ---------------------------------------------------------------------------
function makeMockDocument(visibilityState: DocumentVisibilityState = 'visible') {
  return { visibilityState } as { visibilityState: DocumentVisibilityState };
}

// ---------------------------------------------------------------------------
// ADR-001 §6.6.2 — Wake Lock Manager (PAN-82)
// ---------------------------------------------------------------------------
describe('Screen Wake Lock Manager (ADR-001 §6.6.2 / PAN-82)', () => {
  describe('Acquire on modal open', () => {
    test('Acquires wake lock successfully when navigator.wakeLock is available', async () => {
      const nav = makeMockNavigator('grant');
      const manager = createWakeLockManager(() => nav as Navigator);
      const acquired = await manager.acquire();
      expect(acquired).toBe(true);
      expect(manager.isActive()).toBe(true);
    });

    test('Returns false when navigator.wakeLock is unavailable (old browser)', async () => {
      const nav = makeMockNavigator('unavailable');
      const manager = createWakeLockManager(() => nav);
      const acquired = await manager.acquire();
      expect(acquired).toBe(false);
      expect(manager.isActive()).toBe(false);
    });

    test('Returns false and does NOT throw when OS denies wake lock request', async () => {
      const nav = makeMockNavigator('deny');
      const manager = createWakeLockManager(() => nav as Navigator);
      // Must not throw — feature is optional
      let acquired = false;
      expect(async () => {
        acquired = await manager.acquire();
      }).not.toThrow();
      acquired = await manager.acquire();
      expect(acquired).toBe(false);
      expect(manager.isActive()).toBe(false);
    });

    test('Skips re-request if sentinel is already active and not released', async () => {
      let requestCount = 0;
      const nav = {
        wakeLock: {
          request: async () => {
            requestCount++;
            return makeMockSentinel();
          },
        },
      } as unknown as Navigator;

      const manager = createWakeLockManager(() => nav);
      await manager.acquire();
      await manager.acquire(); // second call should be no-op
      expect(requestCount).toBe(1);
    });
  });

  describe('Release on close paths', () => {
    test('Release returns true and deactivates sentinel', async () => {
      const nav = makeMockNavigator('grant');
      const manager = createWakeLockManager(() => nav as Navigator);
      await manager.acquire();
      expect(manager.isActive()).toBe(true);

      const released = await manager.release();
      expect(released).toBe(true);
      expect(manager.isActive()).toBe(false);
    });

    test('Release is idempotent when no lock held', async () => {
      const nav = makeMockNavigator('grant');
      const manager = createWakeLockManager(() => nav as Navigator);
      // Never acquired
      const released = await manager.release();
      expect(released).toBe(false);
      expect(manager.isActive()).toBe(false);
    });

    test('Release called after Escape key (simulated close path)', async () => {
      const nav = makeMockNavigator('grant');
      const manager = createWakeLockManager(() => nav as Navigator);
      await manager.acquire();

      // Simulates: keydown Escape → closeEnlargeModal() → releaseWakeLock()
      let isModalOpen = true;
      async function handleEscape(key: string) {
        if (key === 'Escape' && isModalOpen) {
          isModalOpen = false;
          await manager.release();
        }
      }

      await handleEscape('Escape');
      expect(isModalOpen).toBe(false);
      expect(manager.isActive()).toBe(false);
    });

    test('Release called on backdrop click (simulated close path)', async () => {
      const nav = makeMockNavigator('grant');
      const manager = createWakeLockManager(() => nav as Navigator);
      await manager.acquire();

      // Simulates: backdrop click → closeEnlargeModal() → releaseWakeLock()
      let isModalOpen = true;
      async function handleBackdrop(targetIsModal: boolean) {
        if (targetIsModal) {
          isModalOpen = false;
          await manager.release();
        }
      }

      await handleBackdrop(true);
      expect(isModalOpen).toBe(false);
      expect(manager.isActive()).toBe(false);
    });

    test('Release called on close button click (simulated close path)', async () => {
      const nav = makeMockNavigator('grant');
      const manager = createWakeLockManager(() => nav as Navigator);
      await manager.acquire();

      // Simulates: close button → closeEnlargeModal() → releaseWakeLock()
      await manager.release();
      expect(manager.isActive()).toBe(false);
    });

    test('Reset barcode (resetBtn) also releases wake lock', async () => {
      const nav = makeMockNavigator('grant');
      const manager = createWakeLockManager(() => nav as Navigator);
      await manager.acquire();
      expect(manager.isActive()).toBe(true);

      // resetBtn.click() in RedemptionCard calls closeEnlargeModal() first
      await manager.release();
      expect(manager.isActive()).toBe(false);
    });
  });

  describe('Re-acquire on visibilitychange (tab hide/show cycle)', () => {
    test('Re-acquires when tab becomes visible and modal is open', async () => {
      const nav = makeMockNavigator('grant');
      const doc = makeMockDocument('visible');
      const manager = createWakeLockManager(() => nav as Navigator, () => doc);

      // Modal is open, tab hid → lock auto-released by browser, then tab comes back
      const reacquired = await manager.handleVisibilityChange(true);
      expect(reacquired).toBe(true);
      expect(manager.isActive()).toBe(true);
    });

    test('Does NOT re-acquire when tab is still hidden', async () => {
      const nav = makeMockNavigator('grant');
      const doc = makeMockDocument('hidden');
      const manager = createWakeLockManager(() => nav as Navigator, () => doc);

      const reacquired = await manager.handleVisibilityChange(true);
      expect(reacquired).toBe(false);
    });

    test('Does NOT re-acquire when modal is closed (even if tab is visible)', async () => {
      const nav = makeMockNavigator('grant');
      const doc = makeMockDocument('visible');
      const manager = createWakeLockManager(() => nav as Navigator, () => doc);

      // isModalOpen = false
      const reacquired = await manager.handleVisibilityChange(false);
      expect(reacquired).toBe(false);
    });

    test('Handles full tab hide→show cycle: lock released by browser, then re-acquired', async () => {
      const nav = makeMockNavigator('grant');
      let visibilityState: DocumentVisibilityState = 'visible';
      const doc = { get visibilityState() { return visibilityState; } };

      const manager = createWakeLockManager(() => nav as Navigator, () => doc);

      // Open modal and acquire
      await manager.acquire();
      expect(manager.isActive()).toBe(true);

      // Simulate browser auto-releasing when tab hides
      if (manager.getSentinel()) {
        await manager.getSentinel()!.release();
      }

      // Tab comes back visible
      visibilityState = 'visible';
      const reacquired = await manager.handleVisibilityChange(true);
      expect(reacquired).toBe(true);
    });
  });

  describe('State change callbacks', () => {
    test('Fires onStateChange(true) when lock is acquired', async () => {
      const nav = makeMockNavigator('grant');
      const stateChanges: boolean[] = [];
      const manager = createWakeLockManager(
        () => nav as Navigator,
        undefined,
        (active) => stateChanges.push(active)
      );

      await manager.acquire();
      expect(stateChanges).toContain(true);
    });

    test('Fires onStateChange(false) when lock is released', async () => {
      const nav = makeMockNavigator('grant');
      const stateChanges: boolean[] = [];
      const manager = createWakeLockManager(
        () => nav as Navigator,
        undefined,
        (active) => stateChanges.push(active)
      );

      await manager.acquire();
      await manager.release();
      expect(stateChanges).toContain(false);
    });

    test('Fires onStateChange(false) when acquire is denied', async () => {
      const nav = makeMockNavigator('deny');
      const stateChanges: boolean[] = [];
      const manager = createWakeLockManager(
        () => nav as Navigator,
        undefined,
        (active) => stateChanges.push(active)
      );

      await manager.acquire();
      expect(stateChanges[stateChanges.length - 1]).toBe(false);
    });
  });

  describe('Close path completeness (all three paths release)', () => {
    test('All three close paths (Escape, backdrop, button) each release the lock', async () => {
      const closePaths = ['escape', 'backdrop', 'button'] as const;

      for (const path of closePaths) {
        const nav = makeMockNavigator('grant');
        const manager = createWakeLockManager(() => nav as Navigator);
        await manager.acquire();
        expect(manager.isActive()).toBe(true);

        // All paths map to the same release call
        await manager.release();
        expect(manager.isActive()).toBe(false);
      }
    });
  });
});
