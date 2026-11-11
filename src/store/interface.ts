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
  createNode?(labels: readonly string[], props: Readonly<Record<string, PropertyValue>>): number;
  createRel?(type: string, start: number, end: number, props: Readonly<Record<string, PropertyValue>>): number;
  /** `undefined` or `null` removes the property. */
  setNodeProperty?(node: number, key: string, value: PropertyValue | undefined): void;
  setRelProperty?(rel: number, key: string, value: PropertyValue | undefined): void;
  addLabel?(node: number, label: string): void;
  removeLabel?(node: number, label: string): void;
  /** Fails unless the node has no relationships. */
  deleteNode?(node: number): void;
  deleteRel?(rel: number): void;

  // Transactions: present when `capabilities.writes`. Not nested.
  begin?(): void;
  commit?(): void;
  rollback?(): void;
}

/** A store's writable half, for code that has checked `capabilities.writes`. */
export type WritableStore = Required<GraphStore>;

export function writable(store: GraphStore): WritableStore | null {
  return store.capabilities.writes ? (store as WritableStore) : null;
}
