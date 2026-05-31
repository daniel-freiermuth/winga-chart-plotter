<script lang="ts">
  import { charts } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS } from '../stores/baseLayers.svelte';
  import FaIcon from '../lib/FaIcon.svelte';
  import { faLayerGroup } from '@fortawesome/free-solid-svg-icons';

  let open = $state(false);
  // Track pending manual URL inputs per chart id
  let manualInputs = $state<Record<string, string>>({});

  function toggle() { open = !open; }
  function close()  { open = false; }

  function applyManualUrl(id: string) {
    charts.setOverride(id, manualInputs[id] ?? '');
  }
</script>

<!-- Layers button -->
<button class="charts-btn" class:active={open} onclick={toggle} title="Charts">
  <FaIcon icon={faLayerGroup} />
</button>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close} onkeydown={close}></div>

  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Layers</span>
      <button class="close-btn" onclick={close} title="Close">✕</button>
    </div>

    <ul class="chart-list">
      <!-- Base layers -->
      {#each BASE_LAYERS as layer (layer.id)}
        <li class="chart-row">
          <input
            type="checkbox"
            id="base-{layer.id}"
            checked={baseLayers.enabled.has(layer.id)}
            onchange={() => { baseLayers.toggle(layer.id); }}
          />
          <label for="base-{layer.id}" class="chart-name">{layer.name}</label>
        </li>
      {/each}

      <!-- SignalK charts -->
      {#if charts.loading}
        <li class="chart-row hint-row">Loading charts…</li>
      {:else if charts.error}
        <li class="chart-row hint-row error">⚠ {charts.error}</li>
      {:else}
        {#each Object.entries(charts.available) as [id, chart] (id)}
          <li class="chart-row">
            <input
              type="checkbox"
              id="cp-chart-{id}"
              checked={charts.selected.has(id)}
              disabled={charts.needsManualUrl(id)}
              onchange={() => { charts.toggle(id); }}
            />
            <div class="chart-info">
              <label for="cp-chart-{id}" class="chart-name">
                {chart.name}
                {#if chart.type === 'WMS'}<span class="badge">WMS</span>{/if}
                {#if chart.type === 'WMTS'}<span class="badge">WMTS</span>{/if}
              </label>
              {#if chart.description}<span class="chart-desc">{chart.description}</span>{/if}
              <span class="chart-meta">{chart.format.toUpperCase()}{chart.scale ? ` · 1:${chart.scale.toLocaleString()}` : ''}</span>
              {#if charts.needsManualUrl(id)}
                <span class="wmts-warning">⚠ Cannot auto-discover tile URL (CORS). Enter template manually:</span>
                <div class="wmts-manual">
                  <input
                    type="text"
                    class="wmts-input"
                    placeholder={"https://…/{z}/{x}/{y}.png"}
                    value={manualInputs[id] ?? charts.getOverride(id)}
                    oninput={(e) => { manualInputs[id] = (e.target as HTMLInputElement).value; }}
                    onkeydown={(e) => { if (e.key === 'Enter') applyManualUrl(id); }}
                  />
                  <button class="wmts-apply" onclick={() => { applyManualUrl(id); }}>Apply</button>
                </div>
              {:else if chart.type === 'WMTS' && charts.getOverride(id)}
                <span class="wmts-ok">✓ Custom URL active</span>
                <button class="wmts-clear" onclick={() => { charts.setOverride(id, ''); manualInputs[id] = ''; }}>Clear</button>
              {:else if chart.type === 'WMTS'}
                {#if (charts.visibleLayers(id).length) > 1}
                  <div class="wmts-layer-row">
                    <label class="wmts-layer-label" for="wmts-layer-{id}">Layer</label>
                    <select
                      id="wmts-layer-{id}"
                      class="wmts-layer-select"
                      value={charts.getLayerSel(id)}
                      onchange={(e) => { void charts.selectLayer(id, (e.target as HTMLSelectElement).value); }}
                    >
                      {#each charts.visibleLayers(id) as layer (layer.id)}
                        <option value={layer.id}>{layer.title}</option>
                      {/each}
                    </select>
                    {#if charts.hasFilter(id)}
                      <label class="wmts-showall-label" title="Show all layers from capabilities">
                        <input
                          type="checkbox"
                          checked={charts.isShowingAll(id)}
                          onchange={() => { charts.toggleShowAll(id); }}
                        /> All
                      </label>
                    {/if}
                  </div>
                {:else if charts.visibleLayers(id).length === 1}
                  <span class="wmts-ok">Layer: {charts.visibleLayers(id)[0]?.title}</span>
                {/if}
              {/if}
            </div>
          </li>
        {/each}
      {/if}
    </ul>
  </div>
{/if}

<style>
  .charts-btn {
    position: absolute;
    top: 80px;
    left: 10px;
    z-index: 10;
    background: rgba(0,0,0,0.7);
    border: none;
    color: white;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 16px;
    transition: background 0.15s;
  }
  .charts-btn:hover  { background: rgba(40,40,80,0.9); }
  .charts-btn.active { background: rgba(37,99,235,0.85); border: 1px solid #3b82f6; }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
  }

  .panel {
    position: absolute;
    top: 44px;
    left: 50px;
    z-index: 21;
    background: #1e1e2e;
    color: white;
    border-radius: 10px;
    padding: 0;
    min-width: 280px;
    max-width: 360px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    font-family: system-ui, sans-serif;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px 10px;
    border-bottom: 1px solid #2a2a3e;
    flex-shrink: 0;
  }
  .panel-title {
    font-size: 13px;
    font-weight: 600;
    color: white;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .close-btn {
    background: none;
    border: none;
    color: #666688;
    cursor: pointer;
    font-size: 14px;
    padding: 0 2px;
  }
  .close-btn:hover { color: white; }

  .hint-row {
    font-size: 12px;
    color: #666688;
    padding: 10px 16px;
    list-style: none;
  }
  .hint-row.error { color: #f87171; }

  .chart-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
  }

  .chart-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid #2a2a3e;
  }
  .chart-row:last-child { border-bottom: none; }
  .chart-row input[type=checkbox] { margin-top: 3px; flex-shrink: 0; cursor: pointer; }

  .chart-info  { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .chart-name  { font-size: 13px; color: white; cursor: pointer; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .chart-desc  { font-size: 11px; color: #a0a0c0; }
  .chart-meta  { font-size: 11px; color: #666688; }

  .badge {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    background: #2a2a4e;
    color: #7b8cde;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .wmts-warning {
    font-size: 11px;
    color: #f59e0b;
    margin-top: 4px;
  }
  .wmts-manual {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .wmts-input {
    flex: 1;
    font-size: 11px;
    padding: 3px 6px;
    background: #2a2a3e;
    border: 1px solid #444466;
    border-radius: 4px;
    color: white;
    min-width: 0;
  }
  .wmts-apply {
    font-size: 11px;
    padding: 3px 8px;
    background: #2563eb;
    border: none;
    border-radius: 4px;
    color: white;
    cursor: pointer;
    white-space: nowrap;
  }
  .wmts-apply:hover { background: #1d4ed8; }
  .wmts-ok {
    font-size: 11px;
    color: #34d399;
    margin-top: 2px;
  }
  .wmts-clear {
    font-size: 10px;
    background: none;
    border: 1px solid #444466;
    border-radius: 4px;
    color: #666688;
    cursor: pointer;
    padding: 1px 6px;
    margin-top: 2px;
    align-self: flex-start;
  }
  .wmts-clear:hover { color: #f87171; border-color: #f87171; }

  .wmts-layer-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .wmts-layer-label {
    font-size: 11px;
    color: #666688;
    flex-shrink: 0;
  }
  .wmts-layer-select {
    flex: 1;
    font-size: 11px;
    padding: 2px 4px;
    background: #2a2a3e;
    border: 1px solid #444466;
    border-radius: 4px;
    color: white;
    cursor: pointer;
  }
  .wmts-showall-label {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: #666688;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .wmts-showall-label:hover { color: #a0a0c0; }
</style>
