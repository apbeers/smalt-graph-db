<script setup lang="ts">
// The smaltcy playground: Cypher in a Web Worker, results drawn by the GPU renderer in 2D or 3D.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useData } from 'vitepress'
import { connect, type GraphClient } from '../../../../src/worker/client'
import type { DatasetRequest } from '../../../../src/worker/protocol'
import { createGraphView, GpuUnavailableError, type GraphView, type RenderGraph } from '../../../../src/render/index'
import { EXAMPLES, type DatasetKey } from './examples'
import GraphControls from './GraphControls.vue'
import LayoutControls from './LayoutControls.vue'
import { collect as collectRows, decodeCode, fmt, toRender as toRenderGraph, type GEdge, type GNode } from '../graph-results'
import { createTimeline, type Timeline, type TimelineCommit } from '../../../../src/timeline/index'
import { Scrubber, VersionedDrawing } from '../versioned-drawing'

type Row = readonly unknown[]
interface Hit { kind: 'node' | 'edge'; index: number }

const { isDark } = useData()

// Generated in the engine's worker (DatasetRequest), so large ones don't hold up the page. Every dataset keeps its
// history: the ontology and the networks come with their past, the rest start as one commit, and every write you run
// adds a version to the timeline.
const DATASETS: Record<DatasetKey, { title: string; req: DatasetRequest }> = {
  social: { title: 'Social: people, cities, topics', req: { name: 'social', history: true } },
  family: { title: 'The smalt family', req: { name: 'family', history: true } },
  metro: { title: 'Metro: 8 lines, ~240 stations', req: { name: 'metro', history: true } },
  ontology: { title: 'Ontology: a data platform over six months', req: { name: 'ontology', history: true } },
  network: { title: 'Network: 5,000 people, as it grew', req: { name: 'network', size: 5000, history: true } },
  big: { title: 'Network: 20,000 people, as it grew', req: { name: 'network', size: 20000, history: true } },
}

const dataset = ref<DatasetKey>('social')
const query = ref(EXAMPLES.social[0]!.query)
const mode = ref<'2d' | '3d'>('2d')
/** Force (physics) or Fixed (locked, spread out by group), and how far apart the nodes are. */
const layoutMode = ref<'force' | 'fixed'>('force')
const spread = ref(1)
const labels = ref(true)
const search = ref('')
const tab = ref<'table' | 'plan' | 'details'>('table')
const busy = ref(false)
const error = ref<string | null>(null)
const gpuError = ref<string | null>(null)
const columns = ref<string[]>([])
const rows = shallowRef<Row[]>([])
const planText = ref('')
const status = ref('')
const statsText = ref('')
const hover = ref<{ x: number; y: number; text: string } | null>(null)
const selected = shallowRef<{ kind: 'node' | 'edge'; data: GNode | GEdge } | null>(null)

const canvas = ref<HTMLCanvasElement | null>(null)
let client: GraphClient | null = null
let view: GraphView | null = null
let statsTimer = 0
/** The timeline under the drawing, and the drawing it moves: the whole graph at the version it shows. */
const tlHost = ref<HTMLElement | null>(null)
let timeline: Timeline | null = null
const drawing = new VersionedDrawing()
const latest = ref(0)
const viewing = ref(0)
/** True while the drawing is the whole graph (which the timeline moves); false while it shows a query's result. */
let wholeGraph = false
const scrubber = new Scrubber(drawing, (a, b) => client!.diff(a, b), (changed) => {
  syncFromDrawing()
  view?.setGraph(drawing.render(), { keepPositions: true, animate: true, changed })
})

/** The panels' copy of what's drawn, in drawing order (hover and click find nodes by index). */
function syncFromDrawing() {
  drawing.render()
  gNodes = drawing.order.map((id) => {
    const n = drawing.nodes.get(id)!
    return { id, labels: [...n.labels], properties: {}, caption: n.caption }
  })
  gEdges = [...drawing.rels].map(([id, r]) => ({ id, type: r.type, start: r.start, end: r.end, properties: {} }))
}

const toTimeline = (c: { version: number; time: number; author?: string; message?: string; size: number }): TimelineCommit => ({ version: c.version, time: c.time, author: c.author, message: c.message, size: c.size })

