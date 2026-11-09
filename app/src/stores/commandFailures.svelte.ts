import { CommandFailures, type CommandFailure } from '../lib/commandFailures';

// App-wide, not per map pane: both panes command the same Signal K server, so
// a success in one pane must supersede a failure from the other, and a pane
// unmounting (split collapsed) must not drop a failure still in flight.
const tracker = new CommandFailures();
let failures = $state<readonly CommandFailure[]>([]);

export const commandFailures = {
  get list(): readonly CommandFailure[] { return failures; },
  dismiss(target: string): void {
    tracker.dismiss(target);
    failures = tracker.failures;
  },
};

/**
 * Run a Signal K command whose rejection must be visible to the crew.
 * `target` names the server state it writes (see CommandFailures); `null`
 * when nothing supersedes it (creating a new resource).
 */
export function runCommand(action: string, target: string | null, command: Promise<unknown>): void {
  const ticket = tracker.begin(target);
  command.then(
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
}
