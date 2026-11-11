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

export interface OpenOptions {
  /** The store to keep the graph in (default: a new MemoryStore). */
  readonly store?: GraphStore;
}

export interface CypherResult extends Result {
  /** The plan the statement ran, for EXPLAIN views. */
  readonly plan: GraphPlan;
  /** Set when the statement was EXPLAIN: the plan's steps instead of rows. */
  readonly explain?: readonly ExplainLine[];
}

/** A graph you query with Cypher. */
export class Graph {
  readonly engine: GraphEngine;

  constructor(store: GraphStore = new MemoryStore()) {
    this.engine = new GraphEngine(store);
  }

  get store(): GraphStore {
    return this.engine.store;
  }

  /** Runs one Cypher statement. `EXPLAIN …` returns the plan's steps instead of running it. */
  run(cypher: string, params: Params = {}): CypherResult {
    const { plan, explain } = compile(cypher);
    if (explain) {
      const lines = this.engine.explain(plan);
      return { columns: ['plan'], rows: [[explainText(lines)]], counts: emptyCounts(), ms: 0, plan, explain: lines };
    }
    return { ...this.engine.run(plan, params), plan };
  }

  /** Runs a statement and returns its rows as objects. */
  query(cypher: string, params: Params = {}): Record<string, ResultValue>[] {
    return records(this.run(cypher, params));
  }

  /** The plan for a statement, as indented text. */
  explain(cypher: string): string {
    return this.engine.explainText(compile(cypher).plan);
  }

  /** Adds a graph from JSON (see `GraphJSON`), in one transaction. */
  load(data: GraphJSON): void {
    this.engine.transaction(() => loadGraph(this.store, data));
  }

  /** The whole graph as JSON, to save and `load` later. */
  toJSON(): GraphJSON {
    return dumpGraph(this.store);
  }

  /** Runs `fn` in one transaction. */
  transaction<T>(fn: (g: Graph) => T): T {
    return this.engine.transaction(() => fn(this));
  }
}

/** Opens an in-memory graph. */
export function open(options: OpenOptions = {}): Graph {
  return new Graph(options.store);
}

export { compile } from './cypher/index.js';
export type { GraphJSON } from './engine/io.js';
export { connect, GraphClient } from './worker/client.js';
export type { GraphStats, Overview } from './worker/protocol.js';
export { records, type Params, type Result } from './engine/database.js';
export { MemoryStore, CsrStore, type GraphStore } from './store/index.js';
export { SmaltcyError, type ErrorCode } from './errors.js';
export type { Node, Relationship, Path, ResultValue } from './values.js';
export type { GraphPlan } from './plan/ops.js';