/** Brings the timeline up to date with the graph's commits; `follow` keeps it at the end if it was there. */
async function refreshTimeline(follow: boolean) {
  if (!client) return
  const commits = (await client.commits()).map(toTimeline)
  latest.value = commits.length ? commits[commits.length - 1]!.version : 0
  if (!timeline && tlHost.value) {
    timeline = createTimeline(tlHost.value, { commits, value: latest.value, theme: isDark.value ? 'dark' : 'light', onChange: (v) => void moveTo(v) })
  } else timeline?.setCommits(commits, { follow })
  if (!follow) timeline?.setValue(latest.value)
  viewing.value = timeline?.value ?? latest.value
}

/** The timeline moved: redraw the whole graph at that version, by diffs from what's drawn. */
async function moveTo(v: number) {
  viewing.value = v
  if (!client) return
  if (!wholeGraph) return void showOverview(v)
  scrubber.to(v)
}

/** Puts `AT VERSION n` before the query, to query the version the timeline shows. */
function queryThisVersion() {
  query.value = `AT VERSION ${viewing.value}\n` + query.value.replace(/^\s*AT\s+(VERSION|TIME)\s+\S+\s*/i, '')
}

/** The query a link opened the playground with, until its dataset has loaded. */
let initial: string | null = null
let runAfterLoad = false

/** What's drawn: graph elements by engine id, in the renderer's order. */
let gNodes: GNode[] = []
let gEdges: GEdge[] = []

const examples = computed(() => EXAMPLES[dataset.value])

const toRender = (): RenderGraph => toRenderGraph({ nodes: gNodes, edges: gEdges })

/** Every node, relationship and path in a result becomes the drawn graph; false when there are none. */
function collect(rowsIn: Row[]): boolean {
  const d = collectRows(rowsIn)
  if (!d) return false
  gNodes = d.nodes
  gEdges = d.edges
  return true
}

