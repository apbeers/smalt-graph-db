/**
 * Graph plan operations: an immutable tree that a language builds and the engine runs. Plans are plain data
 * (JSON-serializable), validated before they run, and never name a storage structure: every store runs the same plan
 * (docs/adr/0001-smaltcy.md).
 *
 * A row is an array of `slots` values. Each operation takes the rows of its `input` and passes on rows with more slots
 * bound (`match`, `unwind`, `project`, `create` …), fewer rows (`filter`, `limit`, `distinct`) or new rows
 * (`aggregate`). Leaves are `argument`: one row, carrying the slots of the row it is run from (empty at the top of a
 * plan, the outer row's for nested plans in `exists` and `optional` matches).
 */
import { setOpAnalysis, slotsRead, type Expr } from './expr.js';

export const PLAN_VERSION = 1;

export type Direction = 'out' | 'in' | 'both';

/** A node in a pattern. A slot that is already bound when the pattern runs constrains it; otherwise it binds. */
export interface PatternNode {
  readonly slot: number;
  /** The node has all of these labels. */
  readonly labels: readonly string[];
  /** A map expression: the node's properties equal these. */
  readonly props?: Expr;
}

/**
 * A relationship in a pattern between `nodes[from]` and `nodes[to]`, in the direction given (`out`: from → to).
 * With `min` / `max` it's a variable-length relationship and its slot holds the list of relationships it went
 * through. `shortest` asks for the shortest such paths only (both ends must be bound by the rest of the pattern
 * first).
 */
export interface PatternRel {
  readonly slot: number;
  readonly from: number;
  readonly to: number;
  readonly dir: Direction;
  /** Any of these types; empty means any type. */
  readonly types: readonly string[];
  readonly props?: Expr;
  readonly min?: number;
  /** Absent with `min` present: no upper bound. */
  readonly max?: number;
  readonly shortest?: 'one' | 'all';
}

/** A named path: alternating `nodes` and `rels` indexes into the pattern, written to `slot`. */
export interface PatternPath {
  readonly slot: number;
  readonly nodes: readonly number[];
  readonly rels: readonly number[];
}

export interface Pattern {
  readonly nodes: readonly PatternNode[];
  readonly rels: readonly PatternRel[];
  readonly paths?: readonly PatternPath[];
}

export interface Projection {
  readonly slot: number;
  readonly expr: Expr;
}

export interface AggCall {
  readonly slot: number;
  /** A registered aggregate: `count`, `sum`, `avg`, `min`, `max`, `collect`, `stdev` … */
  readonly fn: string;
  /** No arguments: `count(*)`. */
  readonly args: readonly Expr[];
  readonly distinct: boolean;
}

export interface SortKey {
  readonly expr: Expr;
  readonly desc: boolean;
}

export type SetItem =
  /** `target.key = value`; NULL removes the property. */
  | { readonly kind: 'prop'; readonly target: Expr; readonly key: string; readonly value: Expr }
  /** `target = map` (replace) or `target += map` (merge). */
  | { readonly kind: 'props'; readonly target: Expr; readonly value: Expr; readonly merge: boolean }
  | { readonly kind: 'labels'; readonly target: Expr; readonly labels: readonly string[] };

export type RemoveItem =
  | { readonly kind: 'prop'; readonly target: Expr; readonly key: string }
  | { readonly kind: 'labels'; readonly target: Expr; readonly labels: readonly string[] };

export type Op =
  | { readonly op: 'argument'; readonly slots: readonly number[] }
  /**
   * Every way the pattern matches, for each input row. Relationships are distinct within one match. `where` is part
   * of the match: with `optional`, a row that has no match (or none passing `where`) is passed on once with the
   * pattern's new slots NULL.
   */
  | { readonly op: 'match'; readonly input: Op; readonly pattern: Pattern; readonly where?: Expr; readonly optional: boolean }
  | { readonly op: 'filter'; readonly input: Op; readonly pred: Expr }
  /** Computes slots. With `discard`, every other slot of the row is cleared (a new scope, as Cypher's WITH). */
  | { readonly op: 'project'; readonly input: Op; readonly items: readonly Projection[]; readonly discard: boolean }
  /** One row per distinct combination of keys (one row in all with no keys, even with no input). */
  | { readonly op: 'aggregate'; readonly input: Op; readonly keys: readonly Projection[]; readonly aggs: readonly AggCall[] }
  | { readonly op: 'distinct'; readonly input: Op; readonly slots: readonly number[] }
  /** Stable. */
  | { readonly op: 'sort'; readonly input: Op; readonly keys: readonly SortKey[] }
  | { readonly op: 'limit'; readonly input: Op; readonly skip?: Expr; readonly count?: Expr }
  | { readonly op: 'unwind'; readonly input: Op; readonly list: Expr; readonly slot: number }
  /** Reads all its input before passing any of it on, so the writes after it can't change what was read. */
  | { readonly op: 'eager'; readonly input: Op }
  /** Each branch writes the same `slots`. Without `all`, duplicate rows (over `slots`) are dropped. */
  | { readonly op: 'union'; readonly inputs: readonly Op[]; readonly slots: readonly number[]; readonly all: boolean }
  /** Creates the pattern's unbound nodes and all its relationships (each with one type and a direction). */
  | { readonly op: 'create'; readonly input: Op; readonly pattern: Pattern }
  /** Matches the whole pattern, or creates it when it doesn't match. */
  | {
      readonly op: 'merge';
      readonly input: Op;
      readonly pattern: Pattern;
      readonly onCreate: readonly SetItem[];
      readonly onMatch: readonly SetItem[];
    }
  | { readonly op: 'set'; readonly input: Op; readonly items: readonly SetItem[] }
  | { readonly op: 'remove'; readonly input: Op; readonly items: readonly RemoveItem[] }
  /** Deletes nodes, relationships and paths. Without `detach`, deleting a node that has relationships fails. */
  | { readonly op: 'delete'; readonly input: Op; readonly targets: readonly Expr[]; readonly detach: boolean };

