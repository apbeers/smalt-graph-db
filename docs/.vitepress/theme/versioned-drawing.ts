// A drawing that follows a graph's history: what's drawn, by node and relationship id, at one version. Start it from
// an overview, then apply the diffs the worker sends as a timeline moves: each gives the next graph to draw and the
// nodes that changed, for the renderer's animated transitions. Shared by the playground and the tech demo.
import type { GraphDiff } from '../../../src/store/interface'
import type { Overview } from '../../../src/worker/protocol'
import type { RenderGraph } from '../../../src/render/index'
import { defaultCaption } from '../../../src/render/index'

interface DrawnNode {
  labels: string[]
  caption: string
  group: string
}

/** A node's colour group, from its labels and its value of the drawing's `groupKey` property (if it has one). */
export type GroupOf = (labels: readonly string[], value: unknown) => string

export class VersionedDrawing {
  readonly nodes = new Map<number, DrawnNode>()
  readonly rels = new Map<number, { type: string; start: number; end: number }>()
  version = 0
  /** Node ids in drawing order, from the last `render()`: a hit's index finds its node. */
  order: number[] = []

  /** `groupKey`: the property `groupOf` reads; ask the overview for it too (`overview(…, { groupKey })`). */
  constructor(
    public groupOf: GroupOf = (labels) => labels[0] ?? '',
    public groupKey?: string,
  ) {}

  /** Starts from the whole graph at a version. */
  reset(ov: Overview, version: number): void {
    this.nodes.clear()
    this.rels.clear()
    ov.ids.forEach((id, i) => {
      const labels = ov.labels[i] ? [ov.labels[i]!] : []
      this.nodes.set(id, { labels, caption: ov.captions[i] || `${ov.labels[i] ?? ''} ${id}`.trim(), group: this.groupOf(labels, ov.groups?.[i]) })
    })
    ov.relIds.forEach((rid, i) => this.rels.set(rid, { type: ov.edgeTypes[i]!, start: ov.ids[ov.edges[2 * i]!]!, end: ov.ids[ov.edges[2 * i + 1]!]! }))
    this.version = version
  }

  /** Applies a diff from this drawing's version. Returns the ids of nodes that changed, for a flash. */
  apply(d: GraphDiff): number[] {
    if (d.from !== this.version) throw new Error(`The drawing is at version ${this.version}, not ${d.from}`)
    for (const id of d.relsRemoved) this.rels.delete(id)
    for (const id of d.nodesRemoved) this.nodes.delete(id)
    for (const n of d.nodesAdded) {
      this.nodes.set(n.id, { labels: [...n.labels], caption: defaultCaption({ kind: 'node', id: n.id, labels: n.labels, properties: n.props }), group: this.groupOf(n.labels, this.groupKey ? n.props[this.groupKey] : undefined) })
    }
    for (const r of d.relsAdded) this.rels.set(r.id, { type: r.type, start: r.start, end: r.end })
    const changed: number[] = []
    for (const c of d.nodesChanged) {
      const n = this.nodes.get(c.id)
      if (!n) continue
      for (const l of c.labelsAdded) if (!n.labels.includes(l)) n.labels.push(l)
      n.labels = n.labels.filter((l) => !c.labelsRemoved.includes(l))
      for (const k of ['name', 'title', 'label', 'code']) {
        if (k in c.set && c.set[k] !== null) {
          n.caption = String(c.set[k])
          break
        }
      }
      if (this.groupKey && this.groupKey in c.set) n.group = this.groupOf(n.labels, c.set[this.groupKey])
      else if (c.labelsAdded.length || c.labelsRemoved.length) n.group = this.groupOf(n.labels, undefined) || n.group
      changed.push(c.id)
    }
    this.version = d.to
    return changed
  }

  render(): RenderGraph {
    this.order = [...this.nodes.keys()]
    const index = new Map(this.order.map((id, i) => [id, i]))
    const edges: RenderGraph['edges'] = []
    for (const [id, r] of this.rels) {
      const s = index.get(r.start)
      const t = index.get(r.end)
      if (s !== undefined && t !== undefined) edges.push({ id, source: s, target: t, label: r.type, group: r.type })
    }
    return { nodes: this.order.map((id) => { const n = this.nodes.get(id)!; return { id, label: n.caption, group: n.group } }), edges }
  }
}

/**
 * Follows a timeline: asks for the diff to each version it's moved to, one request at a time, skipping versions it
 * passed while a request was out, and calls `draw` with each result.
 */
export class Scrubber {
  private target: number | null = null
  private running = false

  constructor(
    private readonly drawing: VersionedDrawing,
    private readonly diff: (from: number, to: number) => Promise<GraphDiff>,
    private readonly draw: (changed: number[]) => void,
  ) {}

  to(version: number): void {
    this.target = version
    if (!this.running) void this.pump()
  }

  private async pump(): Promise<void> {
    this.running = true
    try {
      while (this.target !== null && this.target !== this.drawing.version) {
        const target = this.target
        const d = await this.diff(this.drawing.version, target)
        this.draw(this.drawing.apply(d))
      }
    } finally {
      this.running = false
      this.target = null
    }
  }
}
