<script setup lang="ts">
// Force or Fixed layout, and a Spread slider that moves every node closer together or farther apart. The slider is
// logarithmic: 1× in the middle, 0.2× at the left, 5× at the right.
import { computed } from 'vue'

const mode = defineModel<'force' | 'fixed'>('mode', { required: true })
const spread = defineModel<number>('spread', { required: true })

const MAX = Math.log(5)
const slider = computed({
  get: () => Math.round((Math.log(spread.value) / MAX) * 100),
  set: (v: number) => (spread.value = Math.round(Math.exp((v / 100) * MAX) * 100) / 100),
})
const label = computed(() => `${spread.value < 1 ? spread.value.toFixed(2) : spread.value.toFixed(1)}×`)
</script>

<template>
  <div class="lc">
    <div class="lc-seg" role="group" aria-label="Layout">
      <button :class="{ on: mode === 'force' }" :aria-pressed="mode === 'force'" title="Nodes pull on their neighbours and push the rest away" @click="mode = 'force'">Force</button>
      <button :class="{ on: mode === 'fixed' }" :aria-pressed="mode === 'fixed'" title="Nodes locked in place, spread out by group" @click="mode = 'fixed'">Fixed</button>
    </div>
    <label class="lc-spread">
      <span class="lc-eyebrow">Spread</span>
      <input v-model.number="slider" type="range" min="-100" max="100" step="1" aria-label="Spread: how far apart the nodes are" :aria-valuetext="label" @dblclick="spread = 1" />
      <output>{{ label }}</output>
    </label>
  </div>
</template>

<style scoped>
.lc { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.lc-seg { display: inline-flex; border: 1px solid var(--vp-c-divider); border-radius: 8px; overflow: hidden; height: 36px; }
.lc-seg button { padding: 0 12px; font-weight: 500; font-size: 14px; color: var(--vp-c-text-2); }
.lc-seg button.on { background: var(--vp-c-brand-1); color: var(--vp-c-white); }
.lc-seg button:focus-visible, .lc-spread input:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.lc-spread { display: inline-flex; align-items: center; gap: 8px; height: 36px; }
.lc-eyebrow { font-family: var(--vp-font-family-brand, 'Martian Mono', monospace); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vp-c-text-2); }
.lc-spread input { width: 140px; accent-color: var(--vp-c-brand-1); }
.lc-spread output { min-width: 3.5em; font-family: var(--vp-font-family-mono); font-size: 13px; font-variant-numeric: tabular-nums; color: var(--vp-c-text-1); }
</style>
