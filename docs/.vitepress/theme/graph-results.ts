// Query results to a graph the renderer draws: every node, relationship and path in the rows. Shared by the playground,
// the runnable examples and the tech demo.
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
  for (const k of ['name', 'title', 'label', 'code']) if (props[k] != null) return String(props[k])
  return labels[0] ? `${labels[0]} ${id}` : String(id)
}

/** Every node, relationship and path in the rows; null when there are none. */
export function collect(rows: readonly (readonly unknown[])[]): Drawn | null {
  const nodes = new Map<number, GNode>()
  const edges = new Map<number, GEdge>()
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach(visit)
    const o = v as { kind?: string }
    if (o.kind === 'node') {
      const n = v as { id: number; labels: string[]; properties: Record<string, unknown> }
      nodes.set(n.id, { id: n.id, labels: [...n.labels], properties: n.properties, caption: caption(n.properties, n.labels, n.id) })
    } else if (o.kind === 'relationship') {
      const r = v as GEdge
      edges.set(r.id, { id: r.id, type: r.type, start: r.start, end: r.end, properties: r.properties })
    } else if (o.kind === 'path') {
      const p = v as { nodes: unknown[]; relationships: unknown[] }
      p.nodes.forEach(visit)
      p.relationships.forEach(visit)
    } else Object.values(v).forEach(visit)
  }
  rows.forEach(visit)
  if (nodes.size === 0) return null
  // Relationships whose ends aren't in the rows still show, with their ends as plain nodes.
  for (const e of edges.values()) {
    for (const id of [e.start, e.end]) if (!nodes.has(id)) nodes.set(id, { id, labels: [], properties: {}, caption: String(id) })
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
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
