<script lang="ts">
  import { settings, type AppearanceSettings, type SettingsTab } from '../stores/settings.svelte';
  import { plotterExtensions } from '../stores/plotterExtensions.svelte';
  import { auth } from '../stores/auth.svelte';
  import { fpsStore } from '../stores/fps.svelte';
  import { connection } from '../stores/connection.svelte';
  import ColorInput from '../lib/ColorInput.svelte';

  let isOpen = $state(false);
  let tab  = $state<SettingsTab>('connection');

  // Connection settings use a draft (applied only on Save)
  let connDraft = $state({ protocol: settings.protocol, host: settings.host, port: settings.port });
  // Appearance and targetFps are edited directly — instant live preview.
  // Cancel reverts to this snapshot.
  interface SettingsSnapshot { appearance: AppearanceSettings; targetFps: number; resourcePollIntervalSeconds: number }
  let settingsSnapshot = '';

  // Login form local state — not part of the saved settings draft.
  let loginUser = $state('');
  let loginPass = $state('');

  // Logarithmic slider helpers: range [0, 1000] ↔ fps [0.1, 60]
  function fpsToSlider(fps: number): number {
    return Math.round((Math.log10(fps) + 1) / (Math.log10(60) + 1) * 1000);
  }
  function sliderToFps(v: number): number {
    const fps = 10 ** (-1 + (v / 1000) * (Math.log10(60) + 1));
    return fps >= 10 ? Math.round(fps) : Math.round(fps * 10) / 10;
  }
  function fpsLabel(fps: number): string {
    if (fps >= 10) return `${String(Math.round(fps))} fps`;
    if (fps >= 1)  return `${fps.toFixed(1)} fps`;
    return `every ${String(Math.round(1 / fps))}s`;
  }

  // Logarithmic slider helpers: range [0, 1000] ↔ track history hours [5min, 5yr]
  const TRACK_LOG_MIN = Math.log(5 / 60);               // 5 minutes in hours
  const TRACK_LOG_MAX = Math.log(5 * 365.25 * 24);      // 5 years in hours
  function hoursToSlider(h: number): number {
    return Math.round(((Math.log(Math.max(h, 5 / 60)) - TRACK_LOG_MIN) / (TRACK_LOG_MAX - TRACK_LOG_MIN)) * 1000);
  }
  function sliderToHours(v: number): number {
    return Math.exp(TRACK_LOG_MIN + (v / 1000) * (TRACK_LOG_MAX - TRACK_LOG_MIN));
  }
  function trackDurationLabel(hours: number): string {
    if (hours < 1)           return `${String(Math.round(hours * 60))} min`;
    if (hours < 24)          return `${String(Math.round(hours))} h`;
    const days = hours / 24;
    if (days < 14)           return `${String(Math.round(days))} days`;
    const weeks = days / 7;
    if (weeks < 10)          return `${String(Math.round(weeks))} weeks`;
    const months = days / 30.44;
    if (months < 18)         return `${String(Math.round(months))} months`;
    return `${(hours / (365.25 * 24)).toFixed(1)} years`;
  }
  function formatActualFps(fps: number): string {
    if (fps <= 0) return '';
    if (fps >= 10) return `${String(Math.round(fps))} fps`;
    return `${fps.toFixed(1)} fps`;
  }

  function openModal() {
    connDraft = { protocol: settings.protocol, host: settings.host, port: settings.port };
    settingsSnapshot = JSON.stringify({ appearance: settings.appearance, targetFps: settings.targetFps, resourcePollIntervalSeconds: settings.resourcePollIntervalSeconds });
    tab  = 'connection';
    isOpen = true;
  }

  export function open() {
    openModal();
  }

  export function openTo(t: SettingsTab) {
    connDraft = { protocol: settings.protocol, host: settings.host, port: settings.port };
    settingsSnapshot = JSON.stringify({ appearance: settings.appearance, targetFps: settings.targetFps, resourcePollIntervalSeconds: settings.resourcePollIntervalSeconds });
    tab  = t;
    isOpen = true;
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
    isOpen = false;
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
      resourcePollIntervalSeconds: snap.resourcePollIntervalSeconds,
    });
    isOpen = false;
  }

  function close() { isOpen = false; }

  async function doLogin() {
    const proto = connDraft.protocol === 'wss' ? 'https' : 'http';
    const httpUrl = `${proto}://${connDraft.host}:${String(connDraft.port)}`;
    await auth.login(httpUrl, loginUser, loginPass);
    if (auth.isLoggedIn) loginPass = '';
  }

  // Live-apply appearance as user edits.
  // Uses persist() rather than apply() to avoid reassigning data.appearance — that
  // self-assignment would spuriously re-run the App.svelte $effect that calls track.init().
  function applyAppearance() {
    settings.persist();
  }
