<script lang="ts">
  import { visibility, type VisibilityState } from '../stores/visibility.svelte';

  let { isOpen = $bindable(false) }: { isOpen?: boolean } = $props();

  export function open() { isOpen = true; }

  const ROWS: { key: keyof VisibilityState; label: string; dependsOn?: keyof VisibilityState }[] = [
    { key: 'aisVessels',    label: 'AIS vessels'                                       },
    { key: 'aisTracks',     label: 'AIS tracks',     dependsOn: 'aisVessels' },
    { key: 'aisPredictors', label: 'AIS predictors', dependsOn: 'aisVessels' },
    { key: 'ownTrack',      label: 'Own track'                                         },
    { key: 'routes',        label: 'Routes'                                            },
    { key: 'waypoints',     label: 'Waypoints'                                         },
  ];
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop" onclick={() => { isOpen = false; }} onkeydown={() => { isOpen = false; }}></div>

  <div class="panel">
    <div class="panel-header">
      <span class="panel-title">Visibility</span>
      <button class="close-btn" onclick={() => { isOpen = false; }} title="Close">✕</button>
    </div>

    <ul class="layer-list">
      {#each ROWS as row (row.key)}
        {@const disabled = row.dependsOn !== undefined && !visibility[row.dependsOn]}
        <li class="layer-row" class:layer-row--disabled={disabled}>
          <label class="toggle-row" class:toggle-row--disabled={disabled}>
            <span class="layer-label">{row.label}</span>
            <span class="toggle" class:toggle--on={visibility[row.key]}>
              <input
                type="checkbox"
                checked={visibility[row.key]}
                disabled={disabled}
                onchange={() => { visibility.toggle(row.key); }}
              />
              <span class="toggle-track">
                <span class="toggle-thumb"></span>
              </span>
            </span>
          </label>
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style>
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
    min-width: 220px;
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

  .layer-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }

  .layer-row {
    padding: 0 16px;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 0;
    cursor: pointer;
    border-bottom: 1px solid #2a2a3e;
  }
  .layer-row:last-child .toggle-row { border-bottom: none; }
  .toggle-row--disabled { cursor: not-allowed; }
  .layer-row--disabled .layer-label { color: #44445a; }

  .layer-label {
    font-size: 13px;
    color: #d0d0e8;
    user-select: none;
  }

  /* Toggle switch */
  .toggle input { display: none; }

  .toggle-track {
    display: inline-flex;
    align-items: center;
    width: 34px;
    height: 20px;
    border-radius: 10px;
    background: #3a3a52;
    transition: background 0.18s;
    position: relative;
    flex-shrink: 0;
  }
  .toggle--on .toggle-track { background: #4a6cf7; }

  .toggle-thumb {
    position: absolute;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: rgba(255,255,255,0.5);
    transition: left 0.18s, background 0.18s;
  }
  .toggle--on .toggle-thumb {
    left: 16px;
    background: white;
  }
  .layer-row--disabled .toggle { opacity: 0.3; pointer-events: none; }
</style>
