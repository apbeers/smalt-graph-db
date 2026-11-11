/**
 * Plan expressions. They read the current row by slot number (`slot`), never by name: a language resolves its
 * variables to slots when it builds the plan. Every operator's meaning is a named function in the engine's registry
 * (`call`), except the few forms that must not evaluate all their arguments (`and`, `or`, `case`, `coalesce` …).
 */
import type { Op } from './ops.js';
import type { PropertyValue } from '../values.js';

export type Expr =
  | { readonly k: 'lit'; readonly v: PropertyValue | { readonly [key: string]: PropertyValue } }
  | { readonly k: 'param'; readonly name: string }
  | { readonly k: 'slot'; readonly i: number }
  /** A property of a node, relationship or map; NULL when it's missing or `of` is NULL. */
  | { readonly k: 'prop'; readonly of: Expr; readonly key: string }
  /** A call to a registered scalar function. */
  | { readonly k: 'call'; readonly fn: string; readonly args: readonly Expr[] }
  | { readonly k: 'list'; readonly items: readonly Expr[] }
  | { readonly k: 'map'; readonly entries: readonly (readonly [string, Expr])[] }
  /** Three-valued logic, evaluated left to right, stopping early when the result is known. */
  | { readonly k: 'and' | 'or' | 'xor'; readonly args: readonly Expr[] }
  | { readonly k: 'not'; readonly arg: Expr }
  | { readonly k: 'isNull'; readonly arg: Expr; readonly negated: boolean }
  /** True when a node has every label (or a relationship has one of the types). */
  | { readonly k: 'hasLabels'; readonly of: Expr; readonly labels: readonly string[] }
  | {
      readonly k: 'case';
      readonly operand?: Expr;
      readonly whens: readonly (readonly [Expr, Expr])[];
      readonly else?: Expr;
    }
  /** `list[index]` or `map[key]`. */
  | { readonly k: 'index'; readonly of: Expr; readonly index: Expr }
  | { readonly k: 'slice'; readonly of: Expr; readonly from?: Expr; readonly to?: Expr }
  /**
   * `[x IN list WHERE pred | map]`: each element is written to `slot`, then `where` and `map` read it. Without `map`,
   * the elements themselves.
   */
  | { readonly k: 'listComp'; readonly list: Expr; readonly slot: number; readonly where?: Expr; readonly map?: Expr }
  /** `any`, `all`, `none` and `single` over a list, with the element in `slot`. */
  | { readonly k: 'quantifier'; readonly q: 'any' | 'all' | 'none' | 'single'; readonly list: Expr; readonly slot: number; readonly where: Expr }
  /** True when the plan, run from the current row (its `argument` leaf), gives at least one row. */
  | { readonly k: 'exists'; readonly plan: Op }
  /** The rows of a plan run from the current row, each turned into one value by `map`: a pattern comprehension. */
  | { readonly k: 'collectSub'; readonly plan: Op; readonly map: Expr };

/** Builders, for hand-written plans and languages. */
export const e = {
  lit: (v: PropertyValue | { readonly [key: string]: PropertyValue }): Expr => ({ k: 'lit', v }),
  param: (name: string): Expr => ({ k: 'param', name }),
  slot: (i: number): Expr => ({ k: 'slot', i }),
  prop: (of: Expr, key: string): Expr => ({ k: 'prop', of, key }),
  call: (fn: string, ...args: Expr[]): Expr => ({ k: 'call', fn, args }),
  eq: (a: Expr, b: Expr): Expr => ({ k: 'call', fn: 'eq', args: [a, b] }),
  lt: (a: Expr, b: Expr): Expr => ({ k: 'call', fn: 'lt', args: [a, b] }),
  gt: (a: Expr, b: Expr): Expr => ({ k: 'call', fn: 'gt', args: [a, b] }),
  and: (...args: Expr[]): Expr => ({ k: 'and', args }),
  or: (...args: Expr[]): Expr => ({ k: 'or', args }),
  not: (arg: Expr): Expr => ({ k: 'not', arg }),
  list: (...items: Expr[]): Expr => ({ k: 'list', items }),
  map: (entries: Record<string, Expr>): Expr => ({ k: 'map', entries: Object.entries(entries) }),
};

/** Calls `fn` on each direct sub-expression (not into nested plans). */
export function forEachChild(x: Expr, fn: (c: Expr) => void): void {
  switch (x.k) {
    case 'lit': case 'param': case 'slot': return;
    case 'prop': case 'hasLabels': fn(x.of); return;
    case 'call': case 'and': case 'or': case 'xor': x.args.forEach(fn); return;
    case 'list': x.items.forEach(fn); return;
    case 'map': x.entries.forEach(([, v]) => fn(v)); return;
    case 'not': case 'isNull': fn(x.arg); return;
    case 'case':
      if (x.operand) fn(x.operand);
      x.whens.forEach(([w, t]) => { fn(w); fn(t); });
      if (x.else) fn(x.else);
      return;
    case 'index': fn(x.of); fn(x.index); return;
    case 'slice': fn(x.of); if (x.from) fn(x.from); if (x.to) fn(x.to); return;
    case 'listComp': fn(x.list); if (x.where) fn(x.where); if (x.map) fn(x.map); return;
    case 'quantifier': fn(x.list); fn(x.where); return;
    case 'exists': return;
    case 'collectSub': fn(x.map); return;
  }
}

/**
 * The slots an expression reads from the row it is evaluated on, nested plans included (their `argument` leaf sees
 * the outer row). Slots that an expression writes itself (`listComp`, `quantifier`) are left out.
 */
export function slotsRead(x: Expr, out = new Set<number>(), local = new Set<number>()): Set<number> {
  if (x.k === 'slot') {
    if (!local.has(x.i)) out.add(x.i);
    return out;
  }
  if (x.k === 'listComp' || x.k === 'quantifier') {
    slotsRead(x.list, out, local);
    const inner = new Set(local).add(x.slot);
    if (x.k === 'listComp') {
      if (x.where) slotsRead(x.where, out, inner);
      if (x.map) slotsRead(x.map, out, inner);
    } else slotsRead(x.where, out, inner);
    return out;
  }
  if (x.k === 'exists' || x.k === 'collectSub') {
    for (const s of opArgumentReads(x.plan)) if (!local.has(s)) out.add(s);
    if (x.k === 'collectSub') {
      // `map` reads the nested plan's rows: only its reads of slots the plan doesn't bind come from outside.
      const bound = opBinds(x.plan);
      for (const s of slotsRead(x.map, new Set(), local)) if (!bound.has(s)) out.add(s);
    }
    return out;
  }
  forEachChild(x, (c) => slotsRead(c, out, local));
  return out;
}

// Filled in by ops.ts, which imports this module (they would otherwise import each other).
let opArgumentReads: (op: Op) => Set<number> = () => new Set();
let opBinds: (op: Op) => Set<number> = () => new Set();
export function setOpAnalysis(reads: (op: Op) => Set<number>, binds: (op: Op) => Set<number>): void {
  opArgumentReads = reads;
  opBinds = binds;
}
