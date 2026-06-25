/**
 * RFC 4122 v4 UUID, usable in insecure contexts.
 *
 * `crypto.randomUUID()` is restricted to secure contexts (HTTPS or http://localhost) — it
 * throws "crypto.randomUUID is not a function" on a plain `http://<lan-ip>:port` origin, which
 * is exactly how this app is reached on the boat network (Signal K server over plain HTTP).
 * `crypto.getRandomValues()` has no such restriction (the one Crypto member usable from an
 * insecure context), so we build the UUID from it directly instead of relying on randomUUID.
 *
 * These IDs are opaque identifiers (subscription ids, widget instance ids) — not used for any
 * cryptographic purpose — so a manually-assembled v4 UUID is just as fit for purpose.
 */
export function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}
