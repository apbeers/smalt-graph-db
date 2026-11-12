/**
 * HistoryStore: a store that remembers. It wraps a writable store (a MemoryStore by default) and records every write;
 * each committed transaction becomes a version, with its time, author and message. Any past version opens as a
 * read-only store (`history.at(v)`) that runs every plan and every Cypher query, and `history.diff(a, b)` says what
 * changed between two versions, for redrawing a graph as a timeline moves.
 *
 * How the past is kept: a change log (each change holds what's needed to apply it either way) plus a full snapshot
 * every `checkpointEvery` changes. Opening a version starts from the nearest snapshot, or from the present, and
 * applies the changes in between.
 */
import { SmaltcyError } from '../errors.js';
import type { Direction } from '../plan/ops.js';
import type {
  AdjacentFn,
  Change,
  ChangeCounts,
  Commit,
  CommitInfo,
  EntityChange,
  GraphDiff,
  GraphSnapshot,
  GraphStore,
  HistoryJSON,
  HistoryReader,
  StoreCapabilities,
  StoreStats,
} from '../store/interface.js';
import { MemoryStore } from '../store/memory.js';
import type { PropertyValue } from '../values.js';

export interface HistoryOptions {
  /** The author of commits that don't name one. */
  readonly author?: string;
  /** Changes between snapshots of the whole graph (default 2,000): fewer make opening a past version faster. */
  readonly checkpointEvery?: number;
  /** The clock commits are stamped with (default `Date.now`). Times never go backwards. */
  readonly clock?: () => number;
}

/** What the next commit says about itself: set before the write, used when it commits. */
export interface CommitDetails {
  readonly author?: string;
  readonly message?: string;
  /** Milliseconds since 1970; default the clock. For replaying history that happened elsewhere. */
  readonly time?: number;
}

const ZERO: ChangeCounts = { nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsChanged: 0 };

function countChanges(changes: readonly Change[]): ChangeCounts {
  const c = { ...ZERO };
  for (const ch of changes) {
    switch (ch.k) {
      case 'nodeCreated': c.nodesCreated++; break;
      case 'nodeDeleted': c.nodesDeleted++; break;
      case 'relCreated': c.relationshipsCreated++; break;
      case 'relDeleted': c.relationshipsDeleted++; break;
      case 'nodeProp': case 'relProp': c.propertiesSet++; break;
      case 'labelAdded': case 'labelRemoved': c.labelsChanged++; break;
    }
  }
  return c;
}

const sameValue = (a: PropertyValue | undefined, b: PropertyValue | undefined) =>
  a === b || (a !== undefined && b !== undefined && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));

const cleanProps = (p: Readonly<Record<string, PropertyValue>>): Record<string, PropertyValue> => {
  const out: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined) out[k] = v;
  return out;
};

/** The change that undoes `c`. */
export function invert(c: Change): Change {
  switch (c.k) {
    case 'nodeCreated': return { ...c, k: 'nodeDeleted' };
    case 'nodeDeleted': return { ...c, k: 'nodeCreated' };
    case 'relCreated': return { ...c, k: 'relDeleted' };
    case 'relDeleted': return { ...c, k: 'relCreated' };
    case 'nodeProp': case 'relProp': return { k: c.k, id: c.id, key: c.key, old: c.new, new: c.old };
    case 'labelAdded': return { ...c, k: 'labelRemoved' };
    case 'labelRemoved': return { ...c, k: 'labelAdded' };
  }
}

/** Applies a change to a MemoryStore that holds the graph just before it (ids are kept). */
export function apply(store: MemoryStore, c: Change): void {
  switch (c.k) {
    case 'nodeCreated': store.createNode(c.labels, c.props, c.id); return;
    case 'nodeDeleted': store.deleteNode(c.id); return;
    case 'relCreated': store.createRel(c.type, c.start, c.end, c.props, c.id); return;
    case 'relDeleted': store.deleteRel(c.id); return;
    case 'nodeProp': store.setNodeProperty(c.id, c.key, c.new); return;
    case 'relProp': store.setRelProperty(c.id, c.key, c.new); return;
    case 'labelAdded': store.addLabel(c.id, c.label); return;
    case 'labelRemoved': store.removeLabel(c.id, c.label); return;
  }
}

