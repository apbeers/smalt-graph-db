/**
 * CsrStore: a read-only store in compressed sparse row form. Each node's outgoing and incoming relationships sit
 * next to each other in typed arrays, so an expansion reads a contiguous range with no objects. Properties are kept
 * by key, one array per key. Every (label, key) pair is indexed the first time a query looks it up.
 *
 * Build one from any store with `CsrStore.from(store)`. Ids are renumbered densely in the order the source store
 * scans them; on a fresh store with no deletes they're the same ids.
 */
import type { Direction } from '../plan/ops.js';
import { SmaltcyError } from '../errors.js';
import type { PropertyValue } from '../values.js';
import type { AdjacentFn, GraphStore, StoreCapabilities, StoreStats } from './interface.js';
import { valueKey } from './memory.js';

class Interner {
  readonly names: string[] = [];
  private readonly ids = new Map<string, number>();
  id(name: string): number {
    let i = this.ids.get(name);
    if (i === undefined) {
      i = this.names.length;
      this.names.push(name);
      this.ids.set(name, i);
    }
    return i;
  }
  get(name: string): number | undefined {
    return this.ids.get(name);
  }
}

export class CsrStore implements GraphStore {
  readonly name: string = 'csr';
  readonly capabilities: StoreCapabilities = { writes: false, propertyIndexes: 'all' };

  private constructor(
    private readonly nodeCount: number,
    private readonly labelNames: Interner,
    private readonly labelOffsets: Int32Array,
    private readonly labelIds: Int32Array,
    private readonly byLabel: Int32Array[],
    private readonly typeNames: Interner,
    private readonly relTypeIds: Int32Array,
    private readonly relStarts: Int32Array,
    private readonly relEnds: Int32Array,
    private readonly outOffsets: Int32Array,
    private readonly outRels: Int32Array,
    private readonly inOffsets: Int32Array,
    private readonly inRels: Int32Array,
    private readonly nodeProps: Map<string, (PropertyValue | undefined)[]>,
    private readonly relProps: Map<string, (PropertyValue | undefined)[]>,
    private readonly declaredIndexes: { label: string; key: string }[],
  ) {}

  static from(src: GraphStore): CsrStore {
    const nodeIndex = new Map<number, number>();
    src.scanNodes(null, (id) => void nodeIndex.set(id, nodeIndex.size));
    const n = nodeIndex.size;
    const relIndex = new Map<number, number>();
    src.scanRels(null, (id) => void relIndex.set(id, relIndex.size));
    const m = relIndex.size;

    // Labels.
    const labelNames = new Interner();
    const labelOffsets = new Int32Array(n + 1);
    const labelList: number[] = [];
    const nodeProps = new Map<string, (PropertyValue | undefined)[]>();
    for (const [id, i] of nodeIndex) {
      for (const l of src.labels(id)) labelList.push(labelNames.id(l));
      labelOffsets[i + 1] = labelList.length;
      for (const [k, v] of Object.entries(src.nodeProperties(id))) {
        let col = nodeProps.get(k);
        if (!col) nodeProps.set(k, (col = new Array(n)));
        col[i] = v;
      }
    }
    const labelIds = Int32Array.from(labelList);
    const members: number[][] = labelNames.names.map(() => []);
    for (let i = 0; i < n; i++) for (let j = labelOffsets[i]!; j < labelOffsets[i + 1]!; j++) members[labelIds[j]!]!.push(i);
    const byLabel = members.map((a) => Int32Array.from(a));

    // Relationships.
    const typeNames = new Interner();
    const relTypeIds = new Int32Array(m);
    const relStarts = new Int32Array(m);
    const relEnds = new Int32Array(m);
    const relProps = new Map<string, (PropertyValue | undefined)[]>();
    const outCount = new Int32Array(n + 1);
    const inCount = new Int32Array(n + 1);
    for (const [id, i] of relIndex) {
      relTypeIds[i] = typeNames.id(src.relType(id));
      const s = nodeIndex.get(src.relStart(id))!;
      const e = nodeIndex.get(src.relEnd(id))!;
      relStarts[i] = s;
      relEnds[i] = e;
      outCount[s + 1]!++;
      inCount[e + 1]!++;
      for (const [k, v] of Object.entries(src.relProperties(id))) {
        let col = relProps.get(k);
        if (!col) relProps.set(k, (col = new Array(m)));
        col[i] = v;
      }
    }
    for (let i = 0; i < n; i++) {
      outCount[i + 1]! += outCount[i]!;
      inCount[i + 1]! += inCount[i]!;
    }
    const outRels = new Int32Array(m);
    const inRels = new Int32Array(m);
    const outFill = outCount.slice(0, n);
    const inFill = inCount.slice(0, n);
    // Relationships go in in id order, so each node's lists are sorted by id, as MemoryStore's are.
    for (let r = 0; r < m; r++) {
      outRels[outFill[relStarts[r]!]!++] = r;
      inRels[inFill[relEnds[r]!]!++] = r;
    }
    return new CsrStore(n, labelNames, labelOffsets, labelIds, byLabel, typeNames, relTypeIds, relStarts, relEnds, outCount, outRels, inCount, inRels, nodeProps, relProps, [...src.indexes()]);
  }

