/**
 * The function library: every operator and function a plan can call, by name. A language maps its syntax onto these
 * (Cypher's `+` is `add`, `toUpper()` is `toUpper`). Arguments arrive evaluated; NULL in gives NULL out unless a
 * function says otherwise.
 *
 * It sits below the plan format, the engine and the languages, and depends only on values: the plan validator checks
 * names against it, the engine calls it, and a language's binder maps its syntax onto it. Add your own functions with
 * `registerFunction` and `registerAggregate`; every language and plan sees them.
 */
import { SmaltcyError } from '../errors.js';
import { NodeRef, PathRef, RelRef, isMap, typeName, type PropertyValue, type Value } from '../values.js';
import { compare, equals, groupKey, orderCompare } from './compare.js';

/** What graph functions (`labels()`, `type()`, `degree()` …) read: a subset of a store, so any store satisfies it. */
export interface GraphReader {
  labels(node: number): readonly string[];
  nodeProperties(node: number): Readonly<Record<string, unknown>>;
  relType(rel: number): string;
  relStart(rel: number): number;
  relEnd(rel: number): number;
  relProperties(rel: number): Readonly<Record<string, unknown>>;
  degree(node: number, dir: 'out' | 'in' | 'both', types: readonly string[] | null): number;
  /** Present when the store keeps its history: what the temporal functions read. */
  readonly history?: HistoryLike;
}

/** A commit as the temporal functions see it (a store's `CommitInfo` has this shape). */
export interface CommitLike {
  readonly version: number;
  readonly time: number;
  readonly author?: string;
  readonly message?: string;
  readonly size: number;
  readonly counts: { readonly [K in 'nodesCreated' | 'nodesDeleted' | 'relationshipsCreated' | 'relationshipsDeleted' | 'propertiesSet' | 'labelsChanged']: number };
  readonly nodes: number;
  readonly relationships: number;
}

/** The part of a store's history the temporal functions read (a store's `HistoryReader` has this shape). */
export interface HistoryLike {
  readonly version: number;
  commits(from?: number, to?: number): readonly CommitLike[];
  commit(version: number): CommitLike | undefined;
  changesOf(kind: 'node' | 'relationship', id: number): readonly { readonly commit: CommitLike; readonly change: { readonly k: string; readonly key?: string; readonly old?: unknown; readonly new?: unknown; readonly label?: string } }[];
}

/** A commit as a Cypher map. Times are milliseconds since 1970 (`time`) and ISO 8601 text (`at`). */
export function commitMap(c: CommitLike): Value {
  return {
    version: c.version,
    time: c.time,
    at: new Date(c.time).toISOString(),
    author: c.author ?? null,
    message: c.message ?? null,
    changes: c.size,
    nodes: c.nodes,
    relationships: c.relationships,
    ...c.counts,
  };
}

const CHANGE_WORDS: Record<string, string> = {
  nodeCreated: 'created', relCreated: 'created', nodeDeleted: 'deleted', relDeleted: 'deleted',
  nodeProp: 'set', relProp: 'set', labelAdded: 'label added', labelRemoved: 'label removed',
};

function historyOf(v: Value, ctx: FnContext): Value {
  const h = ctx.store.history;
  if (!h) return null;
  if (!(v instanceof NodeRef) && !(v instanceof RelRef)) return typeError('history', v);
  const kind = v instanceof NodeRef ? 'node' : 'relationship';
  return h.changesOf(kind, v.id).map(({ commit, change }) => ({
    ...(commitMap(commit) as Record<string, Value>),
    change: CHANGE_WORDS[change.k] ?? change.k,
    key: change.key ?? null,
    old: (change.old ?? null) as Value,
    new: (change.new ?? null) as Value,
    label: change.label ?? null,
  }));
}

export interface FnContext {
  readonly store: GraphReader;
}

export type ScalarFn = (args: readonly Value[], ctx: FnContext) => Value;

export interface ScalarDef {
  readonly fn: ScalarFn;
  /** Minimum and maximum argument counts (max -1: any). */
  readonly arity: readonly [number, number];
  /** The same arguments always give the same result (false for `rand`). */
  readonly deterministic?: boolean;
}

