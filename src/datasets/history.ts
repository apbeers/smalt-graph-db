/**
 * Builds a dataset's history as JSON (format 2) directly, commit by commit, with the ids a store would give, so a
 * sample graph can come with its past without the history module.
 */
import type { GraphJSON } from '../engine/io.js';
import type { Change, Commit } from '../store/interface.js';
import type { PropertyValue } from '../values.js';

type Props = Record<string, PropertyValue>;

export class HistoryBuilder {
  private nextNode = 0;
  private nextRel = 0;
  private readonly commits: Commit[] = [];
  private pending: Change[] = [];
  private readonly nodes = new Map<number, { labels: Set<string>; props: Props }>();
  private readonly rels = new Map<number, { type: string; start: number; end: number; props: Props }>();
  private readonly indexes: { label: string; key: string }[] = [];

  node(labels: readonly string[], props: Props = {}): number {
    const id = this.nextNode++;
    this.nodes.set(id, { labels: new Set(labels), props: { ...props } });
    this.pending.push({ k: 'nodeCreated', id, labels: [...labels], props: { ...props } });
    return id;
  }

  rel(type: string, start: number, end: number, props: Props = {}): number {
    const id = this.nextRel++;
    this.rels.set(id, { type, start, end, props: { ...props } });
    this.pending.push({ k: 'relCreated', id, type, start, end, props: { ...props } });
    return id;
  }

  set(id: number, key: string, value: PropertyValue | undefined): void {
    const n = this.nodes.get(id)!;
    const old = n.props[key];
    if (value === undefined) delete n.props[key];
    else n.props[key] = value;
    this.pending.push({ k: 'nodeProp', id, key, ...(old !== undefined ? { old } : {}), ...(value !== undefined ? { new: value } : {}) });
  }

  label(id: number, label: string, add = true): void {
    const n = this.nodes.get(id)!;
    if (add === n.labels.has(label)) return;
    if (add) n.labels.add(label);
    else n.labels.delete(label);
    this.pending.push({ k: add ? 'labelAdded' : 'labelRemoved', id, label });
  }

  deleteRel(id: number): void {
    const r = this.rels.get(id)!;
    this.rels.delete(id);
    this.pending.push({ k: 'relDeleted', id, ...r });
  }

  /** The ids of a node's outgoing relationships of a type. */
  relsFrom(node: number, type: string): number[] {
    return [...this.rels].filter(([, r]) => r.start === node && r.type === type).map(([id]) => id);
  }

  /** Deletes a node and its relationships. */
  deleteNode(id: number): void {
    for (const [rid, r] of [...this.rels]) if (r.start === id || r.end === id) this.deleteRel(rid);
    const n = this.nodes.get(id)!;
    this.nodes.delete(id);
    this.pending.push({ k: 'nodeDeleted', id, labels: [...n.labels], props: n.props });
  }

  index(label: string, key: string): void {
    this.indexes.push({ label, key });
  }

  /** Ends a commit. */
  commit(time: number, author: string, message: string): void {
    if (this.pending.length === 0) return;
    const changes = this.pending;
    this.pending = [];
    const counts = { nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsChanged: 0 };
    for (const c of changes) {
      if (c.k === 'nodeCreated') counts.nodesCreated++;
      else if (c.k === 'nodeDeleted') counts.nodesDeleted++;
      else if (c.k === 'relCreated') counts.relationshipsCreated++;
      else if (c.k === 'relDeleted') counts.relationshipsDeleted++;
      else if (c.k === 'nodeProp' || c.k === 'relProp') counts.propertiesSet++;
      else counts.labelsChanged++;
    }
    this.commits.push({ version: this.commits.length + 1, time, author, message, size: changes.length, counts, nodes: this.nodes.size, relationships: this.rels.size, changes });
  }

  /** The dataset: the latest graph, and its history. */
  build(): GraphJSON {
    return {
      format: 'smaltcy-graph',
      version: 2,
      nodes: [...this.nodes].map(([id, n]) => ({ id, labels: [...n.labels], properties: n.props })),
      relationships: [...this.rels.values()].map((r) => ({ start: r.start, end: r.end, type: r.type, properties: r.props })),
      indexes: this.indexes,
      history: { base: { version: 0, nodes: [], relationships: [] }, commits: this.commits },
    };
  }
}
