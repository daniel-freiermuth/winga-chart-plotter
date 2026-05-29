<script lang="ts">
  import { settings, type AppearanceSettings } from '../stores/settings.svelte';
  import { fpsStore } from '../stores/fps.svelte';
  import FaIcon from '../lib/FaIcon.svelte';
  import ColorInput from '../lib/ColorInput.svelte';
  import { faGear } from '@fortawesome/free-solid-svg-icons';

  let open = $state(false);
  let tab  = $state<'connection' | 'vessel' | 'ais' | 'routes' | 'about'>('connection');

  // Connection settings use a draft (applied only on Save)
  let connDraft = $state({ protocol: settings.protocol, host: settings.host, port: settings.port });
  // Appearance and targetFps are edited directly — instant live preview.
  // Cancel reverts to this snapshot.
  type SettingsSnapshot = { appearance: AppearanceSettings; targetFps: number };
  let settingsSnapshot = '';

  // Logarithmic slider helpers: range [0, 1000] ↔ fps [0.1, 60]
  function fpsToSlider(fps: number): number {
    return Math.round((Math.log10(fps) + 1) / (Math.log10(60) + 1) * 1000);
  }
  function sliderToFps(v: number): number {
    const fps = 10 ** (-1 + (v / 1000) * (Math.log10(60) + 1));
    return fps >= 10 ? Math.round(fps) : Math.round(fps * 10) / 10;
  }
  function fpsLabel(fps: number): string {
    if (fps >= 10) return `${Math.round(fps)} fps`;
    if (fps >= 1)  return `${fps.toFixed(1)} fps`;
    return `every ${Math.round(1 / fps)}s`;
  }
  function formatActualFps(fps: number): string {
    if (fps <= 0) return '';
    if (fps >= 10) return `${Math.round(fps)} fps`;
    return `${fps.toFixed(1)} fps`;
  }

  function openModal() {
    connDraft = { protocol: settings.protocol, host: settings.host, port: settings.port };
    settingsSnapshot = JSON.stringify({ appearance: settings.appearance, targetFps: settings.targetFps });
    tab  = 'connection';
    open = true;
  }

  export function openTo(t: typeof tab) {
    connDraft = { protocol: settings.protocol, host: settings.host, port: settings.port };
    settingsSnapshot = JSON.stringify({ appearance: settings.appearance, targetFps: settings.targetFps });
    tab  = t;
    open = true;
  }

  function saveConnection() {
    settings.apply({
      signalkProtocol: connDraft.protocol,
      signalkHost:     connDraft.host,
      signalkPort:     connDraft.port,
      useGeoLocation:  settings.useGeoLocation,
      appearance:      settings.appearance,
      targetFps:       settings.targetFps,
    });
    open = false;
  }

  function cancel() {
    // Revert appearance and targetFps to snapshot taken at open
    const snap = JSON.parse(settingsSnapshot) as SettingsSnapshot;
    settings.apply({
      signalkProtocol: settings.protocol,
      signalkHost:     settings.host,
      signalkPort:     settings.port,
      useGeoLocation:  settings.useGeoLocation,
      appearance:      snap.appearance,
      targetFps:       snap.targetFps,
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
      useGeoLocation:  settings.useGeoLocation,
      appearance:      settings.appearance,
      targetFps:       settings.targetFps,
    });
  }
</script>