export interface AggregateDef {
  init(): unknown;
  step(state: unknown, args: readonly Value[]): unknown;
  final(state: unknown): Value;
  /** `count(*)`: takes no arguments. */
  readonly arity: readonly [number, number];
}

const typeError = (fn: string, v: Value): never => {
  throw new SmaltcyError('SMALTCY_TYPE', `${fn}() can't take a ${typeName(v)}`);
};

const num = (fn: string, v: Value): number => (typeof v === 'number' ? v : typeError(fn, v));
const str = (fn: string, v: Value): string => (typeof v === 'string' ? v : typeError(fn, v));
const isInt = (v: number) => Number.isInteger(v);

/** Wraps a function so that any NULL argument gives NULL. */
const nullIn = (f: ScalarFn): ScalarFn => (args, ctx) => {
  for (const a of args) if (a === null) return null;
  return f(args, ctx);
};

const math1 = (name: string, f: (x: number) => number): ScalarDef => ({ arity: [1, 1], fn: nullIn(([x]) => f(num(name, x!))) });

function add(a: Value, b: Value): Value {
  if (Array.isArray(a)) return Array.isArray(b) ? [...a, ...b] : [...a, b];
  if (Array.isArray(b)) return [a, ...b];
  if (a === null || b === null) return null;
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (typeof a === 'string' && (typeof b === 'string' || typeof b === 'number' || typeof b === 'boolean')) return a + String(b);
  if (typeof b === 'string' && (typeof a === 'number' || typeof a === 'boolean')) return String(a) + b;
  throw new SmaltcyError('SMALTCY_TYPE', `Can't add ${typeName(a)} and ${typeName(b)}`);
}

function arith(name: string, f: (a: number, b: number) => number): ScalarDef {
  return {
    arity: [2, 2],
    fn: nullIn(([a, b]) => {
      if (typeof a !== 'number' || typeof b !== 'number') {
        throw new SmaltcyError('SMALTCY_TYPE', `Can't ${name} ${typeName(a!)} and ${typeName(b!)}`);
      }
      return f(a, b);
    }),
  };
}

function cmp(test: (c: number) => boolean): ScalarDef {
  return {
    arity: [2, 2],
    fn: ([a, b]) => {
      const c = compare(a!, b!);
      return c === null ? null : test(c);
    },
  };
}

/** Cypher's `toString`. */
export function stringOf(v: Value): string {
  if (typeof v === 'number') return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : formatFloat(v);
  return String(v);
}

function formatFloat(v: number): string {
  if (Number.isInteger(v)) return v.toFixed(1);
  return String(v);
}

function toInteger(v: Value): Value {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    return Math.trunc(Number(t));
  }
  return typeError('toInteger', v);
}

function toFloat(v: Value): Value {
  if (v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^[+-]?(Infinity|NaN)$/.test(t)) return null;
    return Number(t);
  }
  return typeError('toFloat', v);
}

function size(v: Value): Value {
  if (v === null) return null;
  if (typeof v === 'string') return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof PathRef) return v.rels.length;
  if (isMap(v)) return Object.keys(v).length;
  return typeError('size', v);
}

function properties(v: Value, ctx: FnContext): Value {
  if (v === null) return null;
  if (v instanceof NodeRef) return ctx.store.nodeProperties(v.id) as Value;
  if (v instanceof RelRef) return ctx.store.relProperties(v.id) as Value;
  if (isMap(v)) return v;
  return typeError('properties', v);
}

function substring(s: string, start: number, len?: number): string {
  if (start < 0) throw new SmaltcyError('SMALTCY_TYPE', 'substring() start must not be negative');
  return len === undefined ? s.slice(start) : s.slice(start, start + Math.max(0, len));
}

function range(start: number, end: number, step = 1): Value {
  if (!isInt(start) || !isInt(end) || !isInt(step)) throw new SmaltcyError('SMALTCY_TYPE', 'range() takes integers');
  if (step === 0) throw new SmaltcyError('SMALTCY_TYPE', 'range() step must not be 0');
  const out: number[] = [];
  if (step > 0) for (let i = start; i <= end; i += step) out.push(i);
  else for (let i = start; i >= end; i += step) out.push(i);
  if (out.length > 10_000_000) throw new SmaltcyError('SMALTCY_UNSUPPORTED', 'range() is too large');
  return out;
}

