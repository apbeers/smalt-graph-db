/**
 * Import and export of whole graphs as JSON: how a graph persists until smaltcy keeps its data in smaltdb's storage
 * (docs/adr/0001-smaltcy.md, "Persistence").
 */
import { SmaltcyError } from '../errors.js';
import type { GraphStore, HistoryJSON } from '../store/interface.js';
import type { PropertyValue } from '../values.js';

export interface GraphJSON {
  /** `smaltcy-graph`, so a file can be recognised. */
  readonly format?: 'smaltcy-graph';
  /** 1, or 2 with `history`. */
  readonly version?: 1 | 2;
  readonly nodes: readonly {
    /** Any id, used only to connect relationships in this file. */
    readonly id: string | number;
    readonly labels?: readonly string[];
    readonly properties?: Readonly<Record<string, PropertyValue>>;
  }[];
  readonly relationships: readonly {
    readonly start: string | number;
    readonly end: string | number;
    readonly type: string;
    readonly properties?: Readonly<Record<string, PropertyValue>>;
  }[];
  readonly indexes?: readonly { readonly label: string; readonly key: string }[];
  /**
   * Version 2: the graph's history, every version (a graph opened with history keeps it). `nodes` and
   * `relationships` are the latest version, so a reader that ignores history still gets the graph.
   */
  readonly history?: HistoryJSON;
}

/** Adds a graph to a store. Returns the store's ids for the file's node ids. */
export function loadGraph(store: GraphStore, data: GraphJSON): Map<string | number, number> {
  if (!store.capabilities.writes) throw new SmaltcyError('SMALTCY_UNSUPPORTED', `The ${store.name} store is read-only`);
  const w = store as Required<GraphStore>;
  const ids = new Map<string | number, number>();
  for (const ix of data.indexes ?? []) w.createIndex(ix.label, ix.key);
  for (const n of data.nodes) {
    if (ids.has(n.id)) throw new SmaltcyError('SMALTCY_CONSTRAINT', `Node id ${n.id} appears twice`);
    ids.set(n.id, w.createNode(n.labels ?? [], n.properties ?? {}));
  }
  for (const r of data.relationships) {
    const s = ids.get(r.start);
    const e = ids.get(r.end);
    if (s === undefined || e === undefined) throw new SmaltcyError('SMALTCY_NOT_FOUND', `A ${r.type} relationship refers to a node that isn't in the file (${s === undefined ? r.start : r.end})`);
    w.createRel(r.type, s, e, r.properties ?? {});
  }
  return ids;
}

/** The whole graph as JSON, with the store's ids. */
export function dumpGraph(store: GraphStore): GraphJSON {
  const nodes: { id: number; labels: readonly string[]; properties: Readonly<Record<string, PropertyValue>> }[] = [];
  store.scanNodes(null, (id) => void nodes.push({ id, labels: store.labels(id), properties: store.nodeProperties(id) }));
  const relationships: { start: number; end: number; type: string; properties: Readonly<Record<string, PropertyValue>> }[] = [];
  store.scanRels(null, (id) => void relationships.push({ start: store.relStart(id), end: store.relEnd(id), type: store.relType(id), properties: store.relProperties(id) }));
  return { format: 'smaltcy-graph', version: 1, nodes, relationships, indexes: [...store.indexes()] };
}
