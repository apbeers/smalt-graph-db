<script setup lang="ts">
// The tech demo: a large generated network, drawn whole by the GPU renderer in 2D or 3D. Searches and queries
// highlight their results inside it, and the numbers show what each step took.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import { connect, type GraphClient } from '../../../../src/worker/client'
import { createGraphView, GpuUnavailableError, type GraphView } from '../../../../src/render/index'
import GraphControls from './GraphControls.vue'
import { createTimeline, type Timeline } from '../../../../src/timeline/index'
import { Scrubber, VersionedDrawing } from '../versioned-drawing'

const { isDark } = useData()

const SIZES = [10_000, 25_000, 50_000, 100_000]
// 10,000 by default: it lays out quickly on most GPUs. The larger sizes are a click away.
const size = ref(10_000)
// 'history': a MemoryStore with the network's growth, a commit per person, and the timeline to scrub through it.
const store = ref<'history' | 'memory' | 'csr'>('history')
const mode = ref<'2d' | '3d'>('2d')
const labels = ref(false)
const search = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const gpuError = ref<string | null>(null)
const highlightText = ref('')

const nums = ref({ nodes: 0, rels: 0, loadMs: 0, transferMs: 0, drawMs: 0, fps: 0, tickMs: 0, layout: false, queryMs: 0, rows: 0 })

const SEARCHES = ['Bo 1', 'Yara', 'Kai 7', 'Lisbon']
const QUERIES = [
  { title: 'Two hops from Bo 1', query: "MATCH (:Person {name: 'Bo 1'})-[:KNOWS*1..2]-(f)\nRETURN DISTINCT f" },
  { title: 'Shortest path', query: "MATCH (a:Person {name: 'Bo 1'}), (b:Person {name: 'Gus 6'})\nMATCH p = shortestPath((a)-[:KNOWS*]-(b))\nRETURN p" },
  { title: 'The 50 most connected', query: 'MATCH (p:Person)-[:KNOWS]-(f)\nWITH p, count(f) AS friends\nORDER BY friends DESC LIMIT 50\nRETURN p' },
  { title: 'Everyone in Lisbon', query: "MATCH (p:Person)-[:LIVES_IN]->(:City {name: 'Lisbon'})\nRETURN p" },
  { title: 'Community 3', query: 'MATCH (p:Person {community: 3})\nRETURN p' },
  { title: 'Over 70 who know someone under 20', query: 'MATCH (a:Person)-[:KNOWS]-(b:Person)\nWHERE a.age > 70 AND b.age < 20\nRETURN a, b' },
]
const query = ref(QUERIES[0]!.query)

const canvas = ref<HTMLCanvasElement | null>(null)
let client: GraphClient | null = null
let view: GraphView | null = null
let timer = 0
/** Engine id → index in the drawing. */
let indexOf = new Map<number, number>()

/** The drawing at the version the timeline shows, coloured by community. */
const drawing = new VersionedDrawing((labels, community) => (labels.includes('City') ? 'City' : `Community ${community ?? ''}`), 'community')
const tlHost = ref<HTMLElement | null>(null)
let timeline: Timeline | null = null
const latest = ref(0)
const viewing = ref(0)
const scrubMs = ref(0)
const scrubber = new Scrubber(
  drawing,
  async (a, b) => {
    const t0 = performance.now()
    const d = await client!.diff(a, b)
    scrubMs.value = performance.now() - t0
    return d
  },
  (changed) => drawNow({ animate: true, changed }),
)

/** Draws the drawing; the index of engine ids follows its order, for highlighting. */
function drawNow(opts: { animate?: boolean; changed?: number[] } = {}) {
  if (!view) return
  const g = drawing.render()
  indexOf = new Map(drawing.order.map((id, i) => [id, i]))
  view.setGraph(g, { keepPositions: true, ...opts })
}

/** One load at a time: a change of size or store while loading runs once the current load ends. */
let loading: Promise<void> | null = null
let again = false
function load(): Promise<void> {
  if (loading) {
    again = true
    return loading
  }
  loading = (async () => {
    do {
      again = false
      await loadOnce()
    } while (again)
    loading = null
  })()
  return loading
}

