/**
 * Outcome tracking for Signal K commands sent from map popups — pure, no runes.
 *
 * Every command names the server state it writes (`target`): the course, or
 * one field of one resource. Commands on the same target supersede each
 * other — only the latest-issued one's outcome is shown, so a slow earlier
 * result never overrides a later one. Commands on different targets are
 * independent facts: one's outcome never hides another's failure.
 */

export interface CommandFailure {
  readonly target: string;
  readonly action: string;
  readonly detail: string;
}

export interface CommandTicket {
  readonly target: string;
  readonly seq: number;
}

export class CommandFailures {
  #nextSeq = 0;
  /** Latest-issued seq per target with an unsettled latest command. */
  readonly #latest = new Map<string, number>();
  #failures: readonly CommandFailure[] = [];

  /** Current failures, oldest first. A new array after every change. */
  get failures(): readonly CommandFailure[] {
    return this.#failures;
  }

  /**
   * Register a command on `target`. `null` = no superseding identity (e.g.
   * creating a new resource): its failure stands until dismissed.
   */
  begin(target: string | null): CommandTicket {
    const seq = ++this.#nextSeq;
    const key = target ?? `#${String(seq)}`;
    this.#latest.set(key, seq);
    return { target: key, seq };
  }

  succeeded(ticket: CommandTicket): void {
    if (!this.#settle(ticket)) return;
    this.#failures = this.#failures.filter(f => f.target !== ticket.target);
  }

  failed(ticket: CommandTicket, action: string, detail: string): void {
    if (!this.#settle(ticket)) return;
    this.#failures = [
      ...this.#failures.filter(f => f.target !== ticket.target),
      { target: ticket.target, action, detail },
    ];
  }

  dismiss(target: string): void {
    this.#failures = this.#failures.filter(f => f.target !== target);
  }

  /** True if `ticket` is still the latest command on its target. */
  #settle(ticket: CommandTicket): boolean {
    if (this.#latest.get(ticket.target) !== ticket.seq) return false;
    this.#latest.delete(ticket.target);
    return true;
  }
}
