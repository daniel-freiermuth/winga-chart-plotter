/**
 * Lifecycle owner for one iframe-hosted extension context.
 *
 * Everything that decides *when* an extension frame connects, retries or is
 * torn down lives here rather than in the Svelte components: components bind
 * the element and render the resulting state, per the project's UI-only
 * component rule. Kept separate from `extensionFrame.ts` so the supervision
 * state machine stays a pure module with no store dependencies.
 */
import type { HandshakeContext } from 'signalk-plotterext-bus/host';
import { createHostConnection, type MapControl, type PanelControl } from './plotterext-host';
import {
  createFrameSupervisor, reloadFrame,
  type FrameState, type FrameSupervisorOptions,
} from './extensionFrame';
import { plotterExtensions } from '../stores/plotterExtensions.svelte';
import type { SkRelay } from './sk-relay';



export interface AttachExtensionFrameOptions {
  frame: HTMLIFrameElement;
  /** The extension page the frame is pointed at; also the reload target. */
  url: string;
  extensionId: string;
  context: HandshakeContext;
  relay: SkRelay;
  mapControl: MapControl;
  panelControl: PanelControl;
  /**
   * Republish `state.changed` into this frame when another connection (a
   * config panel) writes this instance's state. Widgets only — a panel is
   * usually the writer, not the reader.
   */
  watchInstanceState?: boolean;
  onState?: (state: FrameState) => void;
  /** Supervisor tuning; production uses the defaults. */
  supervision?: Omit<FrameSupervisorOptions, 'reload' | 'onChange'>;
}

export interface AttachedExtensionFrame {
  /** Current supervision state — a plain read, not reactive. */
  readonly state: FrameState;
  /**
   * The Signal K stream (re)connected. A frame that has not managed to
   * announce itself gets one free retry out of it; a healthy one is untouched.
   */
  noteReconnect(): void;
  retryNow(): void;
  detach(): void;
}

/**
 * Own one extension frame end to end: the bus connection, its supervision, and
 * the state republishing it needs. Components bind the element and render the
 * state; everything that decides *when* to connect, retry or tear down lives
 * here.
 *
 * Returns `null` when the element has no browsing context (detached frame),
 * which is the caller's cue that there is nothing to clean up.
 */
export function attachExtensionFrame(opts: AttachExtensionFrameOptions): AttachedExtensionFrame | null {
  const { frame, url, extensionId, context, relay, mapControl, panelControl } = opts;
  // The frame's WindowProxy is created with the element and survives every
  // navigation it makes, so it can be bound once, up front.
  const peer = frame.contentWindow;
  if (!peer) return null;

  let state: FrameState = { phase: 'connecting', attempt: 0 };
  opts.onState?.(state);

  const supervisor = createFrameSupervisor({
    ...opts.supervision,
    reload: () => { reloadFrame(frame, url); },
    onChange: (next) => { state = next; opts.onState?.(next); },
  });

  // Connect *before* the extension document runs. The host answers
  // `bus.ready`, so a connection created on the frame's `load` event can miss
  // the announcement of a document whose subresources are slow — and the
  // extension then renders its own permanent handshake-timeout error.
  const host = createHostConnection(
    peer, extensionId, context, relay, mapControl, panelControl,
    { onReady: () => { supervisor.noteReady(); } },
  );

  const onLoad = (): void => { supervisor.noteLoad(); };
  frame.addEventListener('load', onLoad);
  supervisor.start();

  const unwatchState = opts.watchInstanceState === true && context.instanceId
    ? plotterExtensions.onInstanceStateChanged(extensionId, context.instanceId, (keys) => {
        host.conn.publish('state.changed', {
          scope: 'instance', instanceId: context.instanceId, keys,
        });
      })
    : null;

  return {
    get state() { return state; },
    noteReconnect(): void {
      if (supervisor.phase !== 'live') supervisor.retryNow();
    },
    retryNow(): void { supervisor.retryNow(); },
    detach(): void {
      frame.removeEventListener('load', onLoad);
      unwatchState?.();
      supervisor.stop();
      host.close();
    },
  };
}