export function snapshotOf(store: GraphStore, version: number): GraphSnapshot {
  const nodes: GraphSnapshot['nodes'][number][] = [];
  store.scanNodes(null, (id) => void nodes.push({ id, labels: [...store.labels(id)], props: { ...store.nodeProperties(id) } }));
  const relationships: GraphSnapshot['relationships'][number][] = [];
  store.scanRels(null, (id) => void relationships.push({ id, type: store.relType(id), start: store.relStart(id), end: store.relEnd(id), props: { ...store.relProperties(id) } }));
  return { version, nodes, relationships };
}

function restore(snap: GraphSnapshot, indexes: readonly { label: string; key: string }[]): MemoryStore {
  const s = new MemoryStore();
  for (const ix of indexes) s.createIndex(ix.label, ix.key);
  for (const n of snap.nodes) s.createNode(n.labels, n.props, n.id);
  for (const r of snap.relationships) s.createRel(r.type, r.start, r.end, r.props, r.id);
  return s;
}

const entityKey = (c: Change): string => (c.k.startsWith('node') || c.k.startsWith('label') ? `n${c.id}` : `r${c.id}`);

/** The shared record of a history: commits, snapshots and the index of changes by element. */
class Log {
  readonly commits: Commit[] = [];
  /** Snapshots, oldest first; the first is the base the log starts from. */
  readonly checkpoints: GraphSnapshot[] = [];
  /** Element key → positions in `commits` of the commits that changed it. */
  readonly byEntity = new Map<string, number[]>();
  changesSinceCheckpoint = 0;
  /** Recently opened versions. */
  readonly cache = new Map<number, GraphStore>();

  constructor(base: GraphSnapshot) {
    this.checkpoints.push(base);
  }

  get first(): number {
    return this.checkpoints[0]!.version;
  }
  get last(): number {
    return this.commits.length ? this.commits[this.commits.length - 1]!.version : this.first;
  }

  /** The commit with this version. */
  get(version: number): Commit | undefined {
    const i = version - this.first - 1;
    return this.commits[i];
  }

  add(commit: Commit): void {
    const pos = this.commits.length;
    this.commits.push(commit);
    for (const c of commit.changes) {
      const key = entityKey(c);
      let list = this.byEntity.get(key);
      if (!list) this.byEntity.set(key, (list = []));
      if (list[list.length - 1] !== pos) list.push(pos);
    }
  }
}

/** Reads a log up to a version: a HistoryStore's own history, or a past view's. */
class Reader implements HistoryReader {
  constructor(
    private readonly log: Log,
    private readonly cap: () => number,
    private readonly present: () => GraphStore,
  ) {}

  get version(): number {
    return this.cap();
  }

  commits(from = this.log.first, to = this.cap()): readonly CommitInfo[] {
    const hi = Math.min(to, this.cap());
    const out: CommitInfo[] = [];
    for (let v = Math.max(from, this.log.first) + 1; v <= hi; v++) {
      const { changes: _changes, ...info } = this.log.get(v)!;
      out.push(info);
    }
    return out;
  }

  commit(version: number): Commit | undefined {
    return version <= this.cap() ? this.log.get(version) : undefined;
  }

