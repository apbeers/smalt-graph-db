/**
 * MemoryStore: a mutable store of maps and adjacency lists. Each node keeps the ids of its outgoing and incoming
 * relationships, so an expansion reads one list. Label sets and property indexes are kept up to date on every write.
 * Transactions keep an undo log.
 */
import type { Direction } from '../plan/ops.js';
import { SmaltcyError } from '../errors.js';
import type { PropertyValue } from '../values.js';
import type { AdjacentFn, GraphStore, StoreCapabilities, StoreStats } from './interface.js';

interface NodeRec {
  readonly labels: Set<string>;
  readonly props: Map<string, PropertyValue>;
  readonly out: number[];
  readonly in: number[];
}

interface RelRec {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly props: Map<string, PropertyValue>;
}

/** A key for a property value in an index: values equal in Cypher get the same key. */
export function valueKey(v: PropertyValue): string {
  if (v === null) return 'z';
  switch (typeof v) {
    case 'number': return Object.is(v, -0) ? 'n0' : `n${v}`;
    case 'string': return `s${v}`;
    case 'boolean': return v ? 'bt' : 'bf';
  }
  return `l${(v as readonly PropertyValue[]).map(valueKey).join('\u0001')}\u0002`;
}

const indexName = (label: string, key: string) => `${label}\u0000${key}`;

export class MemoryStore implements GraphStore {
  readonly name: string = 'memory';
  readonly capabilities: StoreCapabilities = { writes: true, propertyIndexes: 'declared' };

  private readonly nodes = new Map<number, NodeRec>();
  private readonly rels = new Map<number, RelRec>();
  private readonly byLabel = new Map<string, Set<number>>();
  private readonly typeCounts = new Map<string, number>();
  private readonly propIndexes = new Map<string, Map<string, Set<number>>>();
  private nextNode = 0;
  private nextRel = 0;
  private undo: (() => void)[] | null = null;

  stats(): StoreStats {
    const labels = new Map<string, number>();
    for (const [l, s] of this.byLabel) if (s.size) labels.set(l, s.size);
    const types = new Map<string, number>();
    for (const [t, c] of this.typeCounts) if (c) types.set(t, c);
    return { nodes: this.nodes.size, rels: this.rels.size, labels, types };
  }

  scanNodes(label: string | null, fn: (node: number) => void | boolean): void {
    const ids = label === null ? this.nodes.keys() : this.byLabel.get(label)?.values();
    if (!ids) return;
    // A snapshot, so the caller may write while it scans.
    for (const id of [...ids]) if (this.nodes.has(id) && fn(id) === false) return;
  }

  nodesByProperty(label: string, key: string, value: PropertyValue): readonly number[] | null {
    const idx = this.propIndexes.get(indexName(label, key));
    if (!idx) return null;
    return [...(idx.get(valueKey(value)) ?? [])];
  }

  hasNode(node: number): boolean {
    return this.nodes.has(node);
  }
  labels(node: number): readonly string[] {
    return [...this.node(node).labels];
  }
  hasLabel(node: number, label: string): boolean {
    return this.nodes.get(node)?.labels.has(label) ?? false;
  }
  nodeProperty(node: number, key: string): PropertyValue | undefined {
    return this.nodes.get(node)?.props.get(key);
  }
  nodeProperties(node: number): Readonly<Record<string, PropertyValue>> {
    return Object.fromEntries(this.node(node).props);
  }

  hasRel(rel: number): boolean {
    return this.rels.has(rel);
  }
  relType(rel: number): string {
    return this.rel(rel).type;
  }
  relStart(rel: number): number {
    return this.rel(rel).start;
  }
  relEnd(rel: number): number {
    return this.rel(rel).end;
  }
  relProperty(rel: number, key: string): PropertyValue | undefined {
    return this.rels.get(rel)?.props.get(key);
  }
  relProperties(rel: number): Readonly<Record<string, PropertyValue>> {
    return Object.fromEntries(this.rel(rel).props);
  }
  scanRels(types: readonly string[] | null, fn: (rel: number) => void | boolean): void {
    for (const [id, r] of [...this.rels]) {
      if (types && types.length && !types.includes(r.type)) continue;
      if (fn(id) === false) return;
    }
  }

