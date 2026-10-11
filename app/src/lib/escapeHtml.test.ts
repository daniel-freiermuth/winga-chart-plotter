// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escapeHtml';

const HOSTILE = [
  '<img src=x onerror="alert(1)">',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '</div><script>alert(1)</script>',
  'Tom &amp; Jerry',
  'A & B <C> "D" \'E\'',
];

describe('escapeHtml', () => {
  it.each(HOSTILE)('round-trips %j as element text without creating elements', (s) => {
    const host = document.createElement('div');
    host.innerHTML = `<span>${escapeHtml(s)}</span>`;
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild?.children).toHaveLength(0);
    expect(host.textContent).toBe(s);
  });

  it.each(HOSTILE)('round-trips %j in double- and single-quoted attributes without breaking out', (s) => {
    const host = document.createElement('div');
    host.innerHTML = `<button data-a="${escapeHtml(s)}" data-b='${escapeHtml(s)}'></button>`;
    const btn = host.firstElementChild as HTMLElement;
    expect(host.children).toHaveLength(1);
    expect(btn.getAttributeNames().sort()).toEqual(['data-a', 'data-b']);
    expect(btn.dataset['a']).toBe(s);
    expect(btn.dataset['b']).toBe(s);
  });
});
