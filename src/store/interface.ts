/**
 * The store interface: what the engine needs from a memory structure to run any plan. Plans never name a store; the
 * engine's planner reads a store's capabilities and statistics to choose how to run a plan on it (as smaltdb's ADR
 * 0028 does for storage engines). Every store passes the same conformance suite (`test/store-conformance.test.ts`).
 *
 * Ids are integers chosen by the store. Labels, types and property keys are strings at this interface; stores
 * intern them as they like.
 */
import type { Direction } from '../plan/ops.js';
import type { PropertyValue } from '../values.js';

export interface StoreCapabilities {
  /** Supports `createNode`, `createRel`, the setters and deletes, and transactions. */
  readonly writes: boolean;
  /**
   * How `nodesByProperty` answers: from the indexes created with `createIndex` (`declared`), from an index on every
   * (label, key) pair (`all`), or never (`none`: it returns null and the engine scans).
   */
  readonly propertyIndexes: 'declared' | 'all' | 'none';
}

export interface StoreStats {
  readonly nodes: number;
  readonly rels: number;
  readonly labels: ReadonlyMap<string, number>;
  readonly types: ReadonlyMap<string, number>;
}

/** Called for each relationship next to a node. Return `false` to stop. */
export type AdjacentFn = (rel: number, other: number) => void | boolean;

export interface GraphStore {
  readonly name: string;
  readonly capabilities: StoreCapabilities;

  // Statistics, for planning.
  stats(): StoreStats;

  // Nodes.
  /** Calls `fn` with every node (with the label, when given). Return `false` to stop. */
  scanNodes(label: string | null, fn: (node: number) => void | boolean): void;
  /** Nodes with the label whose property equals `value`, or `null` when there's no index for it. */
  nodesByProperty(label: string, key: string, value: PropertyValue): readonly number[] | null;
  hasNode(node: number): boolean;
  labels(node: number): readonly string[];
  hasLabel(node: number, label: string): boolean;
  nodeProperty(node: number, key: string): PropertyValue | undefined;
  nodeProperties(node: number): Readonly<Record<string, PropertyValue>>;

  // Relationships.
  hasRel(rel: number): boolean;
  relType(rel: number): string;
  relStart(rel: number): number;
  relEnd(rel: number): number;
  relProperty(rel: number, key: string): PropertyValue | undefined;
  relProperties(rel: number): Readonly<Record<string, PropertyValue>>;
  /** Calls `fn` with every relationship (of these types, when given). Return `false` to stop. */
  scanRels(types: readonly string[] | null, fn: (rel: number) => void | boolean): void;

  /**
   * Calls `fn` for each relationship at `node` in direction `dir` (of one of `types`, when given), with the node at
   * its other end. With `both`, a self-loop is reported once.
   */
  expand(node: number, dir: Direction, types: readonly string[] | null, fn: AdjacentFn): void;
  /** The number of relationships `expand` would report. */
  degree(node: number, dir: Direction, types: readonly string[] | null): number;

  // Indexes.
  indexes(): readonly { readonly label: string; readonly key: string }[];
  createIndex?(label: string, key: string): void;
  dropIndex?(label: string, key: string): void;

  // Writes: present when `capabilities.writes`.
  /** `id`: create it with this id (it must be free), as a replayed history does. Otherwise the store picks one. */
  createNode?(labels: readonly string[], props: Readonly<Record<string, PropertyValue>>, id?: number): number;
  createRel?(type: string, start: number, end: number, props: Readonly<Record<string, PropertyValue>>, id?: number): number;
  /** `undefined` or `null` removes the property. */
  setNodeProperty?(node: number, key: string, value: PropertyValue | undefined): void;
  setRelProperty?(rel: number, key: string, value: PropertyValue | undefined): void;
  addLabel?(node: number, label: string): void;
  removeLabel?(node: number, label: string): void;
  /** Fails unless the node has no relationships. */
  deleteNode?(node: number): void;
  deleteRel?(rel: number): void;

  /** Present when the store keeps its history (src/history): its versions, and the graph at any of them. */
  readonly history?: HistoryReader;

  // Transactions: present when `capabilities.writes`. Not nested.
  begin?(): void;
  commit?(): void;
  rollback?(): void;
}

// History: the types a store with history offers (src/history implements them). Here so the engine and functions can
// read history through any store without depending on the history module.