  versionAt(time: number): number {
    const cs = this.log.commits;
    let lo = 0;
    let hi = cs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cs[mid]!.time <= time) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo === 0 ? this.log.first : cs[lo - 1]!.version, this.cap());
  }

  at(version: number): GraphStore {
    const log = this.log;
    if (!Number.isInteger(version) || version < log.first || version > this.cap()) {
      throw new SmaltcyError('SMALTCY_NOT_FOUND', `There is no version ${version}: this history has versions ${log.first} to ${this.cap()}`);
    }
    const hit = log.cache.get(version);
    if (hit) return hit;
    // Start from the nearest snapshot at or before the version, or from the present if that's nearer.
    let cp = log.checkpoints[0]!;
    for (const c of log.checkpoints) if (c.version <= version) cp = c;
    const present = this.present();
    const forward = log.commits.slice(cp.version - log.first, version - log.first).reduce((n, c) => n + c.changes.length, 0);
    const backward = log.commits.slice(version - log.first, log.last - log.first).reduce((n, c) => n + c.changes.length, 0);
    // Going back from the present first copies the whole live graph, so it only pays when that and the changes to
    // undo cost less than replaying from the snapshot (which is already a copy).
    const st = present.stats();
    let mem: MemoryStore;
    if (backward + st.nodes + st.rels < forward) {
      mem = restore(snapshotOf(present, log.last), present.indexes());
      for (let v = log.last; v > version; v--) {
        const ch = log.get(v)!.changes;
        for (let i = ch.length - 1; i >= 0; i--) apply(mem, invert(ch[i]!));
      }
    } else {
      mem = restore(cp, present.indexes());
      for (let v = cp.version + 1; v <= version; v++) for (const c of log.get(v)!.changes) apply(mem, c);
    }
    const view = new PastStore(mem, new Reader(log, () => version, () => present), version);
    if (log.cache.size >= 4) log.cache.delete(log.cache.keys().next().value!);
    log.cache.set(version, view);
    return view;
  }

  diff(from: number, to: number): GraphDiff {
    const log = this.log;
    for (const v of [from, to]) {
      if (!Number.isInteger(v) || v < log.first || v > this.cap()) throw new SmaltcyError('SMALTCY_NOT_FOUND', `There is no version ${v}`);
    }
    // The changes from `from` to `to`, in the order they apply (undone in reverse when going back).
    const steps: Change[] = [];
    if (to >= from) {
      for (let v = from + 1; v <= to; v++) steps.push(...log.get(v)!.changes);
    } else {
      for (let v = from; v > to; v--) {
        const ch = log.get(v)!.changes;
        for (let i = ch.length - 1; i >= 0; i--) steps.push(invert(ch[i]!));
      }
    }
    return foldDiff(from, to, steps);
  }

  changesOf(kind: 'node' | 'relationship', id: number): readonly EntityChange[] {
    const key = `${kind === 'node' ? 'n' : 'r'}${id}`;
    const out: EntityChange[] = [];
    for (const pos of this.log.byEntity.get(key) ?? []) {
      const commit = this.log.commits[pos]!;
      if (commit.version > this.cap()) break;
      const { changes, ...info } = commit;
      for (const change of changes) if (entityKey(change) === key) out.push({ commit: info, change });
    }
    return out;
  }
}

/** Net changes per element, folded from a sequence of steps. */
function foldDiff(from: number, to: number, steps: readonly Change[]): GraphDiff {
  interface Acc {
    existedAtStart: boolean;
    exists: boolean;
    full: { labels: Set<string>; props: Map<string, PropertyValue>; type?: string; start?: number; end?: number } | null;
    set: Map<string, PropertyValue | null>;
    added: Set<string>;
    removed: Set<string>;
  }
  const nodes = new Map<number, Acc>();
  const rels = new Map<number, Acc>();
  const acc = (m: Map<number, Acc>, id: number, created: boolean): Acc => {
    let a = m.get(id);
    if (!a) m.set(id, (a = { existedAtStart: !created, exists: !created, full: null, set: new Map(), added: new Set(), removed: new Set() }));
    return a;
  };
  for (const c of steps) {
    switch (c.k) {
      case 'nodeCreated': {
        const a = acc(nodes, c.id, true);
        a.exists = true;
        a.full = { labels: new Set(c.labels), props: new Map(Object.entries(c.props)) };
        break;
      }
      case 'relCreated': {
        const a = acc(rels, c.id, true);
        a.exists = true;
        a.full = { labels: new Set(), props: new Map(Object.entries(c.props)), type: c.type, start: c.start, end: c.end };
        break;
      }
      case 'nodeDeleted': case 'relDeleted': {
        const a = acc(c.k === 'nodeDeleted' ? nodes : rels, c.id, false);
        a.exists = false;
        a.full = null;
        break;
      }
      case 'nodeProp': case 'relProp': {
        const a = acc(c.k === 'nodeProp' ? nodes : rels, c.id, false);
        if (a.full) {
          if (c.new === undefined) a.full.props.delete(c.key);
          else a.full.props.set(c.key, c.new);
        } else a.set.set(c.key, c.new ?? null);
        break;
      }
      case 'labelAdded': case 'labelRemoved': {
        const a = acc(nodes, c.id, false);
        if (a.full) {
          if (c.k === 'labelAdded') a.full.labels.add(c.label);
          else a.full.labels.delete(c.label);
        } else if (c.k === 'labelAdded') {
          if (!a.removed.delete(c.label)) a.added.add(c.label);
        } else if (!a.added.delete(c.label)) a.removed.add(c.label);
        break;
      }
    }
  }
  const diff = { from, to, nodesAdded: [] as unknown[], nodesRemoved: [] as number[], nodesChanged: [] as unknown[], relsAdded: [] as unknown[], relsRemoved: [] as number[], relsChanged: [] as unknown[] };
  for (const [id, a] of nodes) {
    if (!a.existedAtStart && a.exists) diff.nodesAdded.push({ id, labels: [...a.full!.labels], props: Object.fromEntries(a.full!.props) });
    else if (a.existedAtStart && !a.exists) diff.nodesRemoved.push(id);
    else if (a.existedAtStart && a.exists) {
      // Created again after being deleted inside the range can't happen (ids are never reused), so `full` is null.
      if (a.set.size || a.added.size || a.removed.size) {
        diff.nodesChanged.push({ id, set: Object.fromEntries(a.set), labelsAdded: [...a.added], labelsRemoved: [...a.removed] });
      }
    }
  }
  for (const [id, a] of rels) {
    if (!a.existedAtStart && a.exists) {
      const f = a.full!;
      diff.relsAdded.push({ id, type: f.type!, start: f.start!, end: f.end!, props: Object.fromEntries(f.props) });
    } else if (a.existedAtStart && !a.exists) diff.relsRemoved.push(id);
    else if (a.existedAtStart && a.exists && a.set.size) diff.relsChanged.push({ id, set: Object.fromEntries(a.set) });
  }
  return diff as unknown as GraphDiff;
}

