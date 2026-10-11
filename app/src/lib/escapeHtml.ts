const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a string for interpolation into HTML element text or a quoted
 * attribute value. Every server-supplied string (resource names, AIS static
 * data, ids) passed to an HTML sink such as MapLibre's `Popup.setHTML` must go
 * through this — those strings are writable by other clients and over RF.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