  expand(node: number, dir: Direction, types: readonly string[] | null, fn: AdjacentFn): void {
    const n = this.nodes.get(node);
    if (!n) return;
    const any = !types || types.length === 0;
    if (dir !== 'in') {
      for (const id of n.out) {
        const r = this.rels.get(id)!;
        if ((any || types!.includes(r.type)) && fn(id, r.end) === false) return;
      }
    }
    if (dir !== 'out') {
      for (const id of n.in) {
        const r = this.rels.get(id)!;
        // With `both`, a self-loop was already reported going out.
        if (dir === 'both' && r.start === r.end) continue;
        if ((any || types!.includes(r.type)) && fn(id, r.start) === false) return;
      }
    }
  }

  degree(node: number, dir: Direction, types: readonly string[] | null): number {
    const n = this.nodes.get(node);
    if (!n) return 0;
    if (!types || types.length === 0) {
      if (dir === 'out') return n.out.length;
      if (dir === 'in') return n.in.length;
    }
    let d = 0;
    this.expand(node, dir, types, () => void d++);
    return d;
  }

  indexes(): readonly { label: string; key: string }[] {
    return [...this.propIndexes.keys()].map((k) => {
      const [label, key] = k.split('\u0000') as [string, string];
      return { label, key };
    });
  }

  createIndex(label: string, key: string): void {
    const name = indexName(label, key);
    if (this.propIndexes.has(name)) return;
    const idx = new Map<string, Set<number>>();
    for (const id of this.byLabel.get(label) ?? []) {
      const v = this.nodes.get(id)!.props.get(key);
      if (v !== undefined) addTo(idx, valueKey(v), id);
    }
    this.propIndexes.set(name, idx);
    this.log(() => this.propIndexes.delete(name));
  }

  dropIndex(label: string, key: string): void {
    const name = indexName(label, key);
    const idx = this.propIndexes.get(name);
    if (!idx) return;
    this.propIndexes.delete(name);
    this.log(() => this.propIndexes.set(name, idx));
  }

  createNode(labels: readonly string[], props: Readonly<Record<string, PropertyValue>>, id?: number): number {
    id = this.newId(id, this.nodes, 'node');
    this.nextNode = Math.max(this.nextNode, id + 1);
    const rec: NodeRec = { labels: new Set(), props: new Map(), out: [], in: [] };
    this.nodes.set(id, rec);
    this.log(() => this.nodes.delete(id));
    for (const l of labels) this.addLabel(id, l);
    for (const [k, v] of Object.entries(props)) if (v !== null && v !== undefined) this.setNodeProperty(id, k, v);
    return id;
  }

  createRel(type: string, start: number, end: number, props: Readonly<Record<string, PropertyValue>>, id?: number): number {
    const s = this.node(start);
    const e = this.node(end);
    id = this.newId(id, this.rels, 'relationship');
    this.nextRel = Math.max(this.nextRel, id + 1);
    this.rels.set(id, { type, start, end, props: new Map() });
    s.out.push(id);
    e.in.push(id);
    this.typeCounts.set(type, (this.typeCounts.get(type) ?? 0) + 1);
    this.log(() => {
      this.rels.delete(id);
      remove(s.out, id);
      remove(e.in, id);
      this.typeCounts.set(type, this.typeCounts.get(type)! - 1);
    });
    for (const [k, v] of Object.entries(props)) if (v !== null && v !== undefined) this.setRelProperty(id, k, v);
    return id;
  }

  setNodeProperty(node: number, key: string, value: PropertyValue | undefined): void {
    const n = this.node(node);
    const old = n.props.get(key);
    this.unindex(node, n, key, old);
    if (value === undefined || value === null) n.props.delete(key);
    else n.props.set(key, value);
    this.index(node, n, key, value ?? undefined);
    this.log(() => {
      this.unindex(node, n, key, value ?? undefined);
      if (old === undefined) n.props.delete(key);
      else n.props.set(key, old);
      this.index(node, n, key, old);
    });
  }

  setRelProperty(rel: number, key: string, value: PropertyValue | undefined): void {
    const r = this.rel(rel);
    const old = r.props.get(key);
    if (value === undefined || value === null) r.props.delete(key);
    else r.props.set(key, value);
    this.log(() => (old === undefined ? r.props.delete(key) : r.props.set(key, old)));
  }

  addLabel(node: number, label: string): void {
    const n = this.node(node);
    if (n.labels.has(label)) return;
    n.labels.add(label);
    addTo(this.byLabel, label, node);
    for (const [k, v] of n.props) this.indexOne(label, k, v, node, true);
    this.log(() => {
      n.labels.delete(label);
      this.byLabel.get(label)!.delete(node);
      for (const [k, v] of n.props) this.indexOne(label, k, v, node, false);
    });
  }

