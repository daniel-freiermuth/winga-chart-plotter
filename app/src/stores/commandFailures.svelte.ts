import { CommandFailures, type CommandFailure } from '../lib/commandFailures';

// App-wide, not per map pane: both panes command the same Signal K server, so
// a success in one pane must supersede a failure from the other, and a pane
// unmounting (split collapsed) must not drop a failure still in flight.
const tracker = new CommandFailures();
let failures = $state<readonly CommandFailure[]>([]);
/**
 * Per target: settles once every command on it issued so far has settled.
 * Read only by async callers, never rendered — must not be reactive.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const settling = new Map<string, Promise<unknown>>();

export const commandFailures = {
  get list(): readonly CommandFailure[] { return failures; },
  dismiss(target: string): void {
    tracker.dismiss(target);
    failures = tracker.failures;
  },
  /** A point in the command order, for `succeededSince`. */
  mark(): number { return tracker.mark(); },
  /** True if a command on `target` issued after `mark` was taken has succeeded. */
  succeededSince(target: string, mark: number): boolean { return tracker.succeededSince(target, mark); },
  /**
   * Resolves once no command on `target` is pending — including commands
   * issued while waiting — and every outcome is recorded.
   */
  async settled(target: string): Promise<void> {
    for (let pending = settling.get(target); pending; pending = settling.get(target)) await pending;
  },
};

/**
 * Run a Signal K command whose rejection must be visible to the crew.
 * `target` names the server state it writes (see CommandFailures); `null`
 * when nothing supersedes it (creating a new resource).
 */
export function runCommand(action: string, target: string | null, command: Promise<unknown>): void {
  const ticket = tracker.begin(target);
  const recorded = command.then(
    () => {
      tracker.succeeded(ticket);
      failures = tracker.failures;
    },
    (err: unknown) => {
      console.error(`[command] ${action} failed:`, err);
      tracker.failed(ticket, action, String(err));
      failures = tracker.failures;
    },
  );
  if (target === null) return;
  const all = Promise.all([settling.get(target), recorded]);
  settling.set(target, all);
  void all.then(() => { if (settling.get(target) === all) settling.delete(target); });
}
