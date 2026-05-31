<script lang="ts">
  interface Props {
    value: string;
    oninput?: () => void;
  }
  // eslint-disable-next-line @typescript-eslint/no-useless-default-assignment -- $bindable() is a Svelte 5 rune, not a default value
  let { value = $bindable(), oninput }: Props = $props();

  // Keep the text field in sync, but only commit valid 6-digit hex values.
  // eslint-disable-next-line svelte/prefer-writable-derived -- hexText is also written by event handlers
  let hexText = $state(value);
  $effect(() => { hexText = value; });

  function onSwatchInput(e: Event) {
    value = (e.target as HTMLInputElement).value;
    hexText = value;
    oninput?.();
  }

  function onTextInput(e: Event) {
    hexText = (e.target as HTMLInputElement).value;
    // Accept #rrggbb or rrggbb
    const hex = hexText.startsWith('#') ? hexText : `#${hexText}`;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      value = hex;
      oninput?.();
    }
  }

  function onTextBlur() {
    // Revert the text field to the last valid value if the user left it incomplete.
    hexText = value;
  }
</script>

<div class="color-input">
  <input type="color" value={value} oninput={onSwatchInput} class="swatch" />
  <input
    type="text"
    value={hexText}
    oninput={onTextInput}
    onblur={onTextBlur}
    class="hex-field"
    maxlength={7}
    spellcheck={false}
    autocomplete="off"
  />
</div>

<style>
  .color-input { display: flex; align-items: center; gap: 6px; }
  .swatch {
    width: 36px; height: 30px; flex-shrink: 0;
    border: 1px solid #444466; border-radius: 6px;
    cursor: pointer; padding: 2px; background: none;
  }
  .hex-field {
    width: 76px; font-family: monospace; font-size: 13px;
    background: #2a2a3e; border: 1px solid #444466; color: white;
    padding: 6px 8px; border-radius: 6px; box-sizing: border-box;
  }
</style>
