/**
 * 321 Clementi Smart Parking Redemption Engine
 * Screen Wake Lock Manager (ADR-001 §6.6.2 / PAN-75 / PAN-82)
 *
 * Keeps the shopper's device display awake while the enlarged barcode modal
 * is active at the carpark exit gantry scanner.
 * Auto-releases on dismiss and handles tab visibilitychange cycles.
 */

export interface WakeLockManager {
  acquire: () => Promise<boolean>;
  release: () => Promise<boolean>;
  isActive: () => boolean;
  handleVisibilityChange: (isModalOpen: boolean) => Promise<boolean>;
  getSentinel: () => WakeLockSentinel | null;
}

export function createWakeLockManager(
  getNav: () => Navigator | undefined = () => (typeof navigator !== 'undefined' ? navigator : undefined),
  getDoc: () => Document | { visibilityState: DocumentVisibilityState } | undefined = () =>
    typeof document !== 'undefined' ? document : undefined,
  onStateChange?: (active: boolean) => void
): WakeLockManager {
  let sentinel: WakeLockSentinel | null = null;

  async function acquire(): Promise<boolean> {
    const nav = getNav();
    if (!nav || !('wakeLock' in nav)) {
      return false;
    }

    if (sentinel && !sentinel.released) {
      return true;
    }

    try {
      const lock = await nav.wakeLock.request('screen');
      sentinel = lock;
      onStateChange?.(true);

      lock.addEventListener('release', () => {
        if (sentinel === lock) {
          sentinel = null;
          onStateChange?.(false);
        }
      });
      return true;
    } catch {
      // Screen wake lock is optional/best-effort (e.g. low battery, denied OS permissions)
      sentinel = null;
      onStateChange?.(false);
      return false;
    }
  }

  async function release(): Promise<boolean> {
    if (!sentinel) {
      return false;
    }

    try {
      const current = sentinel;
      sentinel = null;
      await current.release();
      onStateChange?.(false);
      return true;
    } catch {
      sentinel = null;
      onStateChange?.(false);
      return false;
    }
  }

  function isActive(): boolean {
    return sentinel !== null && !sentinel.released;
  }

  async function handleVisibilityChange(isModalOpen: boolean): Promise<boolean> {
    const doc = getDoc();
    const isVisible = doc ? doc.visibilityState === 'visible' : true;

    if (isVisible && isModalOpen) {
      return await acquire();
    }
    return false;
  }

  return {
    acquire,
    release,
    isActive,
    handleVisibilityChange,
    getSentinel: () => sentinel,
  };
}