/** A read-only graph at a past version. */
class PastStore implements GraphStore {
  readonly name: string;
  readonly capabilities: StoreCapabilities = { writes: false, propertyIndexes: 'declared' };

  constructor(
    private readonly s: MemoryStore,
    readonly history: HistoryReader,
    readonly version: number,
  ) {
    this.name = `version ${version}`;
  }

  stats(): StoreStats { return this.s.stats(); }
  scanNodes(label: string | null, fn: (node: number) => void | boolean): void { this.s.scanNodes(label, fn); }
  nodesByProperty(label: string, key: string, value: PropertyValue): readonly number[] | null { return this.s.nodesByProperty(label, key, value); }
  hasNode(node: number): boolean { return this.s.hasNode(node); }
  labels(node: number): readonly string[] { return this.s.labels(node); }
  hasLabel(node: number, label: string): boolean { return this.s.hasLabel(node, label); }
  nodeProperty(node: number, key: string): PropertyValue | undefined { return this.s.nodeProperty(node, key); }
  nodeProperties(node: number): Readonly<Record<string, PropertyValue>> { return this.s.nodeProperties(node); }
  hasRel(rel: number): boolean { return this.s.hasRel(rel); }
  relType(rel: number): string { return this.s.relType(rel); }
  relStart(rel: number): number { return this.s.relStart(rel); }
  relEnd(rel: number): number { return this.s.relEnd(rel); }
  relProperty(rel: number, key: string): PropertyValue | undefined { return this.s.relProperty(rel, key); }
  relProperties(rel: number): Readonly<Record<string, PropertyValue>> { return this.s.relProperties(rel); }
  scanRels(types: readonly string[] | null, fn: (rel: number) => void | boolean): void { this.s.scanRels(types, fn); }
  expand(node: number, dir: Direction, types: readonly string[] | null, fn: AdjacentFn): void { this.s.expand(node, dir, types, fn); }
  degree(node: number, dir: Direction, types: readonly string[] | null): number { return this.s.degree(node, dir, types); }
  indexes(): readonly { label: string; key: string }[] { return this.s.indexes(); }
}

export class HistoryStore implements GraphStore {
  readonly name: string = 'history';
  readonly capabilities: StoreCapabilities;
  readonly history: HistoryReader;

  private readonly log: Log;
  private readonly checkpointEvery: number;
  private readonly clock: () => number;
  private readonly defaultAuthor: string | undefined;
  private pending: Change[] | null = null;
  private next: CommitDetails = {};
  private lastTime = 0;
  private nodeCount: number;
  private relCount: number;

  /**
   * Wraps `inner`. What it holds already is version 0 (its first snapshot); writes after that are versions 1, 2 …
   * Write through this store only, never to `inner` directly.
   */
  constructor(
    private readonly inner: MemoryStore = new MemoryStore(),
    options: HistoryOptions = {},
  ) {
    this.capabilities = inner.capabilities;
    this.checkpointEvery = Math.max(1, options.checkpointEvery ?? 2000);
    this.clock = options.clock ?? Date.now;
    this.defaultAuthor = options.author;
    this.log = new Log(snapshotOf(inner, 0));
    const st = inner.stats();
    this.nodeCount = st.nodes;
    this.relCount = st.rels;
    this.history = new Reader(this.log, () => this.log.last, () => this);
  }

