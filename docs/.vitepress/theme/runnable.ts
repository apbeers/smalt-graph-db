// Runnable examples: every ```cypher example in the docs runs where it stands, on a sample dataset, and its result shows
// as a table and, when it holds nodes, relationships or paths, as a graph drawn by the GPU renderer. The same idea as
// smaltql's playgrounds (BRAND.md, Documentation): at rest an example is its code and a Run button, and loads nothing.
// The first Run starts the engine in a Web Worker; the renderer loads when a result has a graph to draw.
//
// - runnablePlugin(): a markdown-it plugin for .vitepress/config.ts. A page's dataset is its front matter's `dataset`
//   (default `social`); a fence can name its own (```cypher dataset=metro). A fence marked `noplay` stays plain.
// - enableRunnable(): wires the examples in the browser, for .vitepress/theme/index.ts.
//
// test/docs-examples.test.ts runs every example on the dataset this plugin gives it.
import type { GraphClient } from '../../../src/worker/client'
import type { GraphView } from '../../../src/render/index'
import { collect, controlsHint, encodeCode, fmt, toRender } from './graph-results'

export const DATASETS = ['social', 'family', 'metro', 'network', 'ontology', 'org-chart', 'packages', 'airline', 'power-grid', 'git-history', 'supply-chain', 'microservices'] as const
/** Datasets the examples load with their history, for AT VERSION, AT TIME and the temporal functions. */
export const WITH_HISTORY: ReadonlySet<DatasetName> = new Set(['ontology'])
export type DatasetName = (typeof DATASETS)[number]

// ---------------------------------------------------------------------------------------------------------------------
// The markdown-it plugin

interface Token {
  type: string
  info: string
  content: string
}