  private readonly lazyIndexes = new Map<string, Map<string, number[]>>();

  private cachedStats: StoreStats | null = null;

  /** Computed once: the store never changes. */
  stats(): StoreStats {
    return (this.cachedStats ??= this.computeStats());
  }

  private computeStats(): StoreStats {
    const labels = new Map<string, number>();
    this.labelNames.names.forEach((l, i) => labels.set(l, this.byLabel[i]!.length));
    const types = new Map<string, number>();
    for (let r = 0; r < this.relTypeIds.length; r++) {
      const t = this.typeNames.names[this.relTypeIds[r]!]!;
      types.set(t, (types.get(t) ?? 0) + 1);
    }
    return { nodes: this.nodeCount, rels: this.relTypeIds.length, labels, types };
  }

  scanNodes(label: string | null, fn: (node: number) => void | boolean): void {
    if (label === null) {
      for (let i = 0; i < this.nodeCount; i++) if (fn(i) === false) return;
      return;
    }
    const l = this.labelNames.get(label);
    if (l === undefined) return;
    for (const id of this.byLabel[l]!) if (fn(id) === false) return;
  }

  nodesByProperty(label: string, key: string, value: PropertyValue): readonly number[] | null {
    const name = `${label}\u0000${key}`;
    let idx = this.lazyIndexes.get(name);
    if (!idx) {
      idx = new Map();
      const col = this.nodeProps.get(key);
      const l = this.labelNames.get(label);
      if (col && l !== undefined) {
        for (const id of this.byLabel[l]!) {
          const v = col[id];
          if (v === undefined) continue;
          const k = valueKey(v);
          const list = idx.get(k);
          if (list) list.push(id);
          else idx.set(k, [id]);
        }
      }
      this.lazyIndexes.set(name, idx);
    }
    return idx.get(valueKey(value)) ?? [];
  }

  hasNode(node: number): boolean {
    return Number.isInteger(node) && node >= 0 && node < this.nodeCount;
  }
  labels(node: number): readonly string[] {
    this.checkNode(node);
    const out: string[] = [];
    for (let j = this.labelOffsets[node]!; j < this.labelOffsets[node + 1]!; j++) out.push(this.labelNames.names[this.labelIds[j]!]!);
    return out;
  }
  hasLabel(node: number, label: string): boolean {
    const l = this.labelNames.get(label);
    if (l === undefined || !this.hasNode(node)) return false;
    for (let j = this.labelOffsets[node]!; j < this.labelOffsets[node + 1]!; j++) if (this.labelIds[j] === l) return true;
    return false;
  }
  nodeProperty(node: number, key: string): PropertyValue | undefined {
    return this.nodeProps.get(key)?.[node];
  }
  nodeProperties(node: number): Readonly<Record<string, PropertyValue>> {
    this.checkNode(node);
    const out: Record<string, PropertyValue> = {};
    for (const [k, col] of this.nodeProps) if (col[node] !== undefined) out[k] = col[node]!;
    return out;
  }