  /** Author, message or time of the next commit (then forgotten). */
  nextCommit(details: CommitDetails | null): void {
    this.next = details === null ? {} : { ...this.next, ...details };
  }

  /** The options it was made with, for a store that replaces it (loading a history from JSON). */
  get options(): HistoryOptions {
    return { author: this.defaultAuthor, checkpointEvery: this.checkpointEvery, clock: this.clock };
  }

  /** The history as JSON: its first snapshot and every commit since. */
  toJSON(): HistoryJSON {
    return { base: this.log.checkpoints[0]!, commits: this.log.commits };
  }

  /** A store with a history from JSON, every version as it was, ids kept. */
  static fromJSON(data: HistoryJSON, options: HistoryOptions = {}): HistoryStore {
    const inner = restore(data.base, []);
    const store = new HistoryStore(inner, options);
    // The file's base keeps its version number (a history that forgot its start doesn't begin at 0).
    store.log.checkpoints[0] = data.base;
    for (const c of data.commits) {
      if (c.version !== store.log.last + 1) throw new SmaltcyError('SMALTCY_CONSTRAINT', `A history's commits must be numbered in order: ${c.version} after ${store.log.last}`);
      for (const ch of c.changes) apply(inner, ch);
      store.record(c.changes, { author: c.author, message: c.message, time: c.time });
    }
    return store;
  }

  /**
   * Forgets the versions before `version`: the graph at `version` becomes the history's starting snapshot. For keeping
   * a long history small; nothing is forgotten unless this is called.
   */
  forget(version: number): void {
    const log = this.log;
    if (version <= log.first) return;
    if (version > log.last) throw new SmaltcyError('SMALTCY_NOT_FOUND', `There is no version ${version}`);
    const base = snapshotOf(this.history.at(version), version);
    log.commits.splice(0, version - log.first);
    log.checkpoints.splice(0, log.checkpoints.length, base, ...log.checkpoints.filter((c) => c.version > version));
    log.byEntity.clear();
    log.cache.clear();
    const commits = log.commits.splice(0);
    for (const c of commits) log.add(c);
  }

  // Transactions: each commit that changed something is a version.

  begin(): void {
    this.inner.begin();
    this.pending = [];
  }

  commit(): void {
    this.inner.commit();
    const changes = this.pending ?? [];
    this.pending = null;
    if (changes.length) this.record(changes, this.next);
    this.next = {};
  }

  rollback(): void {
    this.inner.rollback();
    this.pending = null;
    this.next = {};
  }

  private change(c: Change): void {
    if (this.pending) this.pending.push(c);
    else {
      // A write outside a transaction is a version of its own.
      this.record([c], this.next);
      this.next = {};
    }
  }

  private record(changes: readonly Change[], details: CommitDetails): void {
    const counts = countChanges(changes);
    this.nodeCount += counts.nodesCreated - counts.nodesDeleted;
    this.relCount += counts.relationshipsCreated - counts.relationshipsDeleted;
    const time = Math.max(this.lastTime, details.time ?? this.clock());
    this.lastTime = time;
    const author = details.author ?? this.defaultAuthor;
    const commit: Commit = {
      version: this.log.last + 1,
      time,
      ...(author !== undefined ? { author } : {}),
      ...(details.message !== undefined ? { message: details.message } : {}),
      size: changes.length,
      counts,
      nodes: this.nodeCount,
      relationships: this.relCount,
      changes,
    };
    this.log.add(commit);
    this.log.changesSinceCheckpoint += changes.length;
    if (this.log.changesSinceCheckpoint >= this.checkpointEvery) {
      this.log.checkpoints.push(snapshotOf(this.inner, commit.version));
      this.log.changesSinceCheckpoint = 0;
    }
  }

  // Writes: done, then recorded.

  createNode(labels: readonly string[], props: Readonly<Record<string, PropertyValue>>, id?: number): number {
    const n = this.inner.createNode(labels, props, id);
    this.change({ k: 'nodeCreated', id: n, labels: [...new Set(labels)], props: cleanProps(props) });
    return n;
  }