export interface Column {
  readonly name: string;
  readonly slot: number;
}

/** A query: run `root`, and return `columns` of each row. */
export interface QueryPlan {
  readonly kind: 'query';
  readonly planVersion: number;
  /** Row width. */
  readonly slots: number;
  /** For EXPLAIN and errors: the language's name for each slot. */
  readonly slotNames?: readonly string[];
  readonly root: Op;
  readonly columns: readonly Column[];
  /**
   * Read the graph as it was: at a version (an integer) or a moment (`time`: milliseconds since 1970, or an ISO 8601
   * string). Literals or parameters only. The store must keep its history; a plan that reads the past can't write.
   */
  readonly asOf?: { readonly version: Expr } | { readonly time: Expr };
}

/** A property index, used by `match` to find nodes with a label and a property value. */
export interface IndexPlan {
  readonly kind: 'createIndex' | 'dropIndex';
  readonly planVersion: number;
  readonly label: string;
  readonly key: string;
}

export type GraphPlan = QueryPlan | IndexPlan;

/** The direct inputs of an operation. */
export function inputs(op: Op): readonly Op[] {
  if (op.op === 'argument') return [];
  if (op.op === 'union') return op.inputs;
  return [op.input];
}

/** Every expression an operation holds directly (not its inputs'). */
export function exprsOf(op: Op): Expr[] {
  const out: Expr[] = [];
  const pattern = (p: Pattern) => {
    for (const n of p.nodes) if (n.props) out.push(n.props);
    for (const r of p.rels) if (r.props) out.push(r.props);
  };
  const setItems = (items: readonly (SetItem | RemoveItem)[]) => {
    for (const it of items) {
      out.push(it.target);
      if ('value' in it) out.push(it.value);
    }
  };
  switch (op.op) {
    case 'argument': case 'distinct': case 'eager': case 'union': break;
    case 'match': pattern(op.pattern); if (op.where) out.push(op.where); break;
    case 'filter': out.push(op.pred); break;
    case 'project': for (const p of op.items) out.push(p.expr); break;
    case 'aggregate':
      for (const p of op.keys) out.push(p.expr);
      for (const a of op.aggs) out.push(...a.args);
      break;
    case 'sort': for (const k of op.keys) out.push(k.expr); break;
    case 'limit': if (op.skip) out.push(op.skip); if (op.count) out.push(op.count); break;
    case 'unwind': out.push(op.list); break;
    case 'create': pattern(op.pattern); break;
    case 'merge': pattern(op.pattern); setItems(op.onCreate); setItems(op.onMatch); break;
    case 'set': setItems(op.items); break;
    case 'remove': setItems(op.items); break;
    case 'delete': out.push(...op.targets); break;
  }
  return out;
}

/** The slots bound in the rows an operation passes on. */
export function boundSlots(op: Op): Set<number> {
  switch (op.op) {
    case 'argument': return new Set(op.slots);
    case 'match': case 'create': case 'merge': {
      const b = boundSlots(op.input);
      for (const n of op.pattern.nodes) b.add(n.slot);
      for (const r of op.pattern.rels) b.add(r.slot);
      for (const p of op.pattern.paths ?? []) b.add(p.slot);
      return b;
    }
    case 'project': {
      const b = op.discard ? new Set<number>() : boundSlots(op.input);
      for (const p of op.items) b.add(p.slot);
      return b;
    }
    case 'aggregate': return new Set([...op.keys.map((k) => k.slot), ...op.aggs.map((a) => a.slot)]);
    case 'unwind': return boundSlots(op.input).add(op.slot);
    case 'union': return new Set(op.slots);
    default: return boundSlots(op.input);
  }
}

/** The outer slots a nested plan reads: what its `argument` leaves carry. */
export function argumentSlots(op: Op, out = new Set<number>()): Set<number> {
  if (op.op === 'argument') for (const s of op.slots) out.add(s);
  for (const i of inputs(op)) argumentSlots(i, out);
  return out;
}

setOpAnalysis(argumentSlots, boundSlots);

/** The slots an expression reads, re-exported for convenience. */
export { slotsRead };
