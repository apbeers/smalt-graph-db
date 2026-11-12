/**
 * smaltcy: a graph database for the browser that speaks Cypher.
 *
 * ```ts
 * import { open } from '@smaltworks/smaltcy';
 * const db = open();
 * db.run("CREATE (:Person {name: 'Ada'})-[:KNOWS]->(:Person {name: 'Alan'})");
 * db.run('MATCH (a)-[:KNOWS]->(b) RETURN a.name, b.name').rows; // [['Ada', 'Alan']]
 * ```
 */
import { compile } from './cypher/index.js';
import { GraphEngine, records, type Params, type Result } from './engine/database.js';
import { emptyCounts } from './engine/exec.js';
import { dumpGraph, loadGraph, type GraphJSON } from './engine/io.js';
import { explainText, type ExplainLine } from './engine/explain.js';
import type { GraphPlan } from './plan/ops.js';
import type { GraphStore } from './store/interface.js';
import { MemoryStore } from './store/memory.js';
import type { ResultValue } from './values.js';
import { HistoryStore, type HistoryOptions } from './history/index.js';
import type { CommitInfo, GraphDiff, HistoryReader } from './store/interface.js';
import { SmaltcyError } from './errors.js';

export interface OpenOptions {
  /** The store to keep the graph in (default: a new MemoryStore). */
  readonly store?: GraphStore;
  /**
   * Keep the graph's history: every committed write becomes a version you can query (`AT VERSION`, `graph.at()`) and
   * scrub through. `true`, or options such as the default `author`. Wraps `store`, which must be a MemoryStore.
   */
  readonly history?: boolean | HistoryOptions;
}

/** What a write records in the graph's history. */
export interface RunOptions {
  readonly author?: string;
  readonly message?: string;
}

export interface CypherResult extends Result {
  /** The plan the statement ran, for EXPLAIN views. */
  readonly plan: GraphPlan;
  /** Set when the statement was EXPLAIN: the plan's steps instead of rows. */
  readonly explain?: readonly ExplainLine[];
  /** With history: the version the statement read (`AT VERSION`) or, after a write, the version it made. */
  readonly version?: number;
}

/** A graph you query with Cypher. */
export class Graph {
  private eng: GraphEngine;

  constructor(store: GraphStore = new MemoryStore()) {
    this.eng = new GraphEngine(store);
  }

  get engine(): GraphEngine {
    return this.eng;
  }

  get store(): GraphStore {
    return this.eng.store;
  }

  /** Runs one Cypher statement. `EXPLAIN …` returns the plan's steps; `AT VERSION n …` reads the graph as it was. */
  run(cypher: string, params: Params = {}, options: RunOptions = {}): CypherResult {
    const { plan, explain } = compile(cypher);
    if (explain) {
      const lines = this.eng.explain(plan, params);
      return { columns: ['plan'], rows: [[explainText(lines)]], counts: emptyCounts(), ms: 0, plan, explain: lines };
    }
    return this.withCommit(options, () => {
      const r = this.eng.run(plan, params);
      const h = this.store.history;
      return { ...r, plan, ...(h ? { version: r.version ?? h.version } : {}) };
    });
  }

  /** Runs a statement and returns its rows as objects. */
  query(cypher: string, params: Params = {}, options: RunOptions = {}): Record<string, ResultValue>[] {
    return records(this.run(cypher, params, options));
  }

  /** The plan for a statement, as indented text. */
  explain(cypher: string): string {
    return this.eng.explainText(compile(cypher).plan);
  }

  /**
   * Adds a graph from JSON (see `GraphJSON`), in one transaction. A file with history, loaded into an empty graph that
   * keeps history, brings every version with it.
   */
  load(data: GraphJSON, options: RunOptions = {}): void {
    const store = this.store;
    if (data.history && store instanceof HistoryStore && store.history.version === 0 && store.stats().nodes === 0) {
      this.eng = new GraphEngine(HistoryStore.fromJSON(data.history, store.options));
      for (const ix of data.indexes ?? []) this.store.createIndex?.(ix.label, ix.key);
      return;
    }
    this.withCommit(options, () => this.eng.transaction(() => loadGraph(this.store, data)));
  }

  /** The whole graph as JSON, to save and `load` later; with its history when it keeps one. */
  toJSON(): GraphJSON {
    const store = this.store;
    const json = dumpGraph(store);
    return store instanceof HistoryStore ? { ...json, version: 2, history: store.toJSON() } : json;
  }

  /** Runs `fn` in one transaction: one version in the history. */
  transaction<T>(fn: (g: Graph) => T, options: RunOptions = {}): T {
    return this.withCommit(options, () => this.eng.transaction(() => fn(this)));
  }

  // History.

  /** The graph's history, when it keeps one. */
  get history(): HistoryReader | undefined {
    return this.store.history;
  }

  /** The latest version (0 before the first write); undefined without history. */
  get version(): number | undefined {
    return this.store.history?.version;
  }

  /** The graph as it was at a version, or at a moment: read-only, and every query works on it. */
  at(when: number | Date): Graph {
    const h = this.requireHistory();
    const version = when instanceof Date ? h.versionAt(when.getTime()) : when;
    return new Graph(h.at(version));
  }

  /** The commits from version `from` (exclusive) to `to`, oldest first; all by default. */
  commits(from?: number, to?: number): readonly CommitInfo[] {
    return this.requireHistory().commits(from, to);
  }

  /** What changed from one version to another (either way): nodes and relationships added, removed and changed. */
  diff(from: number, to: number): GraphDiff {
    return this.requireHistory().diff(from, to);
  }

  private requireHistory(): HistoryReader {
    const h = this.store.history;
    if (!h) throw new SmaltcyError('SMALTCY_UNSUPPORTED', 'This graph keeps no history: open it with { history: true }');
    return h;
  }

  /** Runs `fn` with the author and message of the commit it may make. */
  private withCommit<T>(options: RunOptions, fn: () => T): T {
    const store = this.store;
    if (!(store instanceof HistoryStore) || (options.author === undefined && options.message === undefined)) return fn();
    store.nextCommit(options);
    try {
      return fn();
    } finally {
      store.nextCommit(null);
    }
  }
}

/** Opens an in-memory graph, with its history when asked. */
export function open(options: OpenOptions = {}): Graph {
  if (!options.history) return new Graph(options.store);
  const inner = options.store ?? new MemoryStore();
  if (!(inner instanceof MemoryStore)) throw new SmaltcyError('SMALTCY_UNSUPPORTED', 'History keeps a MemoryStore: pass one, or no store');
  return new Graph(new HistoryStore(inner, options.history === true ? {} : options.history));
}

export { compile } from './cypher/index.js';
export type { GraphJSON } from './engine/io.js';
export { HistoryStore, type HistoryOptions } from './history/index.js';
export type { Change, Commit, CommitInfo, EntityChange, GraphDiff, HistoryReader } from './store/interface.js';
export { connect, GraphClient } from './worker/client.js';
export type { DatasetLoaded, DatasetRequest, GraphStats, Overview } from './worker/protocol.js';
export { records, type Params, type Result } from './engine/database.js';
export { MemoryStore, CsrStore, type GraphStore } from './store/index.js';
export { SmaltcyError, type ErrorCode } from './errors.js';
export type { Node, Relationship, Path, ResultValue } from './values.js';
export type { GraphPlan } from './plan/ops.js';
