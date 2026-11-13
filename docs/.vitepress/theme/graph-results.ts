// Query results to a graph the renderer draws: every node, relationship and path in the rows. Shared by the playground,
// the runnable examples and the tech demo.
import { defaultCaption, resultsToGraph } from '../../../src/render/index'
import type { RenderGraph } from '../../../src/render/index'

export interface GNode {
  id: number
  labels: string[]
  properties: Record<string, unknown>
  caption: string
}

export interface GEdge {
  id: number
  type: string
  start: number
  end: number
  properties: Record<string, unknown>
}

export interface Drawn {
  nodes: GNode[]
  edges: GEdge[]
}

export function caption(props: Record<string, unknown>, labels: readonly string[], id: number): string {
  return defaultCaption({ kind: 'node', id, labels, properties: props })
}

/** Every node, relationship and path in the rows (the renderer's resultsToGraph); null when there are none. */
export function collect(rows: readonly (readonly unknown[])[]): Drawn | null {
  const r = resultsToGraph(rows)
  if (r.nodes.length === 0) return null
  return {
    nodes: r.nodes.map((n) => ({ id: n.id as number, labels: [...n.labels], properties: { ...n.properties }, caption: defaultCaption(n) })),
    edges: r.relationships.map((e) => ({ id: e.id as number, type: e.type, start: e.start as number, end: e.end as number, properties: { ...e.properties } })),
  }
}

export function toRender(d: Drawn): RenderGraph {
  const index = new Map(d.nodes.map((n, i) => [n.id, i]))
  return {
    nodes: d.nodes.map((n) => ({ id: n.id, label: n.caption, group: n.labels[0] ?? '' })),
    edges: d.edges
      .filter((e) => index.has(e.start) && index.has(e.end))
      .map((e) => ({ source: index.get(e.start)!, target: index.get(e.end)!, label: e.type, group: e.type })),
  }
}

/** How to move around a graph view, with a mouse and by touch (GraphControls.vue says the same). */
export function controlsHint(mode: '2d' | '3d'): { mouse: string; touch: string } {
  return mode === '2d'
    ? { mouse: 'Drag: pan · Scroll: zoom · Drag a node: move it · Arrows, + and −', touch: 'One finger: pan · Two fingers: pan and pinch to zoom' }
    : { mouse: 'Drag: tilt and turn · Shift-, right- or Space-drag: pan · Scroll: zoom', touch: 'One finger: tilt and turn · Two fingers: pan and pinch to zoom' }
}

/** A value as text, for result tables. */
export function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v !== 'object') return typeof v === 'string' ? v : JSON.stringify(v)
  const o = v as { kind?: string }
  if (o.kind === 'node') {
    const n = v as { labels: string[]; properties: Record<string, unknown> }
    return `(${n.labels.map((l) => ':' + l).join('')} ${JSON.stringify(n.properties)})`
  }
  if (o.kind === 'relationship') {
    const r = v as GEdge
    return `[:${r.type}${Object.keys(r.properties).length ? ' ' + JSON.stringify(r.properties) : ''}]`
  }
  if (o.kind === 'path') {
    const p = v as { nodes: { properties: Record<string, unknown>; labels: string[]; id: number }[] }
    return p.nodes.map((n) => caption(n.properties, n.labels, n.id)).join(' → ')
  }
  return JSON.stringify(v)
}

/** Code for a link: UTF-8, then base64url. */
export function encodeCode(code: string): string {
  let bin = ''
  for (const b of new TextEncoder().encode(code)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeCode(text: string): string {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}
