<script setup lang="ts">
// The tech demo: a generated graph with the shape of a real system (a social network, an org chart, package
// dependencies…), drawn whole by the GPU renderer in 2D or 3D. Searches and queries highlight their results inside
// it, and the numbers show what each step took.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData } from 'vitepress'
import { connect, type GraphClient } from '../../../../src/worker/client'
import { createGraphView, GpuUnavailableError, type GraphView } from '../../../../src/render/index'
import GraphControls from './GraphControls.vue'
import LayoutControls from './LayoutControls.vue'
import { createTimeline, type Timeline } from '../../../../src/timeline/index'
import { Scrubber, VersionedDrawing } from '../versioned-drawing'
import { DEMO_DATASETS } from '../demo-datasets'

const { isDark } = useData()

// Small sizes to read every node; large ones to see the engine and renderer work. 10,000 by default: it lays out
// quickly on most GPUs.
const SIZES = [50, 200, 1_000, 10_000, 25_000, 50_000, 100_000]
const size = ref(10_000)
/** Which real system the graph has the shape of. */
const datasetName = ref<string>(DEMO_DATASETS[0]!.name)
const ds = computed(() => DEMO_DATASETS.find((d) => d.name === datasetName.value) ?? DEMO_DATASETS[0]!)
/** Graphs this small show their captions unless the reader turns them off. */
const LABELS_UP_TO = 1_000
// 'history': a MemoryStore with the graph's growth, a commit per step, and the timeline to scrub through it.
const store = ref<'history' | 'memory' | 'csr'>('history')
const mode = ref<'2d' | '3d'>('2d')
/** Force (physics) or Fixed (locked, spread out by group), and how far apart the nodes are. */
const layoutMode = ref<'force' | 'fixed'>('force')
const spread = ref(1)
const labels = ref(false)
/** The reader set Labels themselves: stop following the size. */
let labelsTouched = false
const search = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const gpuError = ref<string | null>(null)
const highlightText = ref('')

/** The node under the pointer, and the one clicked: its properties and connections, read from the engine. */
const hover = ref<{ x: number; y: number; text: string } | null>(null)
const pointer = { x: 0, y: 0 }
interface Details {
  id: number
  labels: string[]
  properties: Record<string, unknown>
  city: string | null
  connections: { type: string; out: boolean; name: string }[]
  created: string | null
}
const details = ref<Details | null>(null)

const nums = ref({ nodes: 0, rels: 0, loadMs: 0, transferMs: 0, drawMs: 0, fps: 0, tickMs: 0, layout: false, queryMs: 0, rows: 0 })

const query = ref(ds.value.queries[0]!.query)

const canvas = ref<HTMLCanvasElement | null>(null)
let client: GraphClient | null = null
let view: GraphView | null = null
let timer = 0
/** Engine id → index in the drawing. */
let indexOf = new Map<number, number>()

/** The drawing at the version the timeline shows, coloured by the dataset's group (a community, a department…). */
const drawing = new VersionedDrawing()
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
    const d = ds.value
    drawing.groupOf = d.group
    drawing.groupKey = d.groupKey
    const loaded = await client.dataset({ name: d.name, size: size.value, ...(history ? { history: true } : { store: store.value as 'memory' | 'csr' }) })
    nums.value.nodes = loaded.nodes
    nums.value.rels = loaded.relationships
    if (!loaded.reused) nums.value.loadMs = loaded.ms
    latest.value = viewing.value = loaded.version ?? 0
    const ov = await client.overview(undefined, { groupKey: d.groupKey })
    nums.value.transferMs = ov.ms
    drawing.reset(ov, latest.value)
    if (view) {
      const t1 = performance.now()
      view.setGraph({ nodes: [], edges: [] })
      drawNow()
      view.fit()
      nums.value.drawMs = performance.now() - t1
    }
    // The timeline: the graph's growth, a commit per step.
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
  details.value = null
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
watch(layoutMode, (m) => view?.setLayoutMode(m))
watch(spread, (s) => view?.setSpread(s))
watch(labels, (on) => view?.setLabels(on))
watch(isDark, (d) => {
  view?.setTheme(d ? 'dark' : 'light')
  timeline?.setTheme(d ? 'dark' : 'light')
})
watch(datasetName, () => {
  query.value = ds.value.queries[0]!.query
  search.value = ''
  syncLink()
})
watch([size, store, datasetName], () => {
  details.value = null
  if (!labelsTouched) labels.value = size.value <= LABELS_UP_TO
  return load()
})

