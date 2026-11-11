<script setup lang="ts">
// How to move around a graph view, for the mode it's in. Touch screens get the touch gestures.
import { computed } from 'vue'
import { controlsHint } from '../graph-results'

const props = defineProps<{ mode: '2d' | '3d' }>()
const hint = computed(() => controlsHint(props.mode))
</script>

<template>
  <div class="gc" aria-label="Graph controls">
    <span class="gc-mouse">{{ hint.mouse }}</span>
    <span class="gc-touch">{{ hint.touch }}</span>
  </div>
</template>

<style scoped>
.gc { position: absolute; right: 10px; top: 8px; max-width: calc(100% - 20px); padding: 2px 8px; border-radius: 6px; background: color-mix(in srgb, var(--vp-c-bg) 85%, transparent); font-size: 12px; color: var(--vp-c-text-2); pointer-events: none; text-align: right; }
.gc-touch { display: none; }
@media (pointer: coarse) {
  .gc-touch { display: inline; }
  .gc-mouse { display: none; }
}
</style>
