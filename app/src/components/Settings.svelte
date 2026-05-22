<script lang="ts">
  import { settings } from '../stores/settings.svelte';

  let open = $state(false);
  let draftProtocol = $state(settings.protocol);
  let draftHost = $state(settings.host);
  let draftPort = $state(settings.port);

  function save() {
    settings.protocol = draftProtocol;
    settings.host = draftHost;
    settings.port = draftPort;
    open = false;
  }

  function cancel() {
    draftProtocol = settings.protocol;
    draftHost = settings.host;
    draftPort = settings.port;
    open = false;
  }
</script>

<button
  onclick={() => { draftProtocol = settings.protocol; draftHost = settings.host; draftPort = settings.port; open = true; }}
  title="Settings"
  style="
    position: absolute; top: 44px; left: 10px; z-index: 10;
    background: rgba(0,0,0,0.7); border: none; color: white;
    padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 16px;
  "
>⚙</button>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    onclick={cancel}
    style="position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,0.5);"
  ></div>

  <div style="
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
    z-index: 21; background: #1e1e2e; color: white; border-radius: 10px;
    padding: 24px; min-width: 360px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
  ">
    <h2 style="margin: 0 0 20px; font-size: 16px; font-weight: 600;">Settings</h2>

    <label style="display: block; margin-bottom: 6px; font-size: 13px; color: #a0a0c0;">Signal K server</label>
    <div style="display: flex; gap: 8px; align-items: center;">
      <select
        bind:value={draftProtocol}
        style="
          background: #2a2a3e; border: 1px solid #444466; color: white;
          padding: 8px 6px; border-radius: 6px; font-size: 13px; font-family: monospace;
        "
      >
        <option value="ws">ws://</option>
        <option value="wss">wss://</option>
      </select>
      <input
        type="text"
        bind:value={draftHost}
        placeholder="192.168.1.1"
        style="
          flex: 1; background: #2a2a3e; border: 1px solid #444466; color: white;
          padding: 8px 10px; border-radius: 6px; font-size: 13px; font-family: monospace;
        "
      />
      <input
        type="number"
        bind:value={draftPort}
        min="1" max="65535"
        style="
          width: 72px; background: #2a2a3e; border: 1px solid #444466; color: white;
          padding: 8px 10px; border-radius: 6px; font-size: 13px; font-family: monospace;
          -moz-appearance: textfield;
        "
      />
    </div>
    <p style="margin: 6px 0 20px; font-size: 11px; color: #666688;">
      → {draftProtocol}://{draftHost}:{draftPort}/signalk/v1/stream?subscribe=self
    </p>

    <div style="display: flex; gap: 10px; justify-content: flex-end;">
      <button
        onclick={cancel}
        style="
          background: transparent; border: 1px solid #444466; color: #a0a0c0;
          padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
        "
      >Cancel</button>
      <button
        onclick={save}
        style="
          background: #4a6cf7; border: none; color: white;
          padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
        "
      >Save &amp; reconnect</button>
    </div>
  </div>
{/if}