function regexOf(pattern: string): RegExp {
  let r = regexCache.get(pattern);
  if (!r) {
    try {
      // Cypher's =~ matches the whole string.
      r = new RegExp(`^(?:${pattern})$`, 'u');
    } catch (e) {
      throw new SmaltcyError('SMALTCY_TYPE', `Invalid regular expression: ${(e as Error).message}`);
    }
    if (regexCache.size > 256) regexCache.clear();
    regexCache.set(pattern, r);
  }
  return r;
}
const regexCache = new Map<string, RegExp>();

export const scalarFunctions = new Map<string, ScalarDef>(
  Object.entries<ScalarDef>({
    // Operators.
    eq: { arity: [2, 2], fn: ([a, b]) => equals(a!, b!) },
    neq: {
      arity: [2, 2],
      fn: ([a, b]) => {
        const r = equals(a!, b!);
        return r === null ? null : !r;
      },
    },
    lt: cmp((c) => c < 0),
    le: cmp((c) => c <= 0),
    gt: cmp((c) => c > 0),
    ge: cmp((c) => c >= 0),
    add: { arity: [2, 2], fn: ([a, b]) => add(a!, b!) },
    sub: arith('subtract', (a, b) => a - b),
    mul: arith('multiply', (a, b) => a * b),
    div: arith('divide', (a, b) => {
      if (isInt(a) && isInt(b)) {
        if (b === 0) throw new SmaltcyError('SMALTCY_TYPE', 'Division by zero');
        return Math.trunc(a / b);
      }
      return a / b;
    }),
    /** Division where at least one side is a float, even one with a whole value. */
    div_float: arith('divide', (a, b) => a / b),
    mod: arith('take the modulo of', (a, b) => {
      if (isInt(a) && isInt(b) && b === 0) throw new SmaltcyError('SMALTCY_TYPE', 'Division by zero');
      return a % b;
    }),
    pow: arith('raise', (a, b) => a ** b),
    neg: { arity: [1, 1], fn: nullIn(([a]) => -num('negate', a!)) },
    in: {
      arity: [2, 2],
      fn: ([x, list]) => {
        if (list === null) return null;
        if (!Array.isArray(list)) return typeError('IN', list!);
        let sawNull = false;
        for (const v of list) {
          const r = equals(x!, v);
          if (r === true) return true;
          if (r === null) sawNull = true;
        }
        return sawNull ? null : false;
      },
    },
    starts_with: { arity: [2, 2], fn: ([a, b]) => (typeof a === 'string' && typeof b === 'string' ? a.startsWith(b) : null) },
    ends_with: { arity: [2, 2], fn: ([a, b]) => (typeof a === 'string' && typeof b === 'string' ? a.endsWith(b) : null) },
    contains: { arity: [2, 2], fn: ([a, b]) => (typeof a === 'string' && typeof b === 'string' ? a.includes(b) : null) },
    regex_match: { arity: [2, 2], fn: ([a, b]) => (typeof a === 'string' && typeof b === 'string' ? regexOf(b).test(a) : null) },

    // Graph.
    id: {
      arity: [1, 1],
      fn: nullIn(([v]) => (v instanceof NodeRef || v instanceof RelRef ? v.id : typeError('id', v!))),
    },
    elementId: {
      arity: [1, 1],
      fn: nullIn(([v]) => (v instanceof NodeRef ? `n${v.id}` : v instanceof RelRef ? `r${v.id}` : typeError('elementId', v!))),
    },
    labels: {
      arity: [1, 1],
      fn: nullIn(([v], ctx) => (v instanceof NodeRef ? [...ctx.store.labels(v.id)] : typeError('labels', v!))),
    },
    type: {
      arity: [1, 1],
      fn: nullIn(([v], ctx) => (v instanceof RelRef ? ctx.store.relType(v.id) : typeError('type', v!))),
    },
    properties: { arity: [1, 1], fn: ([v], ctx) => properties(v!, ctx) },
    keys: {
      arity: [1, 1],
      fn: ([v], ctx) => {
        const p = properties(v!, ctx);
        return p === null ? null : Object.keys(p);
      },
    },
    startNode: {
      arity: [1, 1],
      fn: nullIn(([v], ctx) => (v instanceof RelRef ? new NodeRef(ctx.store.relStart(v.id)) : typeError('startNode', v!))),
    },
    endNode: {
      arity: [1, 1],
      fn: nullIn(([v], ctx) => (v instanceof RelRef ? new NodeRef(ctx.store.relEnd(v.id)) : typeError('endNode', v!))),
    },
    nodes: {
      arity: [1, 1],
      fn: nullIn(([v]) => (v instanceof PathRef ? v.nodes.map((id) => new NodeRef(id)) : typeError('nodes', v!))),
    },
    relationships: {
      arity: [1, 1],
      fn: nullIn(([v]) => (v instanceof PathRef ? v.rels.map((id) => new RelRef(id)) : typeError('relationships', v!))),
    },
    length: {
      arity: [1, 1],
      fn: nullIn(([v]) => (v instanceof PathRef ? v.rels.length : size(v!))),
    },
    degree: {
      arity: [1, 3],
      fn: nullIn(([v, dir, type], ctx) => {
        if (!(v instanceof NodeRef)) return typeError('degree', v!);
        const d = dir === undefined ? 'both' : String(dir).toLowerCase();
        if (d !== 'out' && d !== 'in' && d !== 'both') throw new SmaltcyError('SMALTCY_TYPE', "degree() direction is 'out', 'in' or 'both'");
        return ctx.store.degree(v.id, d, type === undefined ? null : [str('degree', type)]);
      }),
    },

    /** A pattern's property map given as an expression (`(n $props)`): every key equals. */
    props_match: {
      arity: [2, 2],
      fn: ([v, m], ctx) => {
        if (v === null || m === null) return null;
        if (!isMap(m)) return typeError('a property map', m!);
        const p = properties(v!, ctx) as Record<string, Value>;
        for (const [k, x] of Object.entries(m)) if (equals(p[k] ?? null, x) !== true) return false;
        return true;
      },
    },

    // History: what the graph's versions hold (null when the store keeps no history).
    /** The version the query reads: the latest, or the one `AT VERSION` / `AT TIME` names. */
    version: { arity: [0, 0], fn: (_args, ctx) => ctx.store.history?.version ?? null, deterministic: false },
    /** Every commit up to the version read, oldest first, as maps. */
    commits: { arity: [0, 0], fn: (_args, ctx) => ctx.store.history?.commits().map(commitMap) ?? null, deterministic: false },
    /** One commit, as a map; null when there's no such version. */
    commit: {
      arity: [1, 1],
      fn: nullIn(([v], ctx) => {
        const c = ctx.store.history?.commit(num('commit', v!));
        return c ? commitMap(c) : null;
      }),
      deterministic: false,
    },
    /** Every change to a node or relationship up to the version read: one map per change, with its commit. */
    history: { arity: [1, 1], fn: nullIn(([v], ctx) => historyOf(v!, ctx)), deterministic: false },

    // Lists.
    size: { arity: [1, 1], fn: ([v]) => size(v!) },
    head: { arity: [1, 1], fn: nullIn(([v]) => (Array.isArray(v) ? (v[0] ?? null) : typeError('head', v!))) },
    last: { arity: [1, 1], fn: nullIn(([v]) => (Array.isArray(v) ? (v[v.length - 1] ?? null) : typeError('last', v!))) },
    tail: { arity: [1, 1], fn: nullIn(([v]) => (Array.isArray(v) ? v.slice(1) : typeError('tail', v!))) },
    reverse: {
      arity: [1, 1],
      fn: nullIn(([v]) => (Array.isArray(v) ? [...v].reverse() : typeof v === 'string' ? [...v].reverse().join('') : typeError('reverse', v!))),
    },
    range: {
      arity: [2, 3],
      fn: nullIn(([a, b, s]) => range(num('range', a!), num('range', b!), s === undefined ? 1 : num('range', s))),
    },
    isEmpty: {
      arity: [1, 1],
      fn: nullIn(([v]) => {
        const n = size(v!);
        return n === 0;
      }),
    },
    coalesce: {
      arity: [1, -1],
      fn: (args) => {
        for (const a of args) if (a !== null) return a;
        return null;
      },
    },

    // Strings.
    toUpper: { arity: [1, 1], fn: nullIn(([v]) => str('toUpper', v!).toUpperCase()) },
    toLower: { arity: [1, 1], fn: nullIn(([v]) => str('toLower', v!).toLowerCase()) },
    trim: { arity: [1, 1], fn: nullIn(([v]) => str('trim', v!).trim()) },
    ltrim: { arity: [1, 1], fn: nullIn(([v]) => str('ltrim', v!).trimStart()) },
    rtrim: { arity: [1, 1], fn: nullIn(([v]) => str('rtrim', v!).trimEnd()) },
    substring: {
      arity: [2, 3],
      fn: nullIn(([s, a, b]) => substring(str('substring', s!), num('substring', a!), b === undefined ? undefined : num('substring', b))),
    },
    left: { arity: [2, 2], fn: nullIn(([s, n]) => str('left', s!).slice(0, num('left', n!))) },
    right: {
      arity: [2, 2],
      fn: nullIn(([s, n]) => {
        const t = str('right', s!);
        const k = num('right', n!);
        return k === 0 ? '' : t.slice(-k);
      }),
    },
    replace: { arity: [3, 3], fn: nullIn(([s, a, b]) => str('replace', s!).split(str('replace', a!)).join(str('replace', b!))) },
    split: { arity: [2, 2], fn: nullIn(([s, d]) => str('split', s!).split(str('split', d!))) },
    toInteger: { arity: [1, 1], fn: ([v]) => toInteger(v!) },
    toFloat: { arity: [1, 1], fn: ([v]) => toFloat(v!) },
    toBoolean: {
      arity: [1, 1],
      fn: nullIn(([v]) => {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'string') {
          const t = v.trim().toLowerCase();
          return t === 'true' ? true : t === 'false' ? false : null;
        }
        if (typeof v === 'number') return v !== 0;
        return typeError('toBoolean', v!);
      }),
    },
    valueType: { arity: [1, 1], fn: ([v]) => typeName(v!) },

    // Maths.
    abs: math1('abs', Math.abs),
    ceil: math1('ceil', Math.ceil),
    floor: math1('floor', Math.floor),
    round: {
      arity: [1, 2],
      fn: nullIn(([v, p]) => {
        const x = num('round', v!);
        if (p === undefined) return Math.sign(x) * Math.round(Math.abs(x));
        const f = 10 ** num('round', p);
        return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
      }),
    },
    sqrt: math1('sqrt', Math.sqrt),
    sign: math1('sign', Math.sign),
    exp: math1('exp', Math.exp),
    log: math1('log', Math.log),
    log10: math1('log10', Math.log10),
    sin: math1('sin', Math.sin),
    cos: math1('cos', Math.cos),
    tan: math1('tan', Math.tan),
    asin: math1('asin', Math.asin),
    acos: math1('acos', Math.acos),
    atan: math1('atan', Math.atan),
    atan2: { arity: [2, 2], fn: nullIn(([a, b]) => Math.atan2(num('atan2', a!), num('atan2', b!))) },
    pi: { arity: [0, 0], fn: () => Math.PI },
    e: { arity: [0, 0], fn: () => Math.E },
    rand: { arity: [0, 0], fn: () => Math.random(), deterministic: false },
    timestamp: { arity: [0, 0], fn: () => Date.now(), deterministic: false },
  }),
);