/** A node's details at the version shown, and its neighbours highlighted. */
async function select(index: number | null) {
  if (index === null || !client) {
    details.value = null
    return
  }
  const id = drawing.order[index]
  if (id === undefined) return
  const at = viewing.value < latest.value ? `AT VERSION ${viewing.value}\n` : ''
  const r = await client.run(
    `${at}MATCH (n) WHERE id(n) = $id
     OPTIONAL MATCH (n)-[:LIVES_IN]->(c:City)
     RETURN n, c.name AS city,
       [(n)-[r]-(m) | {type: type(r), out: startNode(r) = n, name: coalesce(m.name, toString(id(m))), id: id(m)}] AS connections,
       [h IN coalesce(history(n), []) WHERE h.change = 'created' | h.at][0] AS created`,
    { id },
  )
  const row = r.rows[0]
  if (!row) return
  const n = row[0] as { labels: string[]; properties: Record<string, unknown> }
  const connections = (row[2] as { type: string; out: boolean; name: string; id: number }[]).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  details.value = { id, labels: [...n.labels], properties: n.properties, city: (row[1] as string | null) ?? null, connections, created: (row[3] as string | null) ?? null }
  const near = [index, ...connections.map((c) => indexOf.get(c.id)).filter((i): i is number => i !== undefined)]
  view?.highlight(near)
  highlightText.value = `${String(n.properties.name ?? id)} and ${connections.length} connection${connections.length === 1 ? '' : 's'}`
}

function onPointer(e: PointerEvent) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
  pointer.x = e.clientX - box.left
  pointer.y = e.clientY - box.top
  if (hover.value) hover.value = { ...hover.value, x: pointer.x, y: pointer.y }
}

const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

onMounted(async () => {
  client = connect(new Worker(new URL('../../../../src/worker/worker.ts', import.meta.url), { type: 'module', name: 'smaltcy' }))
  try {
    view = await createGraphView(canvas.value!, { mode: mode.value, theme: isDark.value ? 'dark' : 'light', labels: labels.value, layoutMode: layoutMode.value, spread: spread.value })
    view.onHover((hit) => {
      if (!hit || hit.kind !== 'node') return void (hover.value = null)
      const id = drawing.order[hit.index]
      const n = id === undefined ? undefined : drawing.nodes.get(id)
      hover.value = n ? { x: pointer.x, y: pointer.y, text: n.caption } : null
    })
    view.onClick((hit) => void select(hit?.kind === 'node' ? hit.index : null))
  } catch (e) {
    gpuError.value = e instanceof GpuUnavailableError ? 'This demo draws with WebGPU, which this browser doesn\'t offer. The queries still run.' : `The graph view couldn't start: ${(e as Error).message}`
  }
  // ?dataset=org-chart&size=1000 opens the demo on that dataset at that size (?people= is the old name for size):
  // links can share one, and the quick browser test uses a small one.
  const params = new URLSearchParams(location.search)
  const people = Number(params.get('size') ?? params.get('people'))
  const named = DEMO_DATASETS.find((d) => d.name === params.get('dataset'))
  const fromLink = (SIZES.includes(people) && people !== size.value) || (!!named && named.name !== datasetName.value)
  if (fromLink) {
    if (named) datasetName.value = named.name
    if (SIZES.includes(people)) size.value = people // the watchers load it
    if (!labelsTouched) labels.value = size.value <= LABELS_UP_TO
    view?.setLabels(labels.value)
  }
  timer = window.setInterval(() => {
    if (!view) return
    const s = view.stats()
    nums.value.fps = s.fps
    nums.value.tickMs = s.layoutMsPerTick
    nums.value.layout = view.layout.running
  }, 400)
  if (!fromLink) await load()
})

