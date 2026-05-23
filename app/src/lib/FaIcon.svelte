<script lang="ts">
  import { icon as renderIcon } from '@fortawesome/fontawesome-svg-core';
  import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

  let { icon }: { icon: IconDefinition } = $props();

  const svg = $derived(renderIcon(icon).html[0]);
</script>

{@html svg}
