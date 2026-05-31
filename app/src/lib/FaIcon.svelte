<script lang="ts">
  import { icon as renderIcon } from '@fortawesome/fontawesome-svg-core';
  import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

  let { icon }: { icon: IconDefinition } = $props();

  const svg = $derived(renderIcon(icon).html[0]);
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- SVG is from FontAwesome library, not user input -->
{@html svg}