onBeforeUnmount(() => {
  timeline?.destroy()
  clearInterval(timer)
  view?.destroy()
  client?.close()
})

/** Keeps the address in step with the dataset and size, so the page can be shared as it is. */
function syncLink() {
  const u = new URL(location.href)
  u.searchParams.delete('people')
  u.searchParams.set('dataset', datasetName.value)
  u.searchParams.set('size', String(size.value))
  history.replaceState(history.state, '', u)
}
watch(size, syncLink)

const ms = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString())
</script>

<template>
  <div class="td">
    <div class="td-bar">
      <label class="td-field">
        <span class="td-eyebrow">Dataset</span>
        <select v-model="datasetName" :disabled="busy" aria-label="Dataset">
          <option v-for="d in DEMO_DATASETS" :key="d.name" :value="d.name">{{ d.title }}: {{ d.shape }}</option>
        </select>
      </label>
      <label class="td-field">
        <span class="td-eyebrow">Nodes</span>
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
      <label class="td-check"><input v-model="labels" type="checkbox" @change="labelsTouched = true" /> Labels</label>
      <LayoutControls v-model:mode="layoutMode" v-model:spread="spread" />
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
      <section class="td-view" @pointermove="onPointer" @pointerleave="hover = null">
        <canvas ref="canvas" class="td-canvas" />
        <div v-if="hover" class="td-tip" :style="{ left: hover.x + 14 + 'px', top: hover.y + 14 + 'px' }">{{ hover.text }}</div>
        <div v-if="gpuError" class="td-gpu">{{ gpuError }}</div>
        <div v-if="highlightText" class="td-highlight">{{ highlightText }}</div>
        <GraphControls v-if="!gpuError" :mode="mode" />
      </section>
      <div v-show="store === 'history'" class="td-tl">
        <p class="td-tl-note">
          <span v-if="viewing < latest">Version {{ viewing.toLocaleString() }} of {{ latest.toLocaleString() }}: queries read this version.</span>
          <span v-else>{{ ds.grew }}: drag the timeline, or press Play.</span>
        </p>
        <div ref="tlHost" />
      </div>
      <aside class="td-side">
        <section v-if="details" class="td-details" aria-live="polite">
          <header>
            <h4>{{ details.properties.name ?? `Node ${details.id}` }}</h4>
            <button class="td-ghost td-close" aria-label="Close the details" @click="clear">×</button>
          </header>
          <p class="td-labels">
            <span v-for="l in details.labels" :key="l" class="td-label">:{{ l }}</span>
            <span class="td-id">id {{ details.id }}</span>
          </p>
          <dl>
            <template v-for="(v, k) in details.properties" :key="k"><dt>{{ k }}</dt><dd>{{ fmt(v) }}</dd></template>
            <template v-if="details.city"><dt>lives in</dt><dd>{{ details.city }}</dd></template>
            <template v-if="details.created"><dt>created</dt><dd>{{ details.created.slice(0, 16).replace('T', ' ') }}</dd></template>
          </dl>
          <p class="td-eyebrow">{{ details.connections.length }} connection{{ details.connections.length === 1 ? '' : 's' }}</p>
          <ul class="td-conn">
            <li v-for="(c, i) in details.connections.slice(0, 40)" :key="i"><code>{{ c.out ? '→' : '←' }} {{ c.type }}</code> {{ c.name }}</li>
            <li v-if="details.connections.length > 40" class="td-more">and {{ details.connections.length - 40 }} more</li>
          </ul>
        </section>
        <p v-else-if="size <= LABELS_UP_TO" class="td-note">Click a {{ ds.noun }} to see its properties and connections.</p>
        <label class="td-field">
          <span class="td-eyebrow">Search the drawing (on the GPU's captions)</span>
          <input v-model="search" type="search" placeholder="Part of a name" />
        </label>
        <div class="td-chips">
          <button v-for="s in ds.searches" :key="s" class="td-chip" @click="doSearch(s)">{{ s }}</button>
        </div>
        <span class="td-eyebrow">Query, and highlight the result</span>
        <div class="td-chips">
          <button v-for="q in ds.queries" :key="q.title" class="td-chip" :disabled="busy" :title="q.query" @click="run(q.query)">{{ q.title }}</button>
        </div>
        <textarea v-model="query" class="td-query" spellcheck="false" aria-label="Cypher query" @keydown.ctrl.enter.prevent="run()" @keydown.meta.enter.prevent="run()" />
        <button class="td-primary" :disabled="busy" @click="run()">Run and highlight</button>
        <p v-if="error" class="td-error" role="alert"><b>Error</b> {{ error }}</p>
        <p class="td-note">
          {{ ds.about }} Generated in the engine's worker as you pick it; the layout runs in WebGPU compute shaders.
          Above 20,480 nodes the layout samples repulsion each tick.
        </p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.td { display: flex; flex-direction: column; gap: 12px; }
.td-bar { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
.td-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: 100%; }
.td-eyebrow { font-family: var(--vp-font-family-brand, 'Martian Mono', monospace); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vp-c-text-2); }
select, input[type='search'] { height: 36px; padding: 0 10px; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg); color: var(--vp-c-text-1); font: inherit; font-size: 14px; max-width: 100%; min-width: 0; text-overflow: ellipsis; }
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
.td-main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; grid-template-rows: 1fr auto; gap: 12px; height: calc(100vh - var(--vp-nav-height) - 240px); min-height: 560px; }
.td-view { grid-column: 1; grid-row: 1; }
.td-tip { position: absolute; pointer-events: none; padding: 4px 8px; border-radius: 6px; background: var(--vp-c-bg); border: 1px solid var(--vp-c-divider); font-size: 13px; white-space: nowrap; box-shadow: var(--vp-shadow-2); }
.td-details { padding: 12px; border: 1px solid var(--vp-c-divider); border-radius: 10px; background: var(--vp-c-bg-soft); }
.td-details header { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
.td-details h4 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
.td-close { height: 28px; width: 28px; padding: 0; font-size: 18px; line-height: 1; }
.td-labels { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 6px 0 8px; }
.td-label { font-family: var(--vp-font-family-mono); font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--vp-c-default-soft); }
.td-id { font-size: 12px; color: var(--vp-c-text-3); }
.td-details dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 12px; margin: 0 0 10px; font-size: 13px; }
.td-details dt { font-family: var(--vp-font-family-mono); color: var(--vp-c-text-2); }
.td-details dd { margin: 0; font-family: var(--vp-font-family-mono); overflow-wrap: anywhere; }
.td-conn { list-style: none; margin: 4px 0 0; padding: 0; max-height: 220px; overflow: auto; font-size: 13px; }
.td-conn li { padding: 2px 0; }
.td-conn code { font-size: 12px; color: var(--vp-c-text-2); }
.td-more { color: var(--vp-c-text-3); }
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
  /* minmax(0, …): the column stays the screen's width whatever its content says (the timeline's readout changes as it
     plays; a plain 1fr would grow with it and shake the page). */
  .td-main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; height: auto; }
  .td-view, .td-side, .td-tl { grid-column: 1; grid-row: auto; }
  /* svh: the address bar showing and hiding on a phone doesn't resize the drawing. */
  .td-view { height: 65vh; height: 65svh; }
}
</style>