/** One change in a commit. Each holds what's needed to apply it either way (old and new values, deleted data). */
export type Change =
  | { readonly k: 'nodeCreated' | 'nodeDeleted'; readonly id: number; readonly labels: readonly string[]; readonly props: Readonly<Record<string, PropertyValue>> }
  | {
      readonly k: 'relCreated' | 'relDeleted';
      readonly id: number;
      readonly type: string;
      readonly start: number;
      readonly end: number;
      readonly props: Readonly<Record<string, PropertyValue>>;
    }
  /** `old` / `new` undefined: the property wasn't there / was removed. */
  | { readonly k: 'nodeProp' | 'relProp'; readonly id: number; readonly key: string; readonly old?: PropertyValue; readonly new?: PropertyValue }
  | { readonly k: 'labelAdded' | 'labelRemoved'; readonly id: number; readonly label: string };

/** What a commit did, counted. */
export interface ChangeCounts {
  readonly nodesCreated: number;
  readonly nodesDeleted: number;
  readonly relationshipsCreated: number;
  readonly relationshipsDeleted: number;
  readonly propertiesSet: number;
  readonly labelsChanged: number;
}

/** A version: one committed write. Version 0 is the empty graph before the first commit. */
export interface CommitInfo {
  readonly version: number;
  /** Milliseconds since 1970. */
  readonly time: number;
  readonly author?: string;
  readonly message?: string;
  /** The number of changes. */
  readonly size: number;
  readonly counts: ChangeCounts;
  /** The graph's size after the commit. */
  readonly nodes: number;
  readonly relationships: number;
}

export interface Commit extends CommitInfo {
  readonly changes: readonly Change[];
}

/** One change to one node or relationship, with its commit: what `history(x)` returns. */
export interface EntityChange {
  readonly commit: CommitInfo;
  readonly change: Change;
}

/** The net difference between two versions, for redrawing: what to add, remove and update. */
export interface GraphDiff {
  readonly from: number;
  readonly to: number;
  readonly nodesAdded: readonly { readonly id: number; readonly labels: readonly string[]; readonly props: Readonly<Record<string, PropertyValue>> }[];
  readonly nodesRemoved: readonly number[];
  /** Nodes there at both versions whose labels or properties differ: what changed (`null`: the property went). */
  readonly nodesChanged: readonly {
    readonly id: number;
    readonly set: Readonly<Record<string, PropertyValue>>;
    readonly labelsAdded: readonly string[];
    readonly labelsRemoved: readonly string[];
  }[];
  readonly relsAdded: readonly { readonly id: number; readonly type: string; readonly start: number; readonly end: number; readonly props: Readonly<Record<string, PropertyValue>> }[];
  readonly relsRemoved: readonly number[];
  readonly relsChanged: readonly { readonly id: number; readonly set: Readonly<Record<string, PropertyValue>> }[];
}

/** A whole graph at one version, with its ids: a snapshot. */
export interface GraphSnapshot {
  readonly version: number;
  readonly nodes: readonly { readonly id: number; readonly labels: readonly string[]; readonly props: Readonly<Record<string, PropertyValue>> }[];
  readonly relationships: readonly {
    readonly id: number;
    readonly type: string;
    readonly start: number;
    readonly end: number;
    readonly props: Readonly<Record<string, PropertyValue>>;
  }[];
}

/** A history in JSON: a starting snapshot and the commits after it. */
export interface HistoryJSON {
  readonly base: GraphSnapshot;
  readonly commits: readonly Commit[];
}

/** A store's history: read it through `store.history`. */
export interface HistoryReader {
  /** The latest version the store holds (for a past view, that view's version). */
  readonly version: number;
  /** Commits with versions in (from, to], oldest first; all by default. */
  commits(from?: number, to?: number): readonly CommitInfo[];
  /** The full commit, with its changes. */
  commit(version: number): Commit | undefined;
  /** The latest version committed at or before `time` (0 when none). */
  versionAt(time: number): number;
  /** The graph at a version, read-only. Its own `history` ends at that version. */
  at(version: number): GraphStore;
  /** What changed from one version to another, either way. */
  diff(from: number, to: number): GraphDiff;
  /** Every change to one node or relationship, oldest first, up to this history's version. */
  changesOf(kind: 'node' | 'relationship', id: number): readonly EntityChange[];
}

/** A store's writable half, for code that has checked `capabilities.writes`. */
export type WritableStore = Required<GraphStore>;

export function writable(store: GraphStore): WritableStore | null {
  return store.capabilities.writes ? (store as WritableStore) : null;
}