  hasRel(rel: number): boolean {
    return Number.isInteger(rel) && rel >= 0 && rel < this.relTypeIds.length;
  }
  relType(rel: number): string {
    this.checkRel(rel);
    return this.typeNames.names[this.relTypeIds[rel]!]!;
  }
  relStart(rel: number): number {
    this.checkRel(rel);
    return this.relStarts[rel]!;
  }
  relEnd(rel: number): number {
    this.checkRel(rel);
    return this.relEnds[rel]!;
  }
  relProperty(rel: number, key: string): PropertyValue | undefined {
    return this.relProps.get(key)?.[rel];
  }
  relProperties(rel: number): Readonly<Record<string, PropertyValue>> {
    this.checkRel(rel);
    const out: Record<string, PropertyValue> = {};
    for (const [k, col] of this.relProps) if (col[rel] !== undefined) out[k] = col[rel]!;
    return out;
  }
  scanRels(types: readonly string[] | null, fn: (rel: number) => void | boolean): void {
    const want = this.typeSet(types);
    if (want === false) return;
    for (let r = 0; r < this.relTypeIds.length; r++) {
      if (want && !want.includes(this.relTypeIds[r]!)) continue;
      if (fn(r) === false) return;
    }
  }

  expand(node: number, dir: Direction, types: readonly string[] | null, fn: AdjacentFn): void {
    if (!this.hasNode(node)) return;
    const want = this.typeSet(types);
    if (want === false) return;
    const t = this.relTypeIds;
    if (dir !== 'in') {
      for (let j = this.outOffsets[node]!, end = this.outOffsets[node + 1]!; j < end; j++) {
        const r = this.outRels[j]!;
        if ((!want || want.includes(t[r]!)) && fn(r, this.relEnds[r]!) === false) return;
      }
    }
    if (dir !== 'out') {
      for (let j = this.inOffsets[node]!, end = this.inOffsets[node + 1]!; j < end; j++) {
        const r = this.inRels[j]!;
        const other = this.relStarts[r]!;
        if (dir === 'both' && other === node) continue;
        if ((!want || want.includes(t[r]!)) && fn(r, other) === false) return;
      }
    }
  }

  degree(node: number, dir: Direction, types: readonly string[] | null): number {
    if (!this.hasNode(node)) return 0;
    if (!types || types.length === 0) {
      if (dir === 'out') return this.outOffsets[node + 1]! - this.outOffsets[node]!;
      if (dir === 'in') return this.inOffsets[node + 1]! - this.inOffsets[node]!;
    }
    let d = 0;
    this.expand(node, dir, types, () => void d++);
    return d;
  }

  indexes(): readonly { label: string; key: string }[] {
    return this.declaredIndexes;
  }

  /** `null`: any type; `false`: none of the types exist; otherwise the type ids. */
  private typeSet(types: readonly string[] | null): number[] | null | false {
    if (!types || types.length === 0) return null;
    const ids = types.map((t) => this.typeNames.get(t)).filter((i): i is number => i !== undefined);
    return ids.length ? ids : false;
  }

  private checkNode(node: number): void {
    if (!this.hasNode(node)) throw new SmaltcyError('SMALTCY_NOT_FOUND', `Node ${node} does not exist`);
  }
  private checkRel(rel: number): void {
    if (!this.hasRel(rel)) throw new SmaltcyError('SMALTCY_NOT_FOUND', `Relationship ${rel} does not exist`);
  }
}
