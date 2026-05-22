<script lang="ts">
  import { settings, type AppearanceSettings } from '../stores/settings.svelte';

  let open = $state(false);
  let tab  = $state<'connection' | 'appearance'>('connection');

  // Connection settings use a draft (applied only on Save)
  let connDraft = $state({ protocol: settings.protocol, host: settings.host, port: settings.port });
  // Appearance is edited directly on the store — instant live preview
  // Cancel reverts to this snapshot
  let appearanceSnapshot = '';

  function openModal() {
    connDraft = { protocol: settings.protocol, host: settings.host, port: settings.port };
    appearanceSnapshot = JSON.stringify(settings.appearance);
    tab  = 'connection';
    open = true;
  }

  function saveConnection() {
    settings.apply({
      signalkProtocol: connDraft.protocol,
      signalkHost:     connDraft.host,
      signalkPort:     connDraft.port,
      appearance:      settings.appearance,
    });
    open = false;
  }

  function cancel() {
    // Revert appearance to snapshot taken at open
    settings.apply({
      signalkProtocol: settings.protocol,
      signalkHost:     settings.host,
      signalkPort:     settings.port,
      appearance:      JSON.parse(appearanceSnapshot) as AppearanceSettings,
    });
    open = false;
  }

  function close() { open = false; }

  // Live-apply appearance as user edits
  function applyAppearance() {
    settings.apply({
      signalkProtocol: settings.protocol,
      signalkHost:     settings.host,
      signalkPort:     settings.port,
      appearance:      settings.appearance,
    });
  }
</script>