// `toString` can't be a key of the object literal above (it's Object's own).
scalarFunctions.set('toString', {
  arity: [1, 1],
  fn: nullIn(([v]) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? stringOf(v) : typeError('toString', v!))),
});

scalarFunctions.set('toString_float', {
  arity: [1, 1],
  fn: nullIn(([v]) => (typeof v === 'number' ? formatFloat(v) : typeError('toString', v!))),
});

// Aggregates.

function minMax(sign: 1 | -1): AggregateDef {
  return {
    arity: [1, 1],
    init: () => ({ v: null as Value }),
    step(s, [v]) {
      const st = s as { v: Value };
      if (v === null) return s;
      if (st.v === null || sign * orderCompare(v!, st.v) < 0) st.v = v!;
      return s;
    },
    final: (s) => (s as { v: Value }).v,
  };
}

function stdev(population: boolean): AggregateDef {
  return {
    arity: [1, 1],
    init: () => ({ n: 0, mean: 0, m2: 0 }),
    step(s, [v]) {
      if (v === null) return s;
      const st = s as { n: number; mean: number; m2: number };
      const x = num('stDev', v!);
      st.n++;
      const d = x - st.mean;
      st.mean += d / st.n;
      st.m2 += d * (x - st.mean);
      return s;
    },
    final(s) {
      const st = s as { n: number; m2: number };
      if (population) return st.n === 0 ? 0 : Math.sqrt(st.m2 / st.n);
      return st.n < 2 ? 0 : Math.sqrt(st.m2 / (st.n - 1));
    },
  };
}