<button onclick={openModal} title="Settings" class="gear-btn"><FaIcon icon={faGear} /></button>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div onclick={close} class="backdrop"></div>

  <div class="modal">
    <h2>Settings</h2>

    <div class="tabs">
      <button class="tab" class:active={tab === 'connection'} onclick={() => tab = 'connection'}>Connection</button>
      <button class="tab" class:active={tab === 'vessel'}     onclick={() => tab = 'vessel'}>Own vessel</button>
      <button class="tab" class:active={tab === 'ais'}        onclick={() => tab = 'ais'}>AIS</button>
      <button class="tab" class:active={tab === 'routes'}     onclick={() => tab = 'routes'}>Routes</button>
      <button class="tab" class:active={tab === 'about'}      onclick={() => tab = 'about'}>About</button>
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

      <p class="section-title">Position source</p>
      <div class="row">
        <label>Browser GPS</label>
        <div class="field">
          <label class="toggle">
            <input
              type="checkbox"
              checked={settings.useGeoLocation}
              onchange={(e) => {
                const checked = (e.target as HTMLInputElement).checked;
                // Request permission while still inside the user-gesture event — some
                // mobile browsers suppress the prompt when called from an async context.
                if (checked && 'geolocation' in navigator) {
                  navigator.geolocation.getCurrentPosition(() => {}, () => {});
                }
                // iOS 13+ requires an explicit user-gesture permission for DeviceOrientationEvent.
                if (checked && typeof (window.DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === 'function') {
                  (window.DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> })
                    .requestPermission()
                    .then(r => { if (r !== 'granted') settings.setGeoError('Compass access denied — heading unavailable'); })
                    .catch(() => {});
                }
                settings.apply({ useGeoLocation: checked });
              }}
            />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
          <span class="toggle-label">Use device GPS instead of Signal K position</span>
        </div>
      </div>
      {#if settings.geoError && !settings.useGeoLocation}
        <p class="geo-error-note">⚠ {settings.geoError}</p>
      {/if}
    {/if}

    {#if tab === 'vessel'}
      <p class="section-title">Icon</p>
      <div class="row">
        <label>Color</label>
        <div class="field"><ColorInput bind:value={settings.appearance.vesselColor} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <label>Size</label>
        <div class="field">
          <input type="number" bind:value={settings.appearance.vesselSize} min="8" max="64" step="2" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>

      <p class="section-title">Heading predictor</p>
      {#each [
        { key: 'heading', nextTitle: 'Rhumb line (COG) predictor' },
        { key: 'cog',     nextTitle: 'Great circle (GC) predictor' },
        { key: 'gc',      nextTitle: null },
      ] as { key, nextTitle } (key)}
        {@const line = key === 'heading' ? settings.appearance.heading : key === 'cog' ? settings.appearance.cog : settings.appearance.gc}
        <div class="row">
          <label>Color</label>
          <div class="field"><ColorInput bind:value={line.color} oninput={applyAppearance} /></div>
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
        {#if nextTitle}
          <p class="section-title">{nextTitle}</p>
        {/if}
      {/each}
    {/if}

    {#if tab === 'ais'}
      <p class="section-title">Icon</p>
      <div class="row">
        <label>Color</label>
        <div class="field"><ColorInput bind:value={settings.appearance.ais.vesselColor} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <label>Size</label>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ais.vesselSize} min="8" max="48" step="2" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>

      <p class="section-title">COG line</p>
      <div class="row">
        <label>Color</label>
        <div class="field"><ColorInput bind:value={settings.appearance.ais.cog.color} oninput={applyAppearance} /></div>
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
      <div class="row">
        <label>Length</label>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ais.cog.lengthMinutes} min="1" max="60" step="1" oninput={applyAppearance} />
          <span class="unit">min</span>
        </div>
      </div>

      <p class="section-title">Performance</p>
      <div class="row">
        <label>Frame rate</label>
        <div class="fps-field">
          <input
            type="range"
            class="fps-slider"
            min="0" max="1000"
            value={fpsToSlider(settings.targetFps)}
            oninput={(e) => settings.setTargetFps(sliderToFps(+(e.target as HTMLInputElement).value))}
          />
          <span class="fps-target">{fpsLabel(settings.targetFps)}</span>
          <span class="fps-actual">{formatActualFps(fpsStore.value)}</span>
        </div>
      </div>
    {/if}

    {#if tab === 'routes'}
      <p class="section-title">Bearing to waypoint</p>
      {#each [
        { key: 'bearing',   nextTitle: 'Active segment' },
        { key: 'segment',   nextTitle: 'Remaining route' },
        { key: 'remaining', nextTitle: null },
      ] as { key, nextTitle } (key)}
        {@const rl = key === 'bearing' ? settings.appearance.route.bearing : key === 'segment' ? settings.appearance.route.segment : settings.appearance.route.remaining}
        <div class="row">
          <label>Color</label>
          <div class="field"><ColorInput bind:value={rl.color} oninput={applyAppearance} /></div>
        </div>
        <div class="row">
          <label>Width</label>
          <div class="field">
            <input type="number" bind:value={rl.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
            <span class="unit">px</span>
          </div>
        </div>
        <div class="row">
          <label>Style</label>
          <div class="field">
            <select bind:value={rl.style} onchange={applyAppearance}>
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
              <option value="dash-dot">Dash-dot</option>
            </select>
          </div>
        </div>
        {#if nextTitle}
          <p class="section-title">{nextTitle}</p>
        {/if}
      {/each}

      <p class="section-title">Ruler</p>
      <div class="row">
        <label>Color</label>
        <div class="field"><ColorInput bind:value={settings.appearance.ruler.color} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <label>Width</label>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ruler.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>
    {/if}

    {#if tab === 'about'}
      <div class="about">
        <img src="./icon-192.png" alt="Winga logo" class="about-logo" />
        <p class="about-name">Winga Chart Plotter</p>
        <p class="about-version">v{__APP_VERSION__} <span class="about-commit">#{__APP_COMMIT__}</span></p>
        <p class="about-desc">A sea chart plotting application for Signal K.</p>
        <div class="about-links">
          <a href="https://github.com/daniel-freiermuth/winga-chart-plotter" target="_blank" rel="noopener">GitHub</a>
        </div>
      </div>
    {/if}

    <div class="actions">
      {#if tab === 'connection'}
        <button onclick={cancel} class="btn btn-cancel">Cancel</button>
        <button onclick={saveConnection} class="btn btn-save">Save &amp; reconnect</button>
      {:else if tab === 'about'}
        <button onclick={close} class="btn btn-save">Close</button>
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
  .geo-error-note { font-size: 11px; color: #f87171; margin: -6px 0 10px 84px; }
  .radio-group { gap: 16px; }
  .radio-group label { display: flex; align-items: center; gap: 6px; color: white; font-size: 13px; cursor: pointer; width: auto; }
  input[type=text], input[type=number], select {
    background: #2a2a3e; border: 1px solid #444466; color: white;
    padding: 6px 8px; border-radius: 6px; font-size: 13px; box-sizing: border-box;
  }
  input[type=text]   { flex: 1; }
  input[type=number] { width: 80px; -moz-appearance: textfield; }
  select { cursor: pointer; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }
  .btn { padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .btn-cancel { background: transparent; border: 1px solid #444466; color: #a0a0c0; }
  .btn-save   { background: #4a6cf7; border: none; color: white; }
  .fps-field { flex: 1; display: flex; align-items: center; gap: 8px; }
  .fps-slider { flex: 1; min-width: 100px; cursor: pointer; }
  .fps-target { min-width: 5rem; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
  .fps-actual { color: #666688; font-size: 11px; min-width: 3.5rem; text-align: right; font-variant-numeric: tabular-nums; }

  .about { padding: 16px 0 8px; text-align: center; }
  .about-logo { width: 80px; height: 80px; border-radius: 16px; margin-bottom: 14px; }
  .about-name { font-size: 20px; font-weight: 700; margin: 0 0 6px; color: white; }
  .about-version { font-size: 13px; color: #a0a0c0; margin: 0 0 16px; font-variant-numeric: tabular-nums; }
  .about-commit { color: #666688; font-family: monospace; }
  .about-desc { font-size: 13px; color: #a0a0c0; margin: 0 0 20px; }
  .about-links { display: flex; gap: 16px; justify-content: center; }
  .about-links a { color: #4a6cf7; font-size: 13px; text-decoration: none; }
  .about-links a:hover { text-decoration: underline; }

  .toggle { display: inline-flex; align-items: center; cursor: pointer; flex-shrink: 0; }
  .toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
  .toggle-track {
    position: relative; width: 36px; height: 20px;
    background: #444466; border-radius: 10px; transition: background 0.2s;
  }
  .toggle input:checked + .toggle-track { background: #4a6cf7; }
  .toggle-thumb {
    position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: 50%;
    background: white; transition: left 0.2s;
  }
  .toggle input:checked + .toggle-track .toggle-thumb { left: 18px; }
  .toggle-label { font-size: 12px; color: #a0a0c0; }
</style>