interface MarkdownIt {
  core: { ruler: { push(name: string, rule: (state: { tokens: Token[]; env: any; Token: new (type: string, tag: string, nesting: number) => Token }) => void): void } }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** The dataset an example runs on: its fence's `dataset=…`, else the page's front matter, else `social`. */
export function datasetOf(info: string, frontmatter: { dataset?: string } | undefined): DatasetName | null {
  const [, ...flags] = info.trim().split(/\s+/)
  if (flags.includes('noplay')) return null
  const own = flags.find((f) => f.startsWith('dataset='))?.slice('dataset='.length)
  const name = own ?? frontmatter?.dataset ?? 'social'
  if (!(DATASETS as readonly string[]).includes(name)) throw new Error(`Unknown dataset ${name} for a cypher example`)
  return name as DatasetName
}

export function runnablePlugin(md: MarkdownIt): void {
  md.core.ruler.push('cy_runnable', (state) => {
    const out: Token[] = []
    const html = (content: string): Token => {
      const t = new state.Token('html_block', '', 0)
      t.content = content
      return t
    }
    let index = 0
    for (const t of state.tokens) {
      const lang = t.type === 'fence' ? t.info.trim().split(/\s+/)[0] : ''
      if (lang !== 'cypher') {
        out.push(t)
        continue
      }
      const dataset = datasetOf(t.info, state.env?.frontmatter)
      t.info = 'cypher'
      if (!dataset) {
        out.push(t)
        continue
      }
      const n = index++
      out.push(html(`<div class="cy-run" id="run-${n}" data-dataset="${dataset}" data-code="${esc(t.content)}" v-pre>\n<div class="cy-run-code">\n`))
      out.push(t)
      out.push(
        html(
          `</div>\n<div class="cy-run-bar" role="toolbar" aria-label="Example">` +
            `<button type="button" class="cy-run-go" data-run="run" title="Run (Ctrl+Enter)">Run</button>` +
            `<button type="button" data-run="edit">Edit</button>` +
            `<button type="button" data-run="reset" hidden>Reset</button>` +
            `<button type="button" data-run="copy">Copy</button>` +
            `<a data-run="open">Open in the playground</a>` +
            `<span class="cy-run-data">on <code>${dataset}</code></span>` +
            `<span class="cy-run-status" role="status" aria-live="polite"></span></div>\n` +
            `<div class="cy-run-result"></div>\n</div>\n`,
        ),
      )
    }
    state.tokens = out
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// In the browser

/** The network examples run on 2,000 people: enough to show traversals, quick to load. The real-world shapes on 300
 * nodes: small enough to read. */
const DATASET_SIZE: Partial<Record<DatasetName, number>> = {
  network: 2000,
  'org-chart': 300,
  packages: 300,
  airline: 300,
  'power-grid': 300,
  'git-history': 300,
  'supply-chain': 300,
  microservices: 300,
}
/** Views kept drawing at once: each holds a GPU context. Older ones give their canvas back. */
const MAX_VIEWS = 4

let client: Promise<GraphClient> | undefined
const engine = () =>
  (client ??= import('../../../src/worker/client').then(({ connect }) =>
    connect(new Worker(new URL('../../../src/worker/worker.ts', import.meta.url), { type: 'module', name: 'smaltcy' })),
  ))

const views: { view: GraphView; host: HTMLElement }[] = []
const isDark = () => document.documentElement.classList.contains('dark')

export function enableRunnable(base: string, doc: Document = document): void {
  const w = doc as Document & { cyRun?: boolean }
  if (w.cyRun) return
  w.cyRun = true

  const parts = (ex: HTMLElement) => ({
    code: ex.querySelector<HTMLElement>(':scope > .cy-run-code')!,
    result: ex.querySelector<HTMLElement>(':scope > .cy-run-result')!,
    status: ex.querySelector<HTMLElement>('.cy-run-status')!,
    edit: ex.querySelector<HTMLElement>('[data-run="edit"]')!,
    reset: ex.querySelector<HTMLElement>('[data-run="reset"]')!,
    open: ex.querySelector<HTMLAnchorElement>('[data-run="open"]')!,
  })
  const original = (ex: HTMLElement) => (ex.getAttribute('data-code') ?? '').replace(/\n+$/, '')
  const editor = (ex: HTMLElement) => ex.querySelector<HTMLTextAreaElement>('.cy-run-editor')
  const current = (ex: HTMLElement) => editor(ex)?.value ?? original(ex)
  const say = (ex: HTMLElement, text: string) => (parts(ex).status.textContent = text)
  const link = (ex: HTMLElement) => {
    parts(ex).open.href = `${base}playground?dataset=${ex.getAttribute('data-dataset')}#q=${encodeCode(current(ex))}`
  }

  const edit = (ex: HTMLElement): HTMLTextAreaElement => {
    const have = editor(ex)
    if (have) return have
    const { code, edit: editButton, reset } = parts(ex)
    const ta = doc.createElement('textarea')
    ta.className = 'cy-run-editor'
    ta.spellcheck = false
    ta.value = original(ex)
    ta.rows = Math.max(3, ta.value.split('\n').length + 1)
    ta.setAttribute('aria-label', 'Cypher')
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void run(ex)
      }
    })
    ta.addEventListener('input', () => link(ex))
    code.hidden = true
    code.after(ta)
    editButton.hidden = true
    reset.hidden = false
    return ta
  }

  const table = (columns: readonly string[], rows: readonly (readonly unknown[])[]): HTMLElement => {
    const wrap = doc.createElement('div')
    wrap.className = 'cy-run-table'
    const t = doc.createElement('table')
    const head = t.createTHead().insertRow()
    for (const c of columns) head.appendChild(doc.createElement('th')).textContent = c
    const body = t.createTBody()
    for (const r of rows.slice(0, 50)) {
      const tr = body.insertRow()
      for (const v of r) tr.insertCell().textContent = fmt(v)
    }
    wrap.append(t)
    if (rows.length > 50) {
      const more = doc.createElement('p')
      more.className = 'cy-run-note'
      more.textContent = `and ${(rows.length - 50).toLocaleString()} more rows`
      wrap.append(more)
    }
    return wrap
  }

  const draw = async (ex: HTMLElement, host: HTMLElement, rows: readonly (readonly unknown[])[]) => {
    const drawn = collect(rows)
    if (!drawn) return
    const panel = doc.createElement('div')
    panel.className = 'cy-run-graph'
    const canvas = doc.createElement('canvas')
    const bar = doc.createElement('div')
    bar.className = 'cy-run-graph-bar'
    bar.innerHTML =
      `<button type="button" data-mode="2d" class="on">2D</button><button type="button" data-mode="3d">3D</button>` +
      `<button type="button" data-layout="force" class="on" title="Physics">Force</button><button type="button" data-layout="fixed" title="Locked, spread out by group">Fixed</button>` +
      `<input type="range" data-spread min="-100" max="100" value="0" aria-label="Spread: how far apart the nodes are" title="Spread">` +
      `<button type="button" data-fit>Fit</button><span></span>`
    const hint = doc.createElement('div')
    hint.className = 'cy-run-hint'
    const setHint = (mode: '2d' | '3d') => {
      const h = controlsHint(mode)
      hint.innerHTML = `<span class="gc-mouse">${h.mouse}</span><span class="gc-touch">${h.touch}</span>`
    }
    setHint('2d')
    panel.append(canvas, bar, hint)
    host.append(panel)
    try {
      const { createGraphView } = await import('../../../src/render/index')
      // Free the oldest view's GPU resources when too many are drawing.
      while (views.length >= MAX_VIEWS) {
        const old = views.shift()!
        old.view.destroy()
        old.host.querySelector('canvas')?.replaceWith(Object.assign(doc.createElement('p'), { className: 'cy-run-note', textContent: 'Run again to draw this graph.' }))
      }
      const view = await createGraphView(canvas, { theme: isDark() ? 'dark' : 'light', labels: true })
      views.push({ view, host: panel })
      view.setGraph(toRender(drawn))
      const info = bar.querySelector('span')!
      info.textContent = `${drawn.nodes.length} nodes · ${drawn.edges.length} relationships`
      // Spread: logarithmic, 1× in the middle, 0.2× to 5×.
      bar.querySelector<HTMLInputElement>('[data-spread]')!.addEventListener('input', (e) => {
        view.setSpread(Math.exp((Number((e.target as HTMLInputElement).value) / 100) * Math.log(5)))
      })
      bar.addEventListener('click', (e) => {
        const b = (e.target as Element).closest('button')
        if (!b) return
        if (b.hasAttribute('data-fit')) return view.fit()
        const layout = b.getAttribute('data-layout') as 'force' | 'fixed' | null
        if (layout) {
          view.setLayoutMode(layout)
          bar.querySelectorAll('[data-layout]').forEach((x) => x.classList.toggle('on', x === b))
          return
        }
        const mode = b.getAttribute('data-mode') as '2d' | '3d'
        view.setMode(mode)
        setHint(mode)
        bar.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b))
      })
    } catch (e) {
      const name = (e as Error).name
      panel.replaceChildren(
        Object.assign(doc.createElement('p'), {
          className: 'cy-run-note',
          textContent: name === 'GpuUnavailableError' ? 'Drawing the graph needs WebGPU, which this browser doesn’t offer.' : `The graph couldn’t be drawn: ${(e as Error).message}`,
        }),
      )
    }
  }

  const run = async (ex: HTMLElement) => {
    const { result } = parts(ex)
    ex.setAttribute('aria-busy', 'true')
    say(ex, client ? 'Running…' : 'Starting the engine…')
    // The views drawn by this example's last run go.
    for (let i = views.length - 1; i >= 0; i--) {
      if (ex.contains(views[i]!.host)) {
        views[i]!.view.destroy()
        views.splice(i, 1)
      }
    }
    try {
      const c = await engine()
      const name = ex.getAttribute('data-dataset') as DatasetName
      const r = await c.run(current(ex), undefined, { dataset: { name, size: DATASET_SIZE[name], history: WITH_HISTORY.has(name) } })
      result.replaceChildren()
      if (r.explain) {
        const pre = doc.createElement('pre')
        pre.className = 'cy-run-plan'
        pre.textContent = String(r.rows[0]?.[0] ?? '')
        result.append(pre)
        say(ex, 'The plan, not run')
        return
      }
      const wrote = Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
      if (r.columns.length) result.append(table(r.columns, r.rows))
      else result.append(Object.assign(doc.createElement('p'), { className: 'cy-run-note', textContent: wrote.length ? `Done: ${wrote.join(', ')}` : 'Done: no rows' }))
      say(ex, `${r.rows.length.toLocaleString()} ${r.rows.length === 1 ? 'row' : 'rows'} · ${r.ms < 1 ? r.ms.toFixed(2) : Math.round(r.ms)} ms`)
      await draw(ex, result, r.rows)
    } catch (e) {
      const err = e as Error & { code?: string }
      const box = doc.createElement('div')
      box.className = 'cy-run-error'
      box.setAttribute('role', 'alert')
      if (err.code) box.append(Object.assign(doc.createElement('strong'), { textContent: err.code }), ' ')
      box.append(err.message)
      result.replaceChildren(box)
      say(ex, 'Error')
    } finally {
      ex.removeAttribute('aria-busy')
    }
  }

  doc.addEventListener('click', (e) => {
    const button = (e.target as Element | null)?.closest?.('[data-run]')
    const ex = button?.closest<HTMLElement>('.cy-run')
    if (!button || !ex) return
    const action = button.getAttribute('data-run')
    if (action === 'open') return
    e.preventDefault()
    if (action === 'run') void run(ex)
    else if (action === 'edit') edit(ex).focus()
    else if (action === 'reset') {
      const ta = editor(ex)
      if (ta) ta.value = original(ex)
      link(ex)
    } else if (action === 'copy') {
      navigator.clipboard.writeText(current(ex)).then(
        () => say(ex, 'Copied'),
        () => say(ex, 'Copy failed: the browser blocked the clipboard'),
      )
    }
  })

  // The views follow the site's theme.
  new MutationObserver(() => {
    for (const v of views) v.view.setTheme(isDark() ? 'dark' : 'light')
  }).observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] })

  // VitePress swaps the page on navigation: set the new examples' links, and free the old page's views.
  const ready = () => {
    doc.querySelectorAll<HTMLElement>('.cy-run:not(.cy-run-ready)').forEach((ex) => {
      ex.classList.add('cy-run-ready')
      link(ex)
    })
    for (let i = views.length - 1; i >= 0; i--) {
      if (!doc.contains(views[i]!.host)) {
        views[i]!.view.destroy()
        views.splice(i, 1)
      }
    }
  }
  new MutationObserver(() => {
    if (doc.querySelector('.cy-run:not(.cy-run-ready)') || views.some((v) => !doc.contains(v.host))) ready()
  }).observe(doc.body, { childList: true, subtree: true })
  ready()
}
