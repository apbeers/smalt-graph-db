/**
 * The engine's entry point: a graph over a store, running plans. It carries no language: a language turns its text
 * into plans (`@smaltworks/smaltcy/cypher`), and `@smaltworks/smaltcy`'s `open()` puts the two together.
 */
import { SmaltcyError } from '../errors.js';
import type { Expr } from '../plan/expr.js';
import type { GraphPlan, Op, QueryPlan } from '../plan/ops.js';
import { validatePlan } from '../plan/validate.js';
import type { GraphStore } from '../store/interface.js';
import { MemoryStore } from '../store/memory.js';
import type { ResultValue, Value } from '../values.js';
import { runQuery, toResult, type WriteCounts, emptyCounts } from './exec.js';
import { explainPlan, explainText, type ExplainLine } from './explain.js';

export interface Result {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ResultValue[])[];
  /** What the statement wrote. */
  readonly counts: WriteCounts;
  /** Time spent running the plan, in milliseconds. */
  readonly ms: number;
  /** For a plan with `asOf`: the version it read. */
  readonly version?: number;
}

/** The rows of a result as objects keyed by column. */
export function records(r: Result): Record<string, ResultValue>[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]!])));
}

export type Params = Readonly<Record<string, unknown>>;

function writes(op: Op): boolean {
  switch (op.op) {
    case 'create': case 'merge': case 'set': case 'remove': case 'delete': return true;
    case 'argument': return false;
    case 'union': return op.inputs.some(writes);
    default: return writes(op.input);
  }
}

export class GraphEngine {
  private inTransaction = false;

  constructor(readonly store: GraphStore = new MemoryStore()) {}

  /** Validates and runs a plan. A plan that writes runs in a transaction of its own unless one is open. */
  run(plan: GraphPlan, params: Params = {}): Result {
    validatePlan(plan);
    const t0 = performance.now();
    if (plan.kind !== 'query') {
      const fn = plan.kind === 'createIndex' ? this.store.createIndex : this.store.dropIndex;
      if (!fn) throw new SmaltcyError('SMALTCY_UNSUPPORTED', `The ${this.store.name} store has no declared indexes`);
      fn.call(this.store, plan.label, plan.key);
      return { columns: [], rows: [], counts: emptyCounts(), ms: performance.now() - t0 };
    }
    if (plan.asOf) {
      // The past: the same plan, on a read-only store of that version.
      const { store, version } = this.pastStore(plan, params);
      const { rows, counts } = runQuery(plan, store, params as Record<string, Value>);
      const out = rows.map((r) => r.map((v) => toResult(v, store)));
      return { columns: plan.columns.map((c) => c.name), rows: out, counts, ms: performance.now() - t0, version };
    }
    const own = writes(plan.root) && !this.inTransaction;
    if (own) this.begin();
    try {
      const { rows, counts } = runQuery(plan, this.store, params as Record<string, Value>);
      const out = rows.map((r) => r.map((v) => toResult(v, this.store)));
      if (own) this.commit();
      return { columns: plan.columns.map((c) => c.name), rows: out, counts, ms: performance.now() - t0 };
    } catch (e) {
      if (own) this.rollback();
      throw e;
    }
  }

  explain(plan: GraphPlan, params: Params = {}): ExplainLine[] {
    validatePlan(plan);
    if (plan.kind === 'query' && plan.asOf) {
      const { store, version } = this.pastStore(plan, params);
      return [{ depth: 0, op: 'AsOf', detail: `version ${version}` }, ...explainPlan(plan, store).map((l) => ({ ...l, depth: l.depth + 1 }))];
    }
    return explainPlan(plan, this.store);
  }

  /** The store a plan with `asOf` reads: the version it names, or the last one at the moment it names. */
  private pastStore(plan: QueryPlan, params: Params): { store: GraphStore; version: number } {
    const h = this.store.history;
    if (!h) throw new SmaltcyError('SMALTCY_UNSUPPORTED', `The ${this.store.name} store keeps no history, so it has no past versions to read`);
    const asOf = plan.asOf!;
    const value = (x: Expr): unknown => {
      if (x.k === 'lit') return x.v;
      if (x.k === 'param') {
        const v = params[x.name];
        if (v === undefined) throw new SmaltcyError('SMALTCY_PARAM', `Missing parameter $${x.name}`);
        return v;
      }
      throw new SmaltcyError('SMALTCY_PLAN', 'asOf takes a literal or a parameter');
    };
    let version: number;
    if ('version' in asOf) {
      const v = value(asOf.version);
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new SmaltcyError('SMALTCY_TYPE', `AT VERSION takes a whole number, not ${JSON.stringify(v)}`);
      version = v;
    } else {
      const t = value(asOf.time);
      const ms = typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : t instanceof Date ? t.getTime() : NaN;
      if (!Number.isFinite(ms)) throw new SmaltcyError('SMALTCY_TYPE', `AT TIME takes milliseconds since 1970 or an ISO 8601 date and time, not ${JSON.stringify(t)}`);
      version = h.versionAt(ms);
    }
    return { store: h.at(version), version };
  }

  explainText(plan: GraphPlan): string {
    return explainText(this.explain(plan));
  }

  /** Runs `fn` in one transaction: every write commits together, or none does if `fn` throws. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.begin();
    try {
      const r = fn();
      this.commit();
      return r;
    } catch (e) {
      this.rollback();
      throw e;
    }
  }

  private begin(): void {
    if (!this.store.capabilities.writes) throw new SmaltcyError('SMALTCY_UNSUPPORTED', `The ${this.store.name} store is read-only`);
    this.store.begin!();
    this.inTransaction = true;
  }
  private commit(): void {
    this.inTransaction = false;
    this.store.commit!();
  }
  private rollback(): void {
    this.inTransaction = false;
    this.store.rollback!();
  }
}

export type { QueryPlan };