<button onclick={openModal} title="Settings" class="gear-btn">⚙</button>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div onclick={close} class="backdrop"></div>

  <div class="modal">
    <h2>Settings</h2>

    <div class="tabs">
      <button class="tab" class:active={tab === 'connection'} onclick={() => tab = 'connection'}>Connection</button>
      <button class="tab" class:active={tab === 'appearance'} onclick={() => tab = 'appearance'}>Appearance</button>
    </div>

    {#if tab === 'connection'}
      <p class="section-title">Signal K server</p>
      <div class="row">
        <label>Protocol</label>
        <div class="field">
          <select bind:value={connDraft.protocol}>
            <option value="ws">ws://</option>
            <option value="wss">wss://</option>
          </select>
        </div>
      </div>
      <div class="row">
        <label>Host</label>
        <div class="field">
          <input type="text" bind:value={connDraft.host} placeholder="192.168.1.1" style="flex:1; font-family: monospace;" />
        </div>
      </div>
      <div class="row">
        <label>Port</label>
        <div class="field">
          <input type="number" bind:value={connDraft.port} min="1" max="65535" />
        </div>
      </div>
      <p class="hint">→ {connDraft.protocol}://{connDraft.host}:{connDraft.port}/signalk/v1/stream?subscribe=self</p>
    {/if}

    {#if tab === 'appearance'}
      <p class="section-title">Vessel</p>
      <div class="row">
        <label>Color</label>
        <div class="field"><input type="color" bind:value={settings.appearance.vesselColor} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <label>Size</label>
        <div class="field">
          <input type="number" bind:value={settings.appearance.vesselSize} min="8" max="64" step="2" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>

      <p class="section-title">Heading line</p>
      {#each [{ key: 'heading' }, { key: 'cog' }, { key: 'gc' }] as { key } (key)}
        {@const line = key === 'heading' ? settings.appearance.heading : key === 'cog' ? settings.appearance.cog : settings.appearance.gc}
        <div class="row">
          <label>Color</label>
          <div class="field"><input type="color" bind:value={line.color} oninput={applyAppearance} /></div>
        </div>
        <div class="row">
          <label>Width</label>
          <div class="field">
            <input type="number" bind:value={line.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
            <span class="unit">px</span>
          </div>
        </div>
        <div class="row">
          <label>Style</label>
          <div class="field">
            <select bind:value={line.style} onchange={applyAppearance}>
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
              <option value="dash-dot">Dash-dot</option>
            </select>
          </div>
        </div>
        <div class="row">
          <label>Length</label>
          <div class="field">
            <input type="number" bind:value={line.lengthValue} min="0" step="0.1" style="width:72px" oninput={applyAppearance} />
            <select bind:value={line.lengthUnit} onchange={applyAppearance}>
              <option value="nm">nm</option>
              <option value="min">min at SOG</option>
              <option value="px">px</option>
            </select>
          </div>
        </div>
        {#if key === 'heading'}
          <p class="section-title">Rhumb Line predictor</p>
        {:else if key === 'cog'}
          <p class="section-title">Great Circle predictor</p>
        {:else if key === 'gc'}
          <p class="section-title">AIS targets</p>
        {/if}
      {/each}

      <div class="row">
        <label>Color</label>
        <div class="field"><input type="color" bind:value={settings.appearance.ais.vesselColor} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <label>Size</label>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ais.vesselSize} min="8" max="48" step="2" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>
      <p class="section-title">AIS COG line</p>
      <div class="row">
        <label>Color</label>
        <div class="field"><input type="color" bind:value={settings.appearance.ais.cog.color} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <label>Width</label>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ais.cog.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>
      <div class="row">
        <label>Style</label>
        <div class="field">
          <select bind:value={settings.appearance.ais.cog.style} onchange={applyAppearance}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dash-dot">Dash-dot</option>
          </select>
        </div>
      </div>
    {/if}

    <div class="actions">
      {#if tab === 'connection'}
        <button onclick={cancel} class="btn btn-cancel">Cancel</button>
        <button onclick={saveConnection} class="btn btn-save">Save &amp; reconnect</button>
      {:else}
        <button onclick={cancel} class="btn btn-cancel">Cancel</button>
        <button onclick={close}  class="btn btn-save">Close</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .gear-btn {
    position: absolute; top: 44px; left: 10px; z-index: 10;
    background: rgba(0,0,0,0.7); border: none; color: white;
    padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 16px;
  }
  .backdrop { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,0.5); }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
    z-index: 21; background: #1e1e2e; color: white; border-radius: 10px;
    padding: 24px; min-width: 440px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif; max-height: 90vh; overflow-y: auto;
  }
  h2 { margin: 0 0 16px; font-size: 16px; font-weight: 600; }
  .tabs { display: flex; border-bottom: 1px solid #333355; margin-bottom: 20px; }
  .tab {
    background: none; border: none; color: #a0a0c0; padding: 8px 18px;
    cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .tab.active { color: white; border-bottom-color: #4a6cf7; }
  .section-title {
    font-size: 11px; font-weight: 600; color: #666688; text-transform: uppercase;
    letter-spacing: 0.08em; margin: 16px 0 10px;
  }
  .row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .row > label { width: 72px; font-size: 13px; color: #a0a0c0; flex-shrink: 0; }
  .field { flex: 1; display: flex; align-items: center; gap: 8px; }
  .unit { font-size: 12px; color: #666688; }
  .hint { font-size: 11px; color: #666688; margin: 2px 0 12px 84px; word-break: break-all; }
  .radio-group { gap: 16px; }
  .radio-group label { display: flex; align-items: center; gap: 6px; color: white; font-size: 13px; cursor: pointer; width: auto; }
  input[type=text], input[type=number], select {
    background: #2a2a3e; border: 1px solid #444466; color: white;
    padding: 6px 8px; border-radius: 6px; font-size: 13px; box-sizing: border-box;
  }
  input[type=text]   { flex: 1; }
  input[type=number] { width: 80px; -moz-appearance: textfield; }
  select { cursor: pointer; }
  input[type=color]  { width: 40px; height: 30px; border: 1px solid #444466; border-radius: 6px; cursor: pointer; padding: 2px; background: none; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }
  .btn { padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .btn-cancel { background: transparent; border: 1px solid #444466; color: #a0a0c0; }
  .btn-save   { background: #4a6cf7; border: none; color: white; }
</style>