async function loadOnce() {
  if (!client) return
  busy.value = true
  error.value = null
  highlightText.value = ''
  try {
    const history = store.value === 'history'
    const loaded = await client.dataset({ name: 'network', size: size.value, ...(history ? { history: true } : { store: store.value as 'memory' | 'csr' }) })
    nums.value.nodes = loaded.nodes
    nums.value.rels = loaded.relationships
    if (!loaded.reused) nums.value.loadMs = loaded.ms
    latest.value = viewing.value = loaded.version ?? 0
    const ov = await client.overview(undefined, { groupKey: 'community' })
    nums.value.transferMs = ov.ms
    drawing.reset(ov, latest.value)
    if (view) {
      const t1 = performance.now()
      view.setGraph({ nodes: [], edges: [] })
      drawNow()
      view.fit()
      nums.value.drawMs = performance.now() - t1
    }
    // The timeline: the network's growth, a commit per person.
    if (history) {
      const commits = (await client.commits()).map((c) => ({ version: c.version, time: c.time, author: c.author, message: c.message, size: c.size }))
      if (!timeline && tlHost.value) timeline = createTimeline(tlHost.value, { commits, value: latest.value, theme: isDark.value ? 'dark' : 'light', onChange: (v) => {
        viewing.value = v
        scrubber.to(v)
      } })
      else {
        timeline?.setCommits(commits)
        timeline?.setValue(latest.value)
      }
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

async function run(q = query.value) {
  if (!client || busy.value) return
  query.value = q
  busy.value = true
  error.value = null
  try {
    // At a past version, queries read that version.
    const r = await client.run(viewing.value < latest.value ? `AT VERSION ${viewing.value}\n${q}` : q)
    nums.value.queryMs = r.ms
    // The nodes in the result, highlighted in the whole drawing.
    const hit = new Set<number>()
    const visit = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return
      if (Array.isArray(v)) return v.forEach(visit)
      const o = v as { kind?: string; id?: number; nodes?: unknown[] }
      if (o.kind === 'node') {
        const i = indexOf.get(o.id!)
        if (i !== undefined) hit.add(i)
      } else if (o.kind === 'path') o.nodes!.forEach(visit)
      else if (!o.kind) Object.values(v).forEach(visit)
    }
    r.rows.forEach(visit)
    nums.value.rows = r.rows.length
    const list = [...hit]
    view?.highlight(list.length ? list : null)
    if (list.length === 1 || (list.length && list.length < 40)) view?.focus(list[0]!)
    highlightText.value = `${list.length.toLocaleString()} node${list.length === 1 ? '' : 's'} highlighted from ${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'}`
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function doSearch(text: string) {
  search.value = text
}

function clear() {
  search.value = ''
  highlightText.value = ''
  view?.highlight(null)
  view?.fit()
}

watch(search, (s) => {
  if (!view) return
  if (!s.trim()) return void view.highlight(null)
  const t0 = performance.now()
  const hits = view.search(s)
  highlightText.value = `"${s}": ${hits.length.toLocaleString()} match${hits.length === 1 ? '' : 'es'} in ${(performance.now() - t0).toFixed(1)} ms`
  if (hits.length && hits.length < 40) view.focus(hits[0]!)
})
watch(mode, (m) => view?.setMode(m))
watch(labels, (on) => view?.setLabels(on))
watch(isDark, (d) => {
  view?.setTheme(d ? 'dark' : 'light')
  timeline?.setTheme(d ? 'dark' : 'light')
})
watch([size, store], load)

onMounted(async () => {
  client = connect(new Worker(new URL('../../../../src/worker/worker.ts', import.meta.url), { type: 'module', name: 'smaltcy' }))
  try {
    view = await createGraphView(canvas.value!, { mode: mode.value, theme: isDark.value ? 'dark' : 'light', labels: labels.value })
  } catch (e) {
    gpuError.value = e instanceof GpuUnavailableError ? 'This demo draws with WebGPU, which this browser doesn\'t offer. The queries still run.' : `The graph view couldn't start: ${(e as Error).message}`
  }
  timer = window.setInterval(() => {
    if (!view) return
    const s = view.stats()
    nums.value.fps = s.fps
    nums.value.tickMs = s.layoutMsPerTick
    nums.value.layout = view.layout.running
  }, 400)
  await load()
})

onBeforeUnmount(() => {
  timeline?.destroy()
  clearInterval(timer)
  view?.destroy()
  client?.close()
})

const ms = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString())
</script>

<template>
  <div class="td">
    <div class="td-bar">
      <label class="td-field">
        <span class="td-eyebrow">People</span>
        <select v-model.number="size" :disabled="busy">
          <option v-for="s in SIZES" :key="s" :value="s">{{ s.toLocaleString() }}</option>
        </select>
      </label>
      <label class="td-field">
        <span class="td-eyebrow">Store</span>
        <select v-model="store" :disabled="busy">
          <option value="history">With its history: MemoryStore and a timeline</option>
          <option value="csr">CsrStore (read-only, compact), no history</option>
          <option value="memory">MemoryStore, no history</option>
        </select>
      </label>
      <div class="td-seg" role="group" aria-label="View">
        <button :class="{ on: mode === '2d' }" @click="mode = '2d'">2D</button>
        <button :class="{ on: mode === '3d' }" @click="mode = '3d'">3D</button>
      </div>
      <label class="td-check"><input v-model="labels" type="checkbox" /> Labels</label>
      <button class="td-ghost" @click="view?.layout.reheat()">Re-run layout</button>
      <button class="td-ghost" @click="clear">Clear highlight</button>
    </div>

    <div class="td-nums" aria-live="polite">
      <div><b>{{ nums.nodes.toLocaleString() }}</b><span>nodes</span></div>
      <div><b>{{ nums.rels.toLocaleString() }}</b><span>relationships</span></div>
      <div><b>{{ ms(nums.loadMs) }} ms</b><span>generate and load (worker)</span></div>
      <div><b>{{ ms(nums.transferMs) }} ms</b><span>prepare for drawing (worker)</span></div>
      <div><b>{{ ms(nums.drawMs) }} ms</b><span>upload to the GPU</span></div>
      <div><b>{{ Math.round(nums.fps) }}</b><span>frames per second</span></div>
      <div><b>{{ nums.layout ? ms(nums.tickMs) + ' ms' : 'at rest' }}</b><span>{{ nums.layout ? 'GPU layout per tick' : 'layout' }}</span></div>
      <div><b>{{ ms(nums.queryMs) }} ms</b><span>last query</span></div>
      <div v-if="store === 'history'"><b>{{ ms(scrubMs) }} ms</b><span>last timeline step (diff in the worker)</span></div>
    </div>

    <div class="td-main">
      <section class="td-view">
        <canvas ref="canvas" class="td-canvas" />
        <div v-if="gpuError" class="td-gpu">{{ gpuError }}</div>
        <div v-if="highlightText" class="td-highlight">{{ highlightText }}</div>
        <GraphControls v-if="!gpuError" :mode="mode" />
      </section>
      <div v-show="store === 'history'" class="td-tl">
        <p class="td-tl-note">
          <span v-if="viewing < latest">Version {{ viewing.toLocaleString() }} of {{ latest.toLocaleString() }}: queries read this version.</span>
          <span v-else>The network as it grew, a person at a time: drag the timeline, or press Play.</span>
        </p>
        <div ref="tlHost" />
      </div>
      <aside class="td-side">
        <label class="td-field">
          <span class="td-eyebrow">Search the drawing (on the GPU's captions)</span>
          <input v-model="search" type="search" placeholder="A name or a city" />
        </label>
        <div class="td-chips">
          <button v-for="s in SEARCHES" :key="s" class="td-chip" @click="doSearch(s)">{{ s }}</button>
        </div>
        <span class="td-eyebrow">Query, and highlight the result</span>
        <div class="td-chips">
          <button v-for="q in QUERIES" :key="q.title" class="td-chip" :disabled="busy" :title="q.query" @click="run(q.query)">{{ q.title }}</button>
        </div>
        <textarea v-model="query" class="td-query" spellcheck="false" aria-label="Cypher query" @keydown.ctrl.enter.prevent="run()" @keydown.meta.enter.prevent="run()" />
        <button class="td-primary" :disabled="busy" @click="run()">Run and highlight</button>
        <p v-if="error" class="td-error" role="alert"><b>Error</b> {{ error }}</p>
        <p class="td-note">
          The network grows by preferential attachment: well-connected people make more friends, mostly within their
          community. It's generated in the engine's worker; the layout runs in WebGPU compute shaders. Above 20,480
          nodes the layout samples repulsion each tick.
        </p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.td { display: flex; flex-direction: column; gap: 12px; }
.td-bar { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
.td-field { display: flex; flex-direction: column; gap: 4px; }
.td-eyebrow { font-family: var(--vp-font-family-brand, 'Martian Mono', monospace); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vp-c-text-2); }
select, input[type='search'] { height: 36px; padding: 0 10px; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg); color: var(--vp-c-text-1); font: inherit; font-size: 14px; }
select:focus-visible, input:focus-visible, button:focus-visible, textarea:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.td-seg { display: inline-flex; border: 1px solid var(--vp-c-divider); border-radius: 8px; overflow: hidden; height: 36px; }
.td-seg button { padding: 0 14px; font-weight: 500; font-size: 14px; color: var(--vp-c-text-2); }
.td-seg button.on { background: var(--vp-c-brand-1); color: var(--vp-c-white); }
.td-check { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; height: 36px; }
.td-ghost { height: 36px; padding: 0 12px; border: 1px solid var(--vp-c-divider); border-radius: 8px; font-size: 14px; font-weight: 500; }
.td-ghost:hover { border-color: var(--vp-c-brand-1); }
.td-nums { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
.td-nums div { padding: 10px 12px; border: 1px solid var(--vp-c-divider); border-radius: 10px; background: var(--vp-c-bg-soft); }
.td-nums b { display: block; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.td-nums span { font-size: 12px; color: var(--vp-c-text-2); }
.td-main { display: grid; grid-template-columns: 1fr 340px; grid-template-rows: 1fr auto; gap: 12px; height: calc(100vh - var(--vp-nav-height) - 240px); min-height: 560px; }
.td-view { grid-column: 1; grid-row: 1; }
.td-side { grid-column: 2; grid-row: 1 / span 2; }
.td-tl { grid-column: 1; grid-row: 2; display: flex; flex-direction: column; gap: 6px; }
.td-tl-note { margin: 0; font-size: 13px; color: var(--vp-c-text-2); }
.td-view { position: relative; border: 1px solid var(--vp-c-divider); border-radius: 10px; overflow: hidden; background: var(--vp-c-bg-alt); }
.td-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.td-gpu { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--vp-c-text-2); }
.td-highlight { position: absolute; left: 10px; bottom: 10px; padding: 4px 10px; border-radius: 6px; background: var(--vp-c-bg); border: 1px solid var(--vp-c-divider); font-family: var(--vp-font-family-mono); font-size: 12px; }
.td-side { display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.td-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.td-chip { padding: 4px 10px; border: 1px solid var(--vp-c-divider); border-radius: 999px; font-size: 13px; }
.td-chip:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.td-query { min-height: 110px; padding: 10px 12px; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-code-block-bg); color: var(--vp-c-text-1); font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.6; resize: vertical; }
.td-primary { height: 36px; border-radius: 8px; background: var(--vp-c-brand-1); color: var(--vp-c-white); font-weight: 600; font-size: 14px; }
.td-primary:disabled { opacity: 0.6; }
.td-error { margin: 0; color: var(--vp-c-danger-1); font-size: 14px; }
.td-note { margin: 0; color: var(--vp-c-text-2); font-size: 13px; line-height: 1.5; }
@media (max-width: 960px) {
  .td-main { grid-template-columns: 1fr; grid-template-rows: auto; height: auto; }
  .td-view, .td-side, .td-tl { grid-column: 1; grid-row: auto; }
  .td-view { height: 65vh; }
}
</style>