</script>

{#if isOpen}
  <div onclick={close} class="backdrop" role="presentation"></div>

  <div class="modal">
    <h2>Settings</h2>

    <div class="tabs">
      <button class="tab" class:active={tab === 'connection'} onclick={() => tab = 'connection'}>Connection</button>
      <button class="tab" class:active={tab === 'vessel'}     onclick={() => tab = 'vessel'}>Own vessel</button>
      <button class="tab" class:active={tab === 'ais'}        onclick={() => tab = 'ais'}>AIS</button>
      <button class="tab" class:active={tab === 'routes'}  onclick={() => { tab = 'routes'; }}>Routes</button>
      <button class="tab" class:active={tab === 'widgets'} onclick={() => { tab = 'widgets'; }}>Widgets</button>
      <button class="tab" class:active={tab === 'about'}   onclick={() => { tab = 'about'; }}>About</button>
    </div>

    {#if tab === 'connection'}
      {#if !connection.connected}
        <div class="conn-warning">
          {#if connection.error}
            ⚠ {connection.error}
          {:else}
            ⚠ Not connected to Signal K
          {/if}
        </div>
      {/if}
      <p class="section-title">Signal K server</p>
      <div class="row">
        <span class="field-label">Protocol</span>
        <div class="field">
          <select bind:value={connDraft.protocol}>
            <option value="ws">ws://</option>
            <option value="wss">wss://</option>
          </select>
        </div>
      </div>
      <div class="row">
        <span class="field-label">Host</span>
        <div class="field">
          <input type="text" bind:value={connDraft.host} placeholder="192.168.1.1" style="flex:1; font-family: monospace;" />
        </div>
      </div>
      <div class="row">
        <span class="field-label">Port</span>
        <div class="field">
          <input type="number" bind:value={connDraft.port} min="1" max="65535" />
        </div>
      </div>
      <p class="hint">→ {connDraft.protocol}://{connDraft.host}:{connDraft.port}/signalk/v1/stream?subscribe=self</p>
      <div class="row">
        <span class="field-label">Waypoint/route poll</span>
        <div class="field" style="gap:6px">
          <input
            type="number"
            min="1" max="3600" step="1"
            style="width:5rem; text-align:right"
            value={settings.resourcePollIntervalSeconds}
            oninput={(e) => {
              const v = parseInt((e.target as HTMLInputElement).value, 10);
              if (v > 0) settings.apply({ resourcePollIntervalSeconds: v });
            }}
          />
          <span style="font-size:13px">seconds</span>
        </div>
      </div>

      <p class="section-title">Position source</p>
      <div class="row">
        <span class="field-label">Browser GPS</span>
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
                  navigator.geolocation.getCurrentPosition(() => { /* noop */ }, () => { /* noop */ });
                }
                // iOS 13+ requires an explicit user-gesture permission for DeviceOrientationEvent.
                if (checked && typeof (window.DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === 'function') {
                  (window.DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> })
                    .requestPermission()
                    .then(r => { if (r !== 'granted') settings.setGeoError('Compass access denied — heading unavailable'); })
                    .catch(() => { /* noop */ });
                }
                settings.apply({ useGeoLocation: checked });
              }}
            />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
          <span class="toggle-label">Use device GPS instead of Signal K position</span>
        </div>
      </div>
      {#if settings.useGeoLocation}
        {@const acc = settings.geoAccuracy}
        {@const quality = acc === null ? 'waiting'
                        : acc < 20    ? 'gps'
                        : acc < 150   ? 'marginal'
                        :               'poor'}
        <div class="geo-accuracy-row">
          <span class="geo-accuracy-dot geo-accuracy-dot--{quality}"></span>
          {#if acc === null}
            <span class="geo-accuracy-label">Waiting for fix…</span>
          {:else}
            <span class="geo-accuracy-label">
              {acc < 20 ? 'GPS' : acc < 150 ? 'WiFi / marginal GPS' : 'Cell tower'} — ±{acc < 1000 ? acc.toFixed(0) + ' m' : (acc / 1000).toFixed(1) + ' km'}
            </span>
          {/if}
        </div>
        {#if acc !== null && acc > 150}
          <p class="geo-error-note">⚠ Accuracy is poor — GPS may not be active. On Android 12+, check that you granted <em>precise</em> (not approximate) location permission.</p>
        {/if}
      {/if}
      {#if settings.geoError && !settings.useGeoLocation}
        <p class="geo-error-note">⚠ {settings.geoError}</p>
      {/if}

      <p class="section-title">Authentication</p>
      {#if auth.isLoggedIn}
        <div class="auth-status">
          <span class="auth-user">✓ Logged in as <strong>{auth.username}</strong></span>
          <button class="btn btn-cancel btn-sm" onclick={() => { auth.logout(); }}>Log out</button>
        </div>
      {:else}
        <div class="row">
          <label for="login-user">Username</label>
          <div class="field">
            <input type="text" id="login-user" bind:value={loginUser} placeholder="admin" autocomplete="username" />
          </div>
        </div>
        <div class="row">
          <label for="login-pass">Password</label>
          <div class="field">
            <input
              type="password"
              id="login-pass"
              bind:value={loginPass}
              placeholder="••••••••"
              autocomplete="current-password"
              onkeydown={(e) => { if (e.key === 'Enter') void doLogin(); }}
            />
            <button class="btn btn-save btn-sm" onclick={() => void doLogin()} disabled={auth.loading || !loginUser || !loginPass}>
              {auth.loading ? 'Logging in…' : 'Log in'}
            </button>
          </div>
        </div>
        {#if auth.error}
          <p class="geo-error-note">⚠ {auth.error}</p>
        {/if}
      {/if}
    {/if}

    {#if tab === 'vessel'}
      <p class="section-title">Icon</p>
      <div class="row">
        <span class="field-label">Color</span>
        <div class="field"><ColorInput bind:value={settings.appearance.vesselColor} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <span class="field-label">Size</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.vesselSize} min="8" max="64" step="2" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>

      <p class="section-title">Track</p>
      <div class="row">
        <span class="field-label">Color</span>
        <div class="field"><ColorInput bind:value={settings.appearance.track.color} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <span class="field-label">Width</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.track.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>
      <div class="row">
        <span class="field-label">Style</span>
        <div class="field">
          <select bind:value={settings.appearance.track.style} onchange={applyAppearance}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dash-dot">Dash-dot</option>
          </select>
        </div>
      </div>
      <div class="row">
        <span class="field-label">History</span>
        <div class="field" style="flex-direction: column; align-items: flex-start; gap: 4px;">
          <input type="range" min="0" max="1000" step="1"
            value={hoursToSlider(settings.appearance.track.historyHours)}
            oninput={(e) => {
              settings.appearance.track.historyHours = sliderToHours(parseInt(e.currentTarget.value));
              applyAppearance();
            }}
            style="width: 100%;"
          />
          <span class="unit">{trackDurationLabel(settings.appearance.track.historyHours)}</span>
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
          <span class="field-label">Color</span>
          <div class="field"><ColorInput bind:value={line.color} oninput={applyAppearance} /></div>
        </div>
        <div class="row">
          <span class="field-label">Width</span>
          <div class="field">
            <input type="number" bind:value={line.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
            <span class="unit">px</span>
          </div>
        </div>
        <div class="row">
          <span class="field-label">Style</span>
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
          <span class="field-label">Length</span>
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
        <span class="field-label">Color</span>
        <div class="field"><ColorInput bind:value={settings.appearance.ais.vesselColor} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <span class="field-label">Size</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ais.vesselSize} min="8" max="48" step="2" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>

      <p class="section-title">COG line</p>
      <div class="row">
        <span class="field-label">Color</span>
        <div class="field"><ColorInput bind:value={settings.appearance.ais.cog.color} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <span class="field-label">Width</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ais.cog.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>
      <div class="row">
        <span class="field-label">Style</span>
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
        <span class="field-label">Length</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ais.cog.lengthMinutes} min="1" max="60" step="1" oninput={applyAppearance} />
          <span class="unit">min</span>
        </div>
      </div>

      <p class="section-title">Track (on click)</p>
      <div class="row">
        <span class="field-label">Show</span>
        <div class="field">
          <label class="toggle">
            <input type="checkbox" bind:checked={settings.appearance.ais.track.show} onchange={applyAppearance} />
            <span class="toggle-track"><span class="toggle-thumb"></span></span>
          </label>
        </div>
      </div>
      <div class="row">
        <span class="field-label">Color</span>
        <div class="field"><ColorInput bind:value={settings.appearance.ais.track.color} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <span class="field-label">Width</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ais.track.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>
      <div class="row">
        <span class="field-label">Style</span>
        <div class="field">
          <select bind:value={settings.appearance.ais.track.style} onchange={applyAppearance}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dash-dot">Dash-dot</option>
          </select>
        </div>
      </div>
      <div class="row">
        <span class="field-label">History</span>
        <div class="field" style="flex-direction: column; align-items: flex-start; gap: 4px;">
          <input type="range" min="0" max="1000" step="1"
            value={hoursToSlider(settings.appearance.ais.track.historyHours)}
            oninput={(e) => {
              settings.appearance.ais.track.historyHours = sliderToHours(parseInt(e.currentTarget.value));
              applyAppearance();
            }}
            style="width: 100%;"
          />
          <span class="unit">{trackDurationLabel(settings.appearance.ais.track.historyHours)}</span>
        </div>
      </div>

      <p class="section-title">Performance</p>
      <div class="row">
        <span class="field-label">Frame rate</span>
        <div class="fps-field">
          <input
            type="range"
            class="fps-slider"
            min="0" max="1000"
            value={fpsToSlider(settings.targetFps)}
            oninput={(e) => { settings.setTargetFps(sliderToFps(+(e.target as HTMLInputElement).value)); }}
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
          <span class="field-label">Color</span>
          <div class="field"><ColorInput bind:value={rl.color} oninput={applyAppearance} /></div>
        </div>
        <div class="row">
          <span class="field-label">Width</span>
          <div class="field">
            <input type="number" bind:value={rl.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
            <span class="unit">px</span>
          </div>
        </div>
        <div class="row">
          <span class="field-label">Style</span>
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

      <p class="section-title">All routes on map</p>
      <div class="row">
        <span class="field-label">Color</span>
        <div class="field"><ColorInput bind:value={settings.appearance.route.allRoutes.color} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <span class="field-label">Width</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.route.allRoutes.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>
      <div class="row">
        <span class="field-label">Style</span>
        <div class="field">
          <select bind:value={settings.appearance.route.allRoutes.style} onchange={applyAppearance}>
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
            <option value="dash-dot">Dash-dot</option>
          </select>
        </div>
      </div>

      <p class="section-title">Route planner</p>
      <div class="row">
        <span class="field-label">Color</span>
        <div class="field"><ColorInput bind:value={settings.appearance.planner.color} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <span class="field-label">Width</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.planner.width} min="1" max="16" step="0.5" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>

      <p class="section-title">Ruler</p>
      <div class="row">
        <span class="field-label">Color</span>
        <div class="field"><ColorInput bind:value={settings.appearance.ruler.color} oninput={applyAppearance} /></div>
      </div>
      <div class="row">
        <span class="field-label">Width</span>
        <div class="field">
          <input type="number" bind:value={settings.appearance.ruler.width} min="1" max="8" step="0.5" oninput={applyAppearance} />
          <span class="unit">px</span>
        </div>
      </div>
    {/if}

    {#if tab === 'widgets'}
      {#if plotterExtensions.extensions.size === 0}
        <p class="hint">No extension widgets available. Make sure your Signal K server has instrument plugins installed and you are connected.</p>
      {:else}
        {#each [...plotterExtensions.extensions.entries()] as [extId, manifest] (extId)}
          {#if manifest.widgets && manifest.widgets.length > 0}
            <p class="section-title">{manifest.name} <span style="opacity:.5;font-size:11px;">v{manifest.version}</span></p>
            {#each manifest.widgets as wDef (wDef.id)}
              <div class="row">
                <span class="field-label">{wDef.title || wDef.id}</span>
                <span style="color:var(--text-dim,rgba(255,255,255,.45));font-size:11px;margin-right:auto;">{wDef.size}</span>
                <button
                  class="btn btn-save"
                  style="padding:4px 12px;font-size:12px;"
                  onclick={() => { plotterExtensions.addWidget(extId, wDef.id); isOpen = false; }}
                >Add to map</button>
              </div>
            {/each}
          {/if}
        {/each}
      {/if}
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
  .backdrop { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,0.5); }
  .modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
    z-index: 21; background: #1e1e2e; color: white; border-radius: 10px;
    padding: 24px; min-width: min(440px, calc(100vw - 32px)); max-width: calc(100vw - 32px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif; max-height: 90vh; overflow-y: auto;
  }
  h2 { margin: 0 0 16px; font-size: 16px; font-weight: 600; }
  .tabs { display: flex; overflow-x: auto; -webkit-overflow-scrolling: touch; border-bottom: 1px solid #333355; margin-bottom: 20px; }
  .tab {
    background: none; border: none; color: #a0a0c0; padding: 8px 18px;
    cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px;
    flex-shrink: 0; white-space: nowrap;
  }
  .tab.active { color: white; border-bottom-color: #4a6cf7; }
  .section-title {
    font-size: 11px; font-weight: 600; color: #666688; text-transform: uppercase;
    letter-spacing: 0.08em; margin: 16px 0 10px;
  }
  .row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .field-label { width: 72px; font-size: 13px; color: #a0a0c0; flex-shrink: 0; }
  .field { flex: 1; display: flex; align-items: center; gap: 8px; }
  .unit { font-size: 12px; color: #666688; }
  .hint { font-size: 11px; color: #666688; margin: 2px 0 12px 84px; word-break: break-all; }
  .geo-error-note { font-size: 11px; color: #f87171; margin: -6px 0 10px 84px; }
  .conn-warning {
    font-size: 12px; color: #f87171; background: rgba(248,113,113,0.1);
    border: 1px solid rgba(248,113,113,0.3); border-radius: 6px;
    padding: 8px 12px; margin-bottom: 12px;
  }
  .auth-status { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .auth-user { font-size: 13px; color: #a0a0c0; flex: 1; }
  .auth-user strong { color: white; }
  .btn-sm { padding: 4px 12px; font-size: 12px; }
  input[type=password] { flex: 1; background: #2a2a3e; border: 1px solid #444466; color: white; padding: 6px 8px; border-radius: 6px; font-size: 13px; }
  .geo-accuracy-row {
    display: flex; align-items: center; gap: 7px;
    margin: -4px 0 8px 84px; font-size: 12px; color: #a0a0c0;
  }
  .geo-accuracy-dot {
    width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
  }
  .geo-accuracy-dot--waiting  { background: #666688; }
  .geo-accuracy-dot--gps      { background: #22c55e; }
  .geo-accuracy-dot--marginal { background: #f59e0b; }
  .geo-accuracy-dot--poor     { background: #f87171; }

  input[type=text], input[type=number], select {
    background: #2a2a3e; border: 1px solid #444466; color: white;
    padding: 6px 8px; border-radius: 6px; font-size: 13px; box-sizing: border-box;
  }
  input[type=text]   { flex: 1; }
  input[type=number] { width: 80px; -moz-appearance: textfield; appearance: textfield; }
  select { cursor: pointer; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }
  .btn { padding: 7px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .btn-cancel { background: transparent; border: 1px solid #444466; color: #a0a0c0; }
  .btn-save   { background: #4a6cf7; border: none; color: white; }
  .fps-field { flex: 1; display: flex; align-items: center; gap: 8px; }
  .fps-slider { flex: 1; min-width: 100px; cursor: pointer; }
  .fps-target { min-width: 5rem; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
  .fps-actual { color: #666688; font-size: 11px; min-width: 3.5rem; text-align: right; font-variant-numeric: tabular-nums; }

  input[type=range] {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    border-radius: 2px;
    background: #444466;
    outline: none;
    cursor: pointer;
  }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #4a6cf7;
    cursor: pointer;
    border: 2px solid #fff;
    box-shadow: 0 0 4px rgba(0,0,0,0.4);
  }
  input[type=range]::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #4a6cf7;
    cursor: pointer;
    border: 2px solid #fff;
    box-shadow: 0 0 4px rgba(0,0,0,0.4);
  }
  input[type=range]::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: #444466;
  }

  .about { padding: 16px 0 8px; text-align: center; }
  .about-logo { width: 80px; height: 80px; border-radius: 16px; margin-bottom: 14px; }
  .about-name { font-size: 20px; font-weight: 700; margin: 0 0 6px; color: white; }
  .about-version { font-size: 13px; color: #a0a0c0; margin: 0 0 16px; font-variant-numeric: tabular-nums; }
  .about-commit { color: #666688; font-family: monospace; }
  .about-desc { font-size: 13px; color: #a0a0c0; margin: 0 0 20px; }
  .about-links { display: flex; gap: 16px; justify-content: center; }
  .about-links a { color: #4a6cf7; font-size: 13px; text-decoration: none; }
  @media (hover: hover) and (pointer: fine) {
    .about-links a:hover { text-decoration: underline; }
  }

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
</style>
