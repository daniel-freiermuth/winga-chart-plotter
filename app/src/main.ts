import App from './App.svelte';
import { mount } from 'svelte';
import { ready } from './lib/wasmInit';

const target = document.getElementById('app');
if (!target) throw new Error('No #app element found');

// Boot gate: WASM (1.2 MB, precached, loads once) must be ready before any
// component mounts — wasmGeo.ts/trackProcessing.ts assume it and fail fast
// otherwise. The race window is startup only; ready settles once per load.
const bootStatus = document.getElementById('boot-status');
ready
  .then(() => {
    // Mount first: if mount() throws (e.g. a runtime error during initial
    // component construction), #boot-status must stay attached and visible
    // instead of a blank screen — the very silent failure this boot gate
    // exists to avoid.
    mount(App, { target });
    bootStatus?.remove();
  })
  .catch((err: unknown) => {
    console.error('App failed to boot:', err);
    if (bootStatus) {
      bootStatus.setAttribute('role', 'alert');
      bootStatus.setAttribute('aria-live', 'assertive');
      bootStatus.dataset['state'] = 'error';
      bootStatus.textContent = 'Failed to load. Please reload the page.';
    }
  });
