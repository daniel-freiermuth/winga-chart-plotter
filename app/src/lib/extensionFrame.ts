/**
 * Liveness supervision for an iframe-hosted extension context (widget/panel).
 *
 * Everything here exists because a Signal K server that is down, slow, or
 * restarting leaves extension frames in states the app previously could not
 * recover from without a full page reload:
 *
 *  • The document never loads (server down when the widget mounted) — the
 *    frame shows the browser's network error page and nothing retries it.
 *  • The document loads but its bundle 404s or throws — no `bus.ready` ever
 *    arrives and the widget stays blank forever.
 *  • The document loads and starts its `bus.ready` retry loop, but the host
 *    is not listening in time. The extension client gives up after ~10 s and
 *    renders its own "timed out waiting for host handshake" error, which is
 *    then permanent.
 *
 * The supervisor watches for the first `bus.ready` from the frame. If none
 * arrives within `handshakeTimeoutMs` the frame is reloaded, with exponential
 * backoff, up to `maxAutoAttempts` times; after that it parks in `stalled` and
 * waits for `retryNow()` — a user tap, or the Signal K stream coming back.
 *
 * Liveness is only supervised up to the first handshake: the extension client
 * stops announcing itself once connected, so there is no heartbeat to watch
 * afterwards. A frame that dies later is the extension's own business.
 */

export type FramePhase =
  /** Waiting for the frame's first `bus.ready` (possibly across a retry). */
  | 'connecting'
  /** The frame has announced itself; the host answered its handshake. */
  | 'live'
  /** Auto-retries exhausted — waiting for `retryNow()`. */
  | 'stalled';

export interface FrameState {
  phase: FramePhase;
  /** Automatic reloads performed so far; 0 until the first watchdog trip. */
  attempt: number;
}

export interface FrameSupervisorOptions {
  /** Force a fresh document load in the frame. */
  reload: () => void;
  /** Called on every phase/attempt change (never with an unchanged state). */
  onChange?: (state: FrameState) => void;
  /** Grace period for the frame to announce itself. Default 12 s — just past
   *  the extension client's own 10 s handshake timeout, so the extension has
   *  had its full retry window before we take the frame away from it. */
  handshakeTimeoutMs?: number;
  /** Delay before the first automatic reload; doubles per attempt. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAutoAttempts?: number;
}

export interface FrameSupervisor {
  /** Plain (non-reactive) reads — mirror into component state via onChange. */
  readonly phase: FramePhase;
  readonly attempt: number;
  /** Arm the watchdog. Call once the frame element exists. */
  start(): void;
  /** A `bus.ready` arrived from the frame. Idempotent. */
  noteReady(): void;
  /** The frame fired `load`. Restarts the grace period for the new document. */
  noteLoad(): void;
  /** Reset the attempt counter and reload immediately. */
  retryNow(): void;
  /** Clear all timers. The supervisor is inert afterwards. */
  stop(): void;
}

const DEFAULTS = {
  handshakeTimeoutMs: 12_000,
  retryBaseMs: 2_000,
  retryMaxMs: 30_000,
  maxAutoAttempts: 3,
};

export function createFrameSupervisor(opts: FrameSupervisorOptions): FrameSupervisor {
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs;
  const retryBaseMs        = opts.retryBaseMs        ?? DEFAULTS.retryBaseMs;
  const retryMaxMs         = opts.retryMaxMs         ?? DEFAULTS.retryMaxMs;
  const maxAutoAttempts    = opts.maxAutoAttempts    ?? DEFAULTS.maxAutoAttempts;

  let phase: FramePhase = 'connecting';
  let attempt = 0;
  let stopped = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(nextPhase: FramePhase, nextAttempt: number): void {
    if (nextPhase === phase && nextAttempt === attempt) return;
    phase = nextPhase;
    attempt = nextAttempt;
    opts.onChange?.({ phase, attempt });
  }

  function clearTimers(): void {
    if (watchdog !== null)   { clearTimeout(watchdog);   watchdog = null; }
    if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function armWatchdog(): void {
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = setTimeout(onWatchdog, handshakeTimeoutMs);
  }

  function onWatchdog(): void {
    watchdog = null;
    if (stopped || phase === 'live') return;
    if (attempt >= maxAutoAttempts) {
      emit('stalled', attempt);
      return;
    }
    const next = attempt + 1;
    // Backoff is indexed from the *previous* attempt count, so the first
    // automatic reload waits retryBaseMs.
    const delay = Math.min(retryBaseMs * 2 ** attempt, retryMaxMs);
    emit('connecting', next);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped) return;
      opts.reload();
      armWatchdog();
    }, delay);
  }

  return {
    get phase()   { return phase; },
    get attempt() { return attempt; },

    start(): void {
      if (stopped) return;
      armWatchdog();
    },

    noteReady(): void {
      if (stopped) return;
      clearTimers();
      emit('live', 0);
    },

    noteLoad(): void {
      // A fresh document deserves the full grace period from the moment it is
      // up, not from whenever the frame was created — a slow server can hold
      // the load event for longer than the whole handshake window.
      if (stopped || phase === 'live') return;
      if (retryTimer !== null) return; // a reload is already pending
      armWatchdog();
    },

    retryNow(): void {
      if (stopped) return;
      clearTimers();
      emit('connecting', 0);
      opts.reload();
      armWatchdog();
    },

    stop(): void {
      stopped = true;
      clearTimers();
    },
  };
}

/**
 * Force a fresh document load of `url` in `frame`.
 *
 * `location.replace` is the preferred path: it navigates to the intended URL
 * (unlike `reload()`, which would faithfully re-fetch whatever error document
 * or leftover `about:blank` the frame is sitting on) and adds no history
 * entry, so retries never pollute the back button. It is only reachable while
 * the frame's document is same-origin — a cross-origin extension page throws
 * on `location` access, and those are bounced through `about:blank` instead:
 * re-assigning `src` alone is not reliably a renavigation when the URL is
 * unchanged.
 */
export function reloadFrame(frame: HTMLIFrameElement, url: string): void {
  const win = frame.contentWindow;
  if (win) {
    try {
      win.location.replace(url);
      return;
    } catch { /* cross-origin — fall through */ }
  }
  frame.src = 'about:blank';
  queueMicrotask(() => {
    if (frame.isConnected) frame.src = url;
  });
}