  createRel(type: string, start: number, end: number, props: Readonly<Record<string, PropertyValue>>, id?: number): number {
    const r = this.inner.createRel(type, start, end, props, id);
    this.change({ k: 'relCreated', id: r, type, start, end, props: cleanProps(props) });
    return r;
  }

  setNodeProperty(node: number, key: string, value: PropertyValue | undefined): void {
    const old = this.inner.nodeProperty(node, key);
    const now = value === null ? undefined : value;
    this.inner.setNodeProperty(node, key, now);
    if (!sameValue(old, now)) this.change({ k: 'nodeProp', id: node, key, ...(old !== undefined ? { old } : {}), ...(now !== undefined ? { new: now } : {}) });
  }

  setRelProperty(rel: number, key: string, value: PropertyValue | undefined): void {
    const old = this.inner.relProperty(rel, key);
    const now = value === null ? undefined : value;
    this.inner.setRelProperty(rel, key, now);
    if (!sameValue(old, now)) this.change({ k: 'relProp', id: rel, key, ...(old !== undefined ? { old } : {}), ...(now !== undefined ? { new: now } : {}) });
  }

  addLabel(node: number, label: string): void {
    const had = this.inner.hasLabel(node, label);
    this.inner.addLabel(node, label);
    if (!had) this.change({ k: 'labelAdded', id: node, label });
  }

  removeLabel(node: number, label: string): void {
    const had = this.inner.hasLabel(node, label);
    this.inner.removeLabel(node, label);
    if (had) this.change({ k: 'labelRemoved', id: node, label });
  }

  deleteNode(node: number): void {
    if (!this.inner.hasNode(node)) return;
    const labels = [...this.inner.labels(node)];
    const props = { ...this.inner.nodeProperties(node) };
    this.inner.deleteNode(node);
    this.change({ k: 'nodeDeleted', id: node, labels, props });
  }

  deleteRel(rel: number): void {
    if (!this.inner.hasRel(rel)) return;
    const c: Change = { k: 'relDeleted', id: rel, type: this.inner.relType(rel), start: this.inner.relStart(rel), end: this.inner.relEnd(rel), props: { ...this.inner.relProperties(rel) } };
    this.inner.deleteRel(rel);
    this.change(c);
  }

  // Indexes aren't part of the history: a past version uses the indexes the store has now.
  createIndex(label: string, key: string): void { this.inner.createIndex(label, key); }
  dropIndex(label: string, key: string): void { this.inner.dropIndex(label, key); }

  // Reads: the present.
  stats(): StoreStats { return this.inner.stats(); }
  scanNodes(label: string | null, fn: (node: number) => void | boolean): void { this.inner.scanNodes(label, fn); }
  nodesByProperty(label: string, key: string, value: PropertyValue): readonly number[] | null { return this.inner.nodesByProperty(label, key, value); }
  hasNode(node: number): boolean { return this.inner.hasNode(node); }
  labels(node: number): readonly string[] { return this.inner.labels(node); }
  hasLabel(node: number, label: string): boolean { return this.inner.hasLabel(node, label); }
  nodeProperty(node: number, key: string): PropertyValue | undefined { return this.inner.nodeProperty(node, key); }
  nodeProperties(node: number): Readonly<Record<string, PropertyValue>> { return this.inner.nodeProperties(node); }
  hasRel(rel: number): boolean { return this.inner.hasRel(rel); }
  relType(rel: number): string { return this.inner.relType(rel); }
  relStart(rel: number): number { return this.inner.relStart(rel); }
  relEnd(rel: number): number { return this.inner.relEnd(rel); }
  relProperty(rel: number, key: string): PropertyValue | undefined { return this.inner.relProperty(rel, key); }
  relProperties(rel: number): Readonly<Record<string, PropertyValue>> { return this.inner.relProperties(rel); }
  scanRels(types: readonly string[] | null, fn: (rel: number) => void | boolean): void { this.inner.scanRels(types, fn); }
  expand(node: number, dir: Direction, types: readonly string[] | null, fn: AdjacentFn): void { this.inner.expand(node, dir, types, fn); }
  degree(node: number, dir: Direction, types: readonly string[] | null): number { return this.inner.degree(node, dir, types); }
  indexes(): readonly { label: string; key: string }[] { return this.inner.indexes(); }
}