/**
 * Adds a scalar function every plan and language can call (Cypher: by name, any letter case). Replaces one of the
 * same name. Names are the engine's: avoid the operators' (`eq`, `add` …) unless you mean to change them.
 */
export function registerFunction(name: string, def: ScalarDef): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) throw new SmaltcyError('SMALTCY_UNSUPPORTED', `Bad function name ${JSON.stringify(name)}`);
  scalarFunctions.set(name, def);
}

/** Adds an aggregate function, as `registerFunction` does for scalars. */
export function registerAggregate(name: string, def: AggregateDef): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) throw new SmaltcyError('SMALTCY_UNSUPPORTED', `Bad aggregate name ${JSON.stringify(name)}`);
  aggregateFunctions.set(name, def);
}

export const aggregateFunctions = new Map<string, AggregateDef>(
  Object.entries<AggregateDef>({
    count: {
      arity: [0, 1],
      init: () => ({ n: 0 }),
      step(s, args) {
        if (args.length === 0 || args[0] !== null) (s as { n: number }).n++;
        return s;
      },
      final: (s) => (s as { n: number }).n,
    },
    sum: {
      arity: [1, 1],
      init: () => ({ v: 0 }),
      step(s, [v]) {
        if (v !== null) (s as { v: number }).v += num('sum', v!);
        return s;
      },
      final: (s) => (s as { v: number }).v,
    },
    avg: {
      arity: [1, 1],
      init: () => ({ n: 0, sum: 0 }),
      step(s, [v]) {
        if (v === null) return s;
        const st = s as { n: number; sum: number };
        st.n++;
        st.sum += num('avg', v!);
        return s;
      },
      final(s) {
        const st = s as { n: number; sum: number };
        return st.n === 0 ? null : st.sum / st.n;
      },
    },
    min: minMax(1),
    max: minMax(-1),
    collect: {
      arity: [1, 1],
      init: () => [] as Value[],
      step(s, [v]) {
        if (v !== null) (s as Value[]).push(v!);
        return s;
      },
      final: (s) => s as Value[],
    },
    stDev: stdev(false),
    stDevP: stdev(true),
  }),
);

/** An aggregate that sees each distinct argument once. */
export function distinctAggregate(def: AggregateDef): AggregateDef {
  return {
    arity: def.arity,
    init: () => ({ seen: new Set<string>(), inner: def.init() }),
    step(s, args) {
      const st = s as { seen: Set<string>; inner: unknown };
      if (args[0] === null) return s;
      const k = groupKey(args[0]!);
      if (st.seen.has(k)) return s;
      st.seen.add(k);
      st.inner = def.step(st.inner, args);
      return s;
    },
    final: (s) => def.final((s as { inner: unknown }).inner),
  };
}

/** A property value from a value a plan computed; maps, nodes and paths can't be stored. */
export function toPropertyValue(v: Value, what: string): PropertyValue {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (x !== null && typeof x === 'object') throw new SmaltcyError('SMALTCY_TYPE', `${what}: a property list holds only strings, numbers and booleans`);
      return x;
    });
  }
  throw new SmaltcyError('SMALTCY_TYPE', `${what}: a property can't be a ${typeName(v)}`);
}
