<script lang="ts">
  import { charts } from '../stores/charts.svelte';
  import { baseLayers, BASE_LAYERS } from '../stores/baseLayers.svelte';

  let open = $state(false);

  function toggle() { open = !open; }
  function close()  { open = false; }
</script>

<!-- Layers button -->
<button class="charts-btn" class:active={open} onclick={toggle} title="Charts">
  ⊞
</button>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={close} onkeydown={close}></div>

  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Layers</span>
      <button class="close-btn" onclick={close} title="Close">✕</button>
    </div>

    <!-- Base layers -->
    <p class="section-title">Base layers</p>
    <ul class="chart-list">
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
    </ul>

    <!-- SignalK charts -->
    <p class="section-title">Charts from Signal K</p>
    {#if charts.loading}
      <p class="hint">Loading charts…</p>
    {:else if charts.error}
      <p class="hint error">⚠ {charts.error}</p>
    {:else if Object.keys(charts.available).length === 0}
      <p class="hint">No charts available from the Signal K server.</p>
    {:else}
      <ul class="chart-list">
        {#each Object.entries(charts.available) as [id, chart] (id)}
          <li class="chart-row">
            <input
              type="checkbox"
              id="cp-chart-{id}"
              checked={charts.selected.has(id)}
              onchange={() => { charts.toggle(id); }}
            />
            <div class="chart-info">
              <label for="cp-chart-{id}" class="chart-name">{chart.name}</label>
              {#if chart.description}<span class="chart-desc">{chart.description}</span>{/if}
              <span class="chart-meta">{chart.format.toUpperCase()}{chart.scale ? ` · 1:${chart.scale.toLocaleString()}` : ''}</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
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

  .hint {
    font-size: 12px;
    color: #666688;
    padding: 4px 16px 12px;
    margin: 0;
  }
  .hint.error { color: #f87171; }

  .section-title {
    font-size: 10px;
    font-weight: 600;
    color: #666688;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0;
    padding: 10px 16px 4px;
    border-top: 1px solid #2a2a3e;
  }
  .section-title:first-of-type { border-top: none; padding-top: 6px; }

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

  .chart-info  { display: flex; flex-direction: column; gap: 2px; }
  .chart-name  { font-size: 13px; color: white; cursor: pointer; }
  .chart-desc  { font-size: 11px; color: #a0a0c0; }
  .chart-meta  { font-size: 11px; color: #666688; }
</style>
