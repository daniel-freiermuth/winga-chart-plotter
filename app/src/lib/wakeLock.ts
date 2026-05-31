/**
 * Screen Wake Lock — prevents the display from dimming or turning off.
 *
 * The lock is automatically released by the browser when the page becomes
 * hidden (e.g. tab switched, screen off). We re-acquire it on `visibilitychange`
 * so it is held again when the user returns.
 *
 * Call `acquireWakeLock()` once on mount; call `releaseWakeLock()` on destroy.
 */

let sentinel: WakeLockSentinel | null = null;
let enabled = false;

async function acquire(): Promise<void> {
  if (!enabled) return;
  if (!('wakeLock' in navigator)) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
  } catch {
    // Permission denied or API unavailable — silently ignore.
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void acquire();
}

export async function acquireWakeLock(): Promise<void> {
  enabled = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  await acquire();
}

export function releaseWakeLock(): void {
  enabled = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  void sentinel?.release();
  sentinel = null;
}
