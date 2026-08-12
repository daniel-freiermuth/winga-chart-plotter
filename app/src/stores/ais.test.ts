import { afterEach, describe, expect, it, vi } from 'vitest';
import { ais } from './ais.svelte';

// Each test starts with a clean selection.
afterEach(() => { ais.clear(); });

describe('popup ownership lifecycle', () => {
  it('claimPopup disposes the prior callback when a new one is registered', () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    ais.claimPopup(disposeA);
    ais.claimPopup(disposeB);
    expect(disposeA).toHaveBeenCalledOnce();
    expect(disposeB).not.toHaveBeenCalled();
  });

  it('clear() invokes the current dispose and resets selection', () => {
    const dispose = vi.fn();
    ais.highlight('v1');
    ais.elevateToPopup();
    ais.claimPopup(dispose);

    ais.clear();

    expect(dispose).toHaveBeenCalledOnce();
    expect(ais.selectedId).toBeNull();
    expect(ais.selectionPhase).toBeNull();
  });

  it('clear() after releasePopup does not invoke a stale dispose', () => {
    const dispose = vi.fn();
    ais.highlight('v1');
    ais.claimPopup(dispose);

    // Simulate user-initiated close: component calls releasePopup before clear.
    ais.releasePopup();
    ais.clear();

    // The dispose was detached — clear must not invoke it.
    expect(dispose).not.toHaveBeenCalled();
    expect(ais.selectedId).toBeNull();
  });

  it('highlight(differentId) disposes the popup and preserves new selection', () => {
    const dispose = vi.fn();
    ais.highlight('v1');
    ais.elevateToPopup();
    ais.claimPopup(dispose);

    ais.highlight('v2');

    expect(dispose).toHaveBeenCalledOnce();
    expect(ais.selectedId).toBe('v2');
    expect(ais.selectionPhase).toBe('highlighted');
  });

  it('highlight(sameId) does not dispose (re-clicking same vessel)', () => {
    const dispose = vi.fn();
    ais.highlight('v1');
    ais.claimPopup(dispose);

    ais.highlight('v1');

    expect(dispose).not.toHaveBeenCalled();
    expect(ais.selectedId).toBe('v1');
  });

  it('highlight(sameId) disposes when selectionPhase is popup (cross-pane tap)', () => {
    const dispose = vi.fn();
    ais.highlight('v1');
    ais.elevateToPopup();
    ais.claimPopup(dispose);
    expect(ais.selectionPhase).toBe('popup');

    // Simulate tapping the same vessel in the other pane: highlight(sameId)
    // while a popup is live. The popup must be disposed.
    ais.highlight('v1');

    expect(dispose).toHaveBeenCalledOnce();
    expect(ais.selectedId).toBe('v1');
    expect(ais.selectionPhase).toBe('highlighted');
  });
});
