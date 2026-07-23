/**
 * Minimal scripted Signal K v1 server for E2E tests.
 *
 * Speaks just enough of the protocol for the app's WASM client
 * (crates/core/src/client.rs + skdata.rs):
 *  - WebSocket endpoint at /signalk/v1/stream (query string ignored)
 *  - Hello message with `self` on connect
 *  - v1 delta messages (context + updates[].values[])
 *
 * Every HTTP request is recorded (and answered 404) so tests can observe
 * which REST resources the app asked for — e.g. the AIS vessel-track fetch
 * fired by selecting a vessel, whose URL carries the vessel id.
 *
 * Runs in-process inside the Playwright test runner; each test starts its
 * own instance on an ephemeral port and scripts deltas directly.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export const OWN_ID = 'urn:mrn:signalk:uuid:e2e00000-0000-4000-8000-000000000001';

export interface RecordedRequest {
  method: string;
  url: string;
  at: number;
}

export interface AisReport {
  lon: number;
  lat: number;
  /** COG in radians. Pass COG_SENTINEL_RAD (2π) to simulate "not available". */
  cogRad?: number;
  /** SOG in m/s. */
  sogMs?: number;
  name?: string;
}

/** AIS "COG not available" sentinel: 360.0° == 2π rad exactly (see skdata.rs). */
export const COG_SENTINEL_RAD = 2 * Math.PI;

const iso = (): string => new Date().toISOString();

export class MockSignalK {
  port = 0;
  readonly requests: RecordedRequest[] = [];
  private http!: Server;
  private wss!: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private readonly timers = new Set<NodeJS.Timeout>();

  async start(): Promise<number> {
    this.http = createServer((req, res) => {
      this.requests.push({ method: req.method ?? 'GET', url: req.url ?? '', at: Date.now() });
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      res.end('{"error":"mock: not found"}');
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      if (!(req.url ?? '').startsWith('/signalk/v1/stream')) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.add(ws);
        ws.on('close', () => this.sockets.delete(ws));
        // Incoming subscribe messages are accepted and ignored — the mock
        // decides what to stream, tests script it explicitly.
        ws.send(JSON.stringify({
          name: 'mock-signalk',
          version: '2.0.0',
          self: `vessels.${OWN_ID}`,
          roles: ['master', 'main'],
          timestamp: iso(),
        }));
      });
    });
    const listening = Promise.withResolvers<void>();
    this.http.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const addr = this.http.address();
    if (addr === null || typeof addr === 'string') throw new Error('mock: no port');
    this.port = addr.port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    const closed = Promise.withResolvers<void>();
    this.http.close(() => closed.resolve());
    await closed.promise;
  }

  /** Send a raw message object to every connected client. */
  send(msg: object): void {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  /** Send one v1 delta for `context` ("vessels." prefix added here). */
  delta(vesselId: string, values: { path: string; value: unknown }[]): void {
    this.send({
      context: `vessels.${vesselId}`,
      updates: [{ $source: 'mock.e2e', timestamp: iso(), values }],
    });
  }

  /** Own-vessel navigation delta (position + COG + SOG). */
  ownNav(nav: { lon: number; lat: number; cogRad: number; sogMs: number }): void {
    this.delta(OWN_ID, [
      { path: 'navigation.position', value: { longitude: nav.lon, latitude: nav.lat } },
      { path: 'navigation.courseOverGroundTrue', value: nav.cogRad },
      { path: 'navigation.speedOverGround', value: nav.sogMs },
    ]);
  }

  /**
   * One AIS target report. Always carries navigation.datetime = now — skdata
   * drops vessels without a fresh datetime from every AIS snapshot.
   */
  aisReport(vesselId: string, r: AisReport): void {
    const values: { path: string; value: unknown }[] = [
      { path: 'navigation.position', value: { longitude: r.lon, latitude: r.lat } },
      { path: 'navigation.datetime', value: iso() },
    ];
    if (r.cogRad !== undefined) values.push({ path: 'navigation.courseOverGroundTrue', value: r.cogRad });
    if (r.sogMs !== undefined) values.push({ path: 'navigation.speedOverGround', value: r.sogMs });
    if (r.name !== undefined) values.push({ path: 'name', value: r.name });
    this.delta(vesselId, values);
  }

  /**
   * Immediately drop a vessel from subsequent AIS snapshots: back-date its
   * navigation.datetime past the 10-minute stale window (skdata's extract
   * filters on `now - datetime_ms > stale_ms`, so this takes effect on the
   * very next emit — no need to wait for the real prune).
   */
  expire(vesselId: string): void {
    this.delta(vesselId, [
      { path: 'navigation.datetime', value: new Date(Date.now() - 20 * 60_000).toISOString() },
    ]);
  }

  /** Repeating scripted action; cleared automatically on stop(). */
  every(ms: number, fn: () => void): NodeJS.Timeout {
    const t = setInterval(fn, ms);
    this.timers.add(t);
    return t;
  }

  clear(t: NodeJS.Timeout): void {
    clearInterval(t);
    this.timers.delete(t);
  }

  /**
   * Wait until a vessel-track request (v1 `/vessels/<id>/track` or v2 history
   * with a `context=vessels.<id>` query) recorded at index >= `fromIndex`
   * arrives, and return the decoded vessel id it asked about.
   */
  async waitForTrackRequest(fromIndex: number, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const req of this.requests.slice(fromIndex)) {
        const id = trackRequestVesselId(req.url);
        if (id !== null) return id;
      }
      if (Date.now() > deadline) throw new Error('mock: no vessel-track request observed');
      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, 50);
      await tick.promise;
    }
  }
}

/** Extract the vessel id from a v1 track URL or a v2 history URL, else null. */
export function trackRequestVesselId(url: string): string | null {
  const v1 = /^\/signalk\/v1\/api\/vessels\/([^/]+)\/track/.exec(url);
  if (v1?.[1] !== undefined) return decodeURIComponent(v1[1]);
  if (url.startsWith('/signalk/v2/api/history/values')) {
    const q = new URL(url, 'http://mock').searchParams.get('context');
    if (q !== null && q.startsWith('vessels.')) return q.slice('vessels.'.length);
  }
  return null;
}
