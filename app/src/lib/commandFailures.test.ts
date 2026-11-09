import { describe, expect, it } from 'vitest';
import { CommandFailures } from './commandFailures';

const actions = (t: CommandFailures) => t.failures.map(f => f.action);

describe('CommandFailures', () => {
  it('keeps an earlier slow failure on another target next to a later one', () => {
    const t = new CommandFailures();
    const clear = t.begin('course');
    const del = t.begin('waypoint:X');
    t.failed(del, 'Delete waypoint', '404');
    t.failed(clear, 'Clear course', 'timeout');
    expect(actions(t)).toEqual(['Delete waypoint', 'Clear course']);
  });

  it('does not let a success on another target clear a failure', () => {
    const t = new CommandFailures();
    t.failed(t.begin('waypoint-name:X'), 'Rename waypoint', '404');
    t.succeeded(t.begin('waypoint-name:Y'));
    expect(actions(t)).toEqual(['Rename waypoint']);
  });

  it('clears a failure when a later command on the same target succeeds', () => {
    const t = new CommandFailures();
    t.failed(t.begin('course'), 'Clear course', '401');
    t.succeeded(t.begin('course'));
    expect(t.failures).toEqual([]);
  });

  it('ignores a superseded command on the same target, whichever way it settles', () => {
    const t = new CommandFailures();
    const older = t.begin('course');
    const newer = t.begin('course');
    t.failed(newer, 'Navigate here', '500');
    t.succeeded(older);
    expect(actions(t)).toEqual(['Navigate here']);

    const t2 = new CommandFailures();
    const older2 = t2.begin('course');
    const newer2 = t2.begin('course');
    t2.succeeded(newer2);
    t2.failed(older2, 'Clear course', '500');
    expect(t2.failures).toEqual([]);
  });

  it('replaces a failure on the same target with the newer one', () => {
    const t = new CommandFailures();
    t.failed(t.begin('course'), 'Clear course', '401');
    t.failed(t.begin('course'), 'Navigate here', '403');
    expect(t.failures).toEqual([{ target: 'course', action: 'Navigate here', detail: '403' }]);
  });

  it('never supersedes target-less commands', () => {
    const t = new CommandFailures();
    t.failed(t.begin(null), 'Add waypoint', '500');
    t.failed(t.begin(null), 'Add waypoint', '404');
    t.succeeded(t.begin(null));
    expect(actions(t)).toEqual(['Add waypoint', 'Add waypoint']);
  });

  it('dismiss removes only that target', () => {
    const t = new CommandFailures();
    t.failed(t.begin('course'), 'Clear course', '401');
    t.failed(t.begin('route:R'), 'Delete route', '404');
    t.dismiss('course');
    expect(actions(t)).toEqual(['Delete route']);
  });
});