  removeLabel(node: number, label: string): void {
    const n = this.node(node);
    if (!n.labels.has(label)) return;
    n.labels.delete(label);
    this.byLabel.get(label)!.delete(node);
    for (const [k, v] of n.props) this.indexOne(label, k, v, node, false);
    this.log(() => {
      n.labels.add(label);
      addTo(this.byLabel, label, node);
      for (const [k, v] of n.props) this.indexOne(label, k, v, node, true);
    });
  }

  deleteNode(node: number): void {
    const n = this.nodes.get(node);
    if (!n) return;
    if (n.out.length || n.in.length) {
      throw new SmaltcyError('SMALTCY_CONSTRAINT', `Cannot delete node ${node}: it still has relationships (use DETACH DELETE)`);
    }
    for (const l of [...n.labels]) this.removeLabel(node, l);
    for (const k of [...n.props.keys()]) this.setNodeProperty(node, k, undefined);
    this.nodes.delete(node);
    this.log(() => this.nodes.set(node, n));
  }

  deleteRel(rel: number): void {
    const r = this.rels.get(rel);
    if (!r) return;
    const s = this.nodes.get(r.start)!;
    const e = this.nodes.get(r.end)!;
    const si = s.out.indexOf(rel);
    const ei = e.in.indexOf(rel);
    s.out.splice(si, 1);
    e.in.splice(ei, 1);
    this.rels.delete(rel);
    this.typeCounts.set(r.type, this.typeCounts.get(r.type)! - 1);
    this.log(() => {
      this.rels.set(rel, r);
      s.out.splice(si, 0, rel);
      e.in.splice(ei, 0, rel);
      this.typeCounts.set(r.type, this.typeCounts.get(r.type)! + 1);
    });
  }

  begin(): void {
    if (this.undo) throw new SmaltcyError('SMALTCY_UNSUPPORTED', 'A transaction is already open');
    this.undo = [];
  }
  commit(): void {
    this.undo = null;
  }
  rollback(): void {
    const undo = this.undo;
    this.undo = null;
    if (undo) for (let i = undo.length - 1; i >= 0; i--) undo[i]!();
  }

  /** The next id, or the one asked for (a replayed history keeps its ids), which must be free. */
  private newId(id: number | undefined, used: Map<number, unknown>, what: string): number {
    if (id === undefined) return what === 'node' ? this.nextNode : this.nextRel;
    if (!Number.isInteger(id) || id < 0) throw new SmaltcyError('SMALTCY_CONSTRAINT', `A ${what} id must be a non-negative integer, not ${id}`);
    if (used.has(id)) throw new SmaltcyError('SMALTCY_CONSTRAINT', `A ${what} with id ${id} already exists`);
    return id;
  }

  private log(fn: () => void): void {
    this.undo?.push(fn);
  }

  private node(id: number): NodeRec {
    const n = this.nodes.get(id);
    if (!n) throw new SmaltcyError('SMALTCY_NOT_FOUND', `Node ${id} does not exist`);
    return n;
  }

  private rel(id: number): RelRec {
    const r = this.rels.get(id);
    if (!r) throw new SmaltcyError('SMALTCY_NOT_FOUND', `Relationship ${id} does not exist`);
    return r;
  }

  private index(node: number, n: NodeRec, key: string, v: PropertyValue | undefined): void {
    if (v === undefined) return;
    for (const l of n.labels) this.indexOne(l, key, v, node, true);
  }

  private unindex(node: number, n: NodeRec, key: string, v: PropertyValue | undefined): void {
    if (v === undefined) return;
    for (const l of n.labels) this.indexOne(l, key, v, node, false);
  }

  private indexOne(label: string, key: string, v: PropertyValue, node: number, add: boolean): void {
    const idx = this.propIndexes.get(indexName(label, key));
    if (!idx) return;
    const vk = valueKey(v);
    if (add) addTo(idx, vk, node);
    else idx.get(vk)?.delete(node);
  }
}

function addTo<K>(m: Map<K, Set<number>>, k: K, id: number): void {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(id);
}

function remove(a: number[], v: number): void {
  const i = a.lastIndexOf(v);
  if (i >= 0) a.splice(i, 1);
}
