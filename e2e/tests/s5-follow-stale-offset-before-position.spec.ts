/**
 * S5 — PR #31: follow mode left on from a previous session survives a restart
 * where Signal K hasn't sent a position fix yet.
 *
 * `follow-mode-offset` is persisted in localStorage, so `followMode.following`
 * can read true on load with `vesselState.position` still null (server
 * restarted, not reconnected yet). Two regressions this covers:
 *
 * 1. Manual pan (moveend) must treat "no position to anchor to" as an
 *    unambiguous stop-following gesture — otherwise the stale offset survives
 *    and the first fix that arrives later silently snaps the camera back to
 *    the vessel, discarding wherever the user panned to.
 * 2. The two-finger pinch handler must NOT write `followMode.offset = null`
 *    synchronously from inside `pointermove` when there's no position: that
 *    write invalidates the effect that owns the pinch listeners (it's keyed
 *    on `followMode.following`), tearing them down mid-gesture and killing
 *    the pinch after its first frame.
 */
import { test, expect } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, VIEW } from '../lib/app';

const WAITING_TITLE = 'Following — waiting for a vessel position fix';

test('manual pan with no position fix drops follow and the camera does not snap back', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);
    // Follow was left on from a previous session; this run's SK server
    // hasn't sent a position yet.
    await page.addInitScript(() => {
      localStorage.setItem('follow-mode-offset', JSON.stringify({ left: 0, top: 0 }));
    });

    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });

    // Pane chrome: compass (0) → follow pin (1) → layers.
    const followBtn = page.locator('.nav-stack button.nav-fab').nth(1);
    await expect(followBtn).toHaveAttribute('title', WAITING_TITLE);

    const canvas = page.locator('.maplibregl-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('map canvas not laid out');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Manual drag pan — the "I want to look elsewhere" gesture.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 150, cy - 80, { steps: 10 });
    await page.mouse.up();

    // Nothing to anchor to → pan is treated as an explicit "stop following".
    await expect(followBtn).toHaveAttribute('title', 'Follow vessel');

    const afterPan = await page.evaluate(() => localStorage.getItem('map-view-coords'));

    // First position fix now arrives, far from wherever the user panned to.
    mock.ownNav({ lon: VIEW.lon + 1, lat: VIEW.lat + 1, cogRad: 0, sogMs: 0 });
    await page.waitForTimeout(1500);

    // INTENDED: camera stays exactly where the user left it.
    // Regression (stale offset never cleared): the fix silently re-engages
    // follow's recentring effect and the camera snaps to the vessel.
    const afterFix = await page.evaluate(() => localStorage.getItem('map-view-coords'));
    expect(afterFix).toBe(afterPan);
  } finally {
    await mock.stop();
  }
});

test('pinch zoom with no position fix keeps responding across multiple move frames', async ({ page }) => {
  const mock = new MockSignalK();
  const port = await mock.start();

  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);
    await page.addInitScript(() => {
      localStorage.setItem('follow-mode-offset', JSON.stringify({ left: 0, top: 0 }));
    });

    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', 'rgb(74, 222, 128)', { timeout: 20_000 });

    const followBtn = page.locator('.nav-stack button.nav-fab').nth(1);
    await expect(followBtn).toHaveAttribute('title', WAITING_TITLE);

    // Dispatch synthetic two-finger touch PointerEvents directly on the
    // MapLibre canvas — exercises the app's own pinch handler (registered
    // because followMode.following is true) without depending on flaky
    // platform touch-gesture synthesis. Each step is a separate page.evaluate
    // round trip so Svelte's reactivity actually flushes between frames,
    // exactly like real, separately-dispatched touch events would.
    const dispatchTouch = async (
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      id: number,
      x: number,
      y: number,
    ) => {
      await page.evaluate(
        ({ type: t, id: pid, x: px, y: py }) => {
          const canvas = document.querySelector('.maplibregl-canvas');
          if (!canvas) throw new Error('no maplibre canvas');
          canvas.dispatchEvent(new PointerEvent(t, {
            pointerId: pid, pointerType: 'touch', clientX: px, clientY: py, bubbles: true,
          }));
        },
        { type, id, x, y },
      );
    };

    const readZoom = async (): Promise<number> => {
      const raw = await page.evaluate(() => localStorage.getItem('map-view-coords'));
      if (!raw) throw new Error('map-view-coords not persisted yet');
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || !('zoom' in parsed) || typeof parsed.zoom !== 'number') {
        throw new Error('map-view-coords: unexpected shape');
      }
      return parsed.zoom;
    };

    const zoomBefore = await readZoom();

    await dispatchTouch('pointerdown', 1, 380, 300);
    await dispatchTouch('pointerdown', 2, 420, 300);
    // Baseline frame: primes prevDist, no zoom applied yet.
    await dispatchTouch('pointermove', 1, 385, 300);
    await page.waitForTimeout(50);

    // Frame A: fingers spread apart → zoom in.
    await dispatchTouch('pointermove', 1, 340, 300);
    await page.waitForTimeout(200);
    const zoomA = await readZoom();

    // Frame B: fingers spread further. If the offset write in frame A tore
    // down the pinch listeners, this event is dropped and zoom stalls.
    await dispatchTouch('pointermove', 2, 460, 300);
    await page.waitForTimeout(200);
    const zoomB = await readZoom();

    await dispatchTouch('pointerup', 1, 340, 300);
    await dispatchTouch('pointerup', 2, 460, 300);

    expect(zoomA).toBeGreaterThan(zoomBefore + 0.05);
    // The gesture must still be live for frame B — this is the actual
    // regression: on unfixed code zoomB stays ~= zoomA.
    expect(zoomB).toBeGreaterThan(zoomA + 0.05);

    // Gesture fully ended with no position throughout → follow drops once
    // cleanup runs, deferred past the live gesture.
    await expect(followBtn).toHaveAttribute('title', 'Follow vessel');
  } finally {
    await mock.stop();
  }
});