async function loadDataset() {
  if (!client) return
  busy.value = true
  error.value = null
  selected.value = null
  try {
    const t0 = performance.now()
    const st = await client.dataset(DATASETS[dataset.value].req)
    status.value = `${st.nodes.toLocaleString()} nodes, ${st.relationships.toLocaleString()} relationships, ${(st.version ?? 0).toLocaleString()} versions, loaded in ${Math.round(performance.now() - t0)} ms`
    await refreshTimeline(false)
    await showOverview()
    if (initial !== null) {
      query.value = initial
      initial = null
      runAfterLoad = true
    } else query.value = EXAMPLES[dataset.value][0]!.query
    columns.value = []
    rows.value = []
    planText.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
  if (runAfterLoad) {
    runAfterLoad = false
    await run()
  }
}

/** Draws the whole graph: at the version the timeline shows, the latest by default. */
async function showOverview(version = viewing.value) {
  if (!client) return
  const ov = await client.overview(undefined, version === latest.value ? {} : { asOf: version })
  drawing.reset(ov, version)
  wholeGraph = true
  syncFromDrawing()
  view?.setGraph(drawing.render())
  view?.fit()
}

async function run() {
  if (!client || busy.value) return
  busy.value = true
  error.value = null
  try {
    const r = await client.run(query.value)
    columns.value = [...r.columns]
    rows.value = r.rows as Row[]
    if (r.explain) {
      planText.value = String(r.rows[0]?.[0] ?? '')
      tab.value = 'plan'
      status.value = 'EXPLAIN: the plan, not run'
      return
    }
    const c = r.counts
    const wrote = [
      c.nodesCreated && `${c.nodesCreated} nodes created`, c.relationshipsCreated && `${c.relationshipsCreated} relationships created`,
      c.nodesDeleted && `${c.nodesDeleted} nodes deleted`, c.relationshipsDeleted && `${c.relationshipsDeleted} relationships deleted`,
      c.propertiesSet && `${c.propertiesSet} properties set`, c.labelsAdded && `${c.labelsAdded} labels added`,
    ].filter(Boolean)
    status.value = `${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'} in ${r.ms < 1 ? r.ms.toFixed(2) : Math.round(r.ms)} ms${wrote.length ? ' · ' + wrote.join(', ') : ''}`
    try {
      const ex = await client.run('EXPLAIN ' + query.value)
      planText.value = String(ex.rows[0]?.[0] ?? '')
    } catch {
      planText.value = ''
    }
    if (wrote.length) {
      // A write is a new version: the timeline grows, and the drawing moves to it.
      const wasLatest = viewing.value === latest.value
      await refreshTimeline(wasLatest)
      if (wasLatest && wholeGraph) await moveTo(latest.value)
      else if (wasLatest) await showOverview(latest.value)
    } else if (collect(r.rows as Row[])) {
      wholeGraph = false
      view?.setGraph(toRender(), { keepPositions: true })
      view?.fit()
    }
    if (tab.value === 'plan' || tab.value === 'details') tab.value = 'table'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

/** Adds a node's neighbours to the drawing. */
async function expand(n: GNode) {
  if (!client) return
  const r = await client.run('MATCH (n)-[r]-(m) WHERE id(n) = $id RETURN n, r, m', { id: n.id })
  const keep = { nodes: gNodes, edges: gEdges }
  collect(r.rows as Row[])
  const byId = new Map(keep.nodes.map((x) => [x.id, x]))
  for (const x of gNodes) byId.set(x.id, x)
  const edges = new Map(keep.edges.map((x) => [x.id, x]))
  for (const x of gEdges) edges.set(x.id, x)
  gNodes = [...byId.values()]
  gEdges = [...edges.values()]
  view?.setGraph(toRender(), { keepPositions: true })
}

async function select(hit: Hit | null) {
  if (!hit) {
    selected.value = null
    view?.highlight(null)
    return
  }
  if (hit.kind === 'node') {
    let n = gNodes[hit.index]!
    // Overview nodes carry no properties: fetch them.
    if (client && Object.keys(n.properties).length === 0) {
      const r = await client.run('MATCH (n) WHERE id(n) = $id RETURN n', { id: n.id })
      const full = r.rows[0]?.[0] as { labels: string[]; properties: Record<string, unknown> } | undefined
      if (full) n = gNodes[hit.index] = { ...n, labels: [...full.labels], properties: full.properties }
    }
    selected.value = { kind: 'node', data: n }
    view?.highlight([hit.index])
  } else {
    const edges = toRender().edges
    const e = edges[hit.index]
    const g = gEdges.find((x) => gNodes[e!.source]!.id === x.start && gNodes[e!.target]!.id === x.end && x.type === e!.label)
    if (g) selected.value = { kind: 'edge', data: g }
  }
  tab.value = 'details'
}

function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    run()
  }
}

function pick(ex: { query: string }) {
  query.value = ex.query
  run()
}

watch(mode, (m) => view?.setMode(m))
watch(layoutMode, (m) => view?.setLayoutMode(m))
watch(spread, (s) => view?.setSpread(s))
watch(labels, (on) => view?.setLabels(on))
watch(isDark, (d) => {
  view?.setTheme(d ? 'dark' : 'light')
  timeline?.setTheme(d ? 'dark' : 'light')
})
watch(search, (s) => {
  if (!view) return
  if (!s.trim()) view.highlight(null)
  else {
    const hits = view.search(s)
    if (hits.length === 1) view.focus(hits[0]!)
  }
})
watch(dataset, loadDataset)

onMounted(async () => {
  client = connect(new Worker(new URL('../../../../src/worker/worker.ts', import.meta.url), { type: 'module' }))
  try {
    view = await createGraphView(canvas.value!, { mode: mode.value, theme: isDark.value ? 'dark' : 'light', labels: labels.value, layoutMode: layoutMode.value, spread: spread.value })
    view.onHover((hit) => {
      if (!hit || hit.kind !== 'node') return void (hover.value = null)
      const n = gNodes[hit.index]
      if (n) hover.value = { x: lastPointer.x, y: lastPointer.y, text: `${n.caption}${n.labels.length ? ' · ' + n.labels.join(', ') : ''}` }
    })
    view.onClick((hit) => void select(hit))
    statsTimer = window.setInterval(() => {
      if (!view) return
      const s = view.stats()
      statsText.value = `${s.nodes.toLocaleString()} nodes · ${s.edges.toLocaleString()} edges · ${Math.round(s.fps)} fps${view.layout.running ? ` · layout ${s.layoutMsPerTick.toFixed(1)} ms/tick` : ''}`
    }, 500)
  } catch (e) {
    gpuError.value = e instanceof GpuUnavailableError
      ? 'The graph view draws with WebGPU, which this browser doesn\'t offer. Queries and tables still work.'
      : `The graph view couldn't start: ${(e as Error).message}`
  }
  // A link from an example (Open in the playground): ?dataset=…#q=<code>.
  const params = new URLSearchParams(location.search)
  const ds = params.get('dataset')
  const q = /^#q=([A-Za-z0-9_-]+)$/.exec(location.hash)
  if (q) {
    try {
      initial = decodeCode(q[1]!)
    } catch {
      initial = null
    }
  }
  if (ds && ds in DATASETS && ds !== dataset.value) dataset.value = ds as DatasetKey // the watcher loads it
  else await loadDataset()
})

const lastPointer = { x: 0, y: 0 }
function onPointer(e: PointerEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  lastPointer.x = e.clientX - r.left
  lastPointer.y = e.clientY - r.top
  if (hover.value) hover.value = { ...hover.value, x: lastPointer.x, y: lastPointer.y }
}

onBeforeUnmount(() => {
  timeline?.destroy()
  clearInterval(statsTimer)
  view?.destroy()
  client?.close()
})
</script>

<template>
  <div class="pg">
    <div class="pg-bar">
      <label class="pg-field">
        <span class="pg-eyebrow">Dataset</span>
        <select v-model="dataset" :disabled="busy">
          <option v-for="(d, k) in DATASETS" :key="k" :value="k">{{ d.title }}</option>
        </select>
      </label>
      <label class="pg-field pg-grow">
        <span class="pg-eyebrow">Search the drawing</span>
        <input v-model="search" type="search" placeholder="A name, label or id" />
      </label>
      <div class="pg-seg" role="group" aria-label="View">
        <button :class="{ on: mode === '2d' }" @click="mode = '2d'">2D</button>
        <button :class="{ on: mode === '3d' }" @click="mode = '3d'">3D</button>
      </div>
      <label class="pg-check"><input v-model="labels" type="checkbox" /> Labels</label>
      <LayoutControls v-model:mode="layoutMode" v-model:spread="spread" />
      <button class="pg-ghost" @click="view?.fit()">Fit</button>
      <button class="pg-ghost" @click="view?.layout.reheat()">Re-run layout</button>
    </div>

    <div class="pg-main">
      <section class="pg-left">
        <div class="pg-editor">
          <textarea v-model="query" spellcheck="false" aria-label="Cypher query" @keydown="onKey" />
          <div class="pg-editor-bar">
            <button class="pg-primary" :disabled="busy" @click="run">Run <kbd>Ctrl ⏎</kbd></button>
            <span class="pg-status" :class="{ err: error }" role="status">
              <template v-if="error"><b>Error</b> {{ error }}</template>
              <template v-else>{{ status }}</template>
            </span>
          </div>
        </div>
        <div class="pg-examples">
          <span class="pg-eyebrow">Try</span>
          <button v-for="ex in examples" :key="ex.title" class="pg-chip" :title="ex.query" @click="pick(ex)">{{ ex.title }}</button>
        </div>
        <div class="pg-tabs" role="tablist">
          <button role="tab" :aria-selected="tab === 'table'" :class="{ on: tab === 'table' }" @click="tab = 'table'">Table <small>{{ rows.length }}</small></button>
          <button role="tab" :aria-selected="tab === 'plan'" :class="{ on: tab === 'plan' }" @click="tab = 'plan'">Plan</button>
          <button role="tab" :aria-selected="tab === 'details'" :class="{ on: tab === 'details' }" @click="tab = 'details'">Details</button>
        </div>
        <div class="pg-panel">
          <div v-if="tab === 'table'" class="pg-table-wrap">
            <table v-if="columns.length" class="pg-table">
              <thead><tr><th v-for="c in columns" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in rows.slice(0, 500)" :key="i"><td v-for="(v, j) in r" :key="j">{{ fmt(v) }}</td></tr>
              </tbody>
            </table>
            <p v-if="rows.length > 500" class="pg-note">Showing 500 of {{ rows.length.toLocaleString() }} rows.</p>
            <p v-if="!columns.length" class="pg-note">Run a query to see its rows. Nodes, relationships and paths it returns are drawn.</p>
          </div>
          <pre v-else-if="tab === 'plan'" class="pg-plan">{{ planText || 'Run a query to see the plan the engine chose for it.' }}</pre>
          <div v-else class="pg-details">
            <template v-if="selected && selected.kind === 'node'">
              <h4>{{ (selected.data as GNode).caption }}</h4>
              <p class="pg-labels"><span v-for="l in (selected.data as GNode).labels" :key="l" class="pg-label">:{{ l }}</span> <span class="pg-id">id {{ selected.data.id }}</span></p>
              <dl>
                <template v-for="(v, k) in selected.data.properties" :key="k"><dt>{{ k }}</dt><dd>{{ fmt(v) }}</dd></template>
              </dl>
              <button class="pg-ghost" @click="expand(selected.data as GNode)">Show neighbours</button>
            </template>
            <template v-else-if="selected">
              <h4>:{{ (selected.data as GEdge).type }}</h4>
              <dl>
                <template v-for="(v, k) in selected.data.properties" :key="k"><dt>{{ k }}</dt><dd>{{ fmt(v) }}</dd></template>
              </dl>
            </template>
            <p v-else class="pg-note">Click a node in the drawing to see its properties.</p>
          </div>
        </div>
      </section>

      <div class="pg-right">
        <section class="pg-view" @pointermove="onPointer" @pointerleave="hover = null">
          <canvas ref="canvas" class="pg-canvas" />
          <div v-if="gpuError" class="pg-gpu">{{ gpuError }}</div>
          <div v-if="hover" class="pg-tip" :style="{ left: hover.x + 14 + 'px', top: hover.y + 14 + 'px' }">{{ hover.text }}</div>
          <div class="pg-stats">{{ statsText }}</div>
          <GraphControls v-if="!gpuError" :mode="mode" />
        </section>
        <div v-if="viewing !== latest" class="pg-past" role="status">
          <span>Showing version {{ viewing.toLocaleString() }} of {{ latest.toLocaleString() }}. Queries read the latest version.</span>
          <button class="pg-ghost" @click="queryThisVersion">Query this version</button>
        </div>
        <div ref="tlHost" class="pg-timeline" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg { display: flex; flex-direction: column; gap: 12px; height: calc(100vh - var(--vp-nav-height) - 48px); min-height: 640px; }
.pg-bar { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
.pg-field { display: flex; flex-direction: column; gap: 4px; }
.pg-grow { flex: 1; min-width: 180px; }
.pg-eyebrow { font-family: var(--vp-font-family-brand, 'Martian Mono', monospace); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--vp-c-text-2); }
select, input[type='search'] { height: 36px; padding: 0 10px; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg); color: var(--vp-c-text-1); font: inherit; font-size: 14px; }
select:focus-visible, input:focus-visible, button:focus-visible, textarea:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.pg-seg { display: inline-flex; border: 1px solid var(--vp-c-divider); border-radius: 8px; overflow: hidden; height: 36px; }
.pg-seg button { padding: 0 14px; font-weight: 500; font-size: 14px; color: var(--vp-c-text-2); }
.pg-seg button.on { background: var(--vp-c-brand-1); color: var(--vp-c-white); }
.pg-check { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; height: 36px; }
.pg-ghost { height: 36px; padding: 0 12px; border: 1px solid var(--vp-c-divider); border-radius: 8px; font-size: 14px; font-weight: 500; color: var(--vp-c-text-1); }
.pg-ghost:hover { border-color: var(--vp-c-brand-1); }
.pg-main { flex: 1; display: grid; grid-template-columns: minmax(340px, 38%) minmax(0, 1fr); gap: 12px; min-height: 0; }
.pg-left { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.pg-editor { border: 1px solid var(--vp-c-divider); border-radius: 10px; overflow: hidden; background: var(--vp-code-block-bg); }
.pg-editor textarea { display: block; width: 100%; min-height: 120px; resize: vertical; padding: 12px 14px; border: 0; background: transparent; color: var(--vp-c-text-1); font-family: var(--vp-font-family-mono); font-size: 14px; line-height: 1.6; }
.pg-editor-bar { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-top: 1px solid var(--vp-c-divider); background: var(--vp-c-bg); }
.pg-primary { height: 34px; padding: 0 14px; border-radius: 8px; background: var(--vp-c-brand-1); color: var(--vp-c-white); font-weight: 600; font-size: 14px; }
.pg-primary:disabled { opacity: 0.6; }
.pg-primary kbd { margin-left: 6px; font-family: var(--vp-font-family-mono); font-size: 11px; opacity: 0.85; }
.pg-status { font-size: 13px; color: var(--vp-c-text-2); overflow: hidden; text-overflow: ellipsis; }
.pg-status.err { color: var(--vp-c-danger-1); white-space: normal; }
.pg-examples { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pg-chip { padding: 4px 10px; border: 1px solid var(--vp-c-divider); border-radius: 999px; font-size: 13px; color: var(--vp-c-text-1); }
.pg-chip:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.pg-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vp-c-divider); }
.pg-tabs button { padding: 6px 12px; font-size: 14px; font-weight: 500; color: var(--vp-c-text-2); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.pg-tabs button.on { color: var(--vp-c-text-1); border-bottom-color: var(--vp-c-brand-1); }
.pg-tabs small { color: var(--vp-c-text-3); margin-left: 4px; }
.pg-panel { flex: 1; min-height: 160px; overflow: auto; }
.pg-table { width: 100%; display: table; margin: 0; font-size: 13px; }
.pg-table th, .pg-table td { padding: 6px 10px; font-family: var(--vp-font-family-mono); text-align: left; vertical-align: top; }
.pg-table td { max-width: 360px; overflow-wrap: anywhere; }
.pg-plan { margin: 0; padding: 12px; font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.6; white-space: pre; color: var(--vp-c-text-1); background: var(--vp-code-block-bg); border-radius: 8px; overflow: auto; }
.pg-note { color: var(--vp-c-text-2); font-size: 14px; }
.pg-details h4 { margin: 4px 0; font-size: 18px; }
.pg-labels { display: flex; gap: 6px; align-items: center; margin: 0 0 8px; }
.pg-label { font-family: var(--vp-font-family-mono); font-size: 13px; padding: 1px 8px; border-radius: 999px; background: var(--vp-c-default-soft); }
.pg-id { font-size: 12px; color: var(--vp-c-text-3); }
.pg-details dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 14px; margin: 8px 0 12px; }
.pg-details dt { font-family: var(--vp-font-family-mono); color: var(--vp-c-text-2); }
.pg-details dd { margin: 0; font-family: var(--vp-font-family-mono); overflow-wrap: anywhere; }
.pg-right { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.pg-right .pg-view { flex: 1; }
.pg-past { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 6px 10px; border: 1px solid var(--vp-c-divider); border-radius: 8px; font-size: 13px; color: var(--vp-c-text-2); }
.pg-past .pg-ghost { height: 30px; }
.pg-view { position: relative; border: 1px solid var(--vp-c-divider); border-radius: 10px; overflow: hidden; background: var(--vp-c-bg-alt); min-height: 420px; }
.pg-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.pg-gpu { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; text-align: center; color: var(--vp-c-text-2); }
.pg-tip { position: absolute; pointer-events: none; padding: 4px 8px; border-radius: 6px; background: var(--vp-c-bg); border: 1px solid var(--vp-c-divider); font-size: 13px; white-space: nowrap; box-shadow: var(--vp-shadow-2); }
.pg-stats { position: absolute; left: 10px; bottom: 8px; font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--vp-c-text-3); pointer-events: none; }
@media (max-width: 900px) {
  .pg { height: auto; }
  .pg-main { grid-template-columns: minmax(0, 1fr); }
  .pg-view { height: 60vh; height: 60svh; }
}
</style>
