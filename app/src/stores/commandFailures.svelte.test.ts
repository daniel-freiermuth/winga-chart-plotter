import { describe, expect, it, vi } from 'vitest';
import { commandFailures, runCommand } from './commandFailures.svelte';

/** Let pending promise reactions run (they chain a few microtasks deep). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('commandFailures.settled', () => {
  it('also waits for a command on the target issued while it is waiting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const target = 'course:settled-during-wait';
    const mark = commandFailures.mark();
    const first = Promise.withResolvers<undefined>();
    runCommand('Clear course', target, first.promise);
    let done = false;
    const waiting = commandFailures.settled(target).then(() => { done = true; });

    const second = Promise.withResolvers<undefined>();
    runCommand('Clear course', target, second.promise);
    first.reject(new Error('404'));
    await flushMicrotasks();
    expect(done).toBe(false);

    second.resolve(undefined);
    await waiting;
    expect(commandFailures.succeededSince(target, mark)).toBe(true);
  });
});
