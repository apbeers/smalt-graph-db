/**
 * Runs plans. Each operation compiles to a function that takes a row from the operation above it (its "outer" row:
 * empty at the top, the current row for nested plans) and pushes its result rows to a sink. A sink returns `false`
 * to stop: that's how `limit` and `exists` end a traversal early.
 *
 * Rows are arrays of slots, reused while streaming: an operation that keeps rows (`sort`, `aggregate`, `eager`)
 * copies them.
 */
import { SmaltcyError } from '../errors.js';
import { slotsRead, type Expr } from '../plan/expr.js';
import { boundSlots, type Op, type Pattern, type QueryPlan, type RemoveItem, type SetItem } from '../plan/ops.js';
import type { GraphStore, WritableStore } from '../store/interface.js';
import { NodeRef, PathRef, RelRef, isMap, typeName, type PropertyValue, type Value } from '../values.js';
import { equals, groupKey, orderCompare, rowKey } from '../functions/compare.js';
import { compileExpr, truth, type Compiled, type EvalContext, type Row } from './eval.js';
import { aggregateFunctions, distinctAggregate, toPropertyValue } from '../functions/library.js';
import { planMatch, type MatchPlan, type MatchStep } from './match-planner.js';

export type Sink = (row: Row) => boolean;
export type Runner = (outer: Row, sink: Sink) => boolean;

export interface WriteCounts {
  nodesCreated: number;
  nodesDeleted: number;
  relationshipsCreated: number;
  relationshipsDeleted: number;
  propertiesSet: number;
  labelsAdded: number;
  labelsRemoved: number;
}

export function emptyCounts(): WriteCounts {
  return { nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsAdded: 0, labelsRemoved: 0 };
}

/** One plan, compiled against a store. */
export class Executor implements EvalContext {
  readonly counts = emptyCounts();
  private readonly nested = new WeakMap<Op, Runner>();
  /** Match plans, kept for EXPLAIN. */
  readonly matchPlans = new Map<Op, MatchPlan>();
  params: Readonly<Record<string, Value>> = {};

  constructor(
    readonly store: GraphStore,
    readonly width: number,
  ) {}

  runNested(plan: Op, row: Row, emit: (r: Row) => boolean): void {
    let run = this.nested.get(plan);
    if (!run) this.nested.set(plan, (run = this.compile(plan)));
    run(row, emit);
  }

  private writer(what: string): WritableStore {
    if (!this.store.capabilities.writes) throw new SmaltcyError('SMALTCY_UNSUPPORTED', `The ${this.store.name} store is read-only: can't ${what}`);
    return this.store as WritableStore;
  }

  compile(op: Op): Runner {
    switch (op.op) {
      case 'argument': {
        const slots = op.slots;
        const width = this.width;
        return (outer, sink) => {
          const row: Row = new Array(width).fill(null);
          for (const s of slots) row[s] = outer[s] ?? null;
          return sink(row);
        };
      }
      case 'filter': {
        const input = this.compile(op.input);
        const pred = compileExpr(op.pred, this);
        return (outer, sink) => input(outer, (row) => truth(pred(row), 'WHERE') !== true || sink(row));
      }
      case 'project': {
        const input = this.compile(op.input);
        const items = op.items.map((p) => [p.slot, compileExpr(p.expr, this)] as const);
        const width = this.width;
        const vals: Value[] = new Array(items.length);
        if (op.discard) {
          return (outer, sink) =>
            input(outer, (row) => {
              const out: Row = new Array(width).fill(null);
              for (const [s, f] of items) out[s] = f(row);
              return sink(out);
            });
        }
        return (outer, sink) =>
          input(outer, (row) => {
            for (let i = 0; i < items.length; i++) vals[i] = items[i]![1](row);
            for (let i = 0; i < items.length; i++) row[items[i]![0]] = vals[i]!;
            return sink(row);
          });
      }
      case 'unwind': {
        const input = this.compile(op.input);
        const list = compileExpr(op.list, this);
        const slot = op.slot;
        return (outer, sink) =>
          input(outer, (row) => {
            const l = list(row);
            if (l === null) return true;
            if (!Array.isArray(l)) {
              row[slot] = l;
              return sink(row);
            }
            for (const v of l) {
              row[slot] = v;
              if (!sink(row)) return false;
            }
            return true;
          });
      }
      case 'limit': {
        const input = this.compile(op.input);
        const skipF = op.skip ? compileExpr(op.skip, this) : null;
        const countF = op.count ? compileExpr(op.count, this) : null;
        const intOf = (f: Compiled | null, row: Row, what: string): number => {
          if (!f) return what === 'SKIP' ? 0 : Infinity;
          const v = f(row);
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new SmaltcyError('SMALTCY_TYPE', `${what} must be a non-negative integer`);
          return v;
        };
        return (outer, sink) => {
          const skip = intOf(skipF, outer, 'SKIP');
          const count = intOf(countF, outer, 'LIMIT');
          if (count === 0) return true;
          let seen = 0;
          let stopped = false;
          input(outer, (row) => {
            if (seen++ < skip) return true;
            if (!sink(row)) return ((stopped = true), false);
            return seen - skip < count;
          });
          return !stopped;
        };
      }
      case 'distinct': {
        const input = this.compile(op.input);
        const slots = op.slots;
        const vals: Value[] = new Array(slots.length);
        return (outer, sink) => {
          const seen = new Set<string>();
          return input(outer, (row) => {
            for (let i = 0; i < slots.length; i++) vals[i] = row[slots[i]!]!;
            const k = rowKey(vals);
            if (seen.has(k)) return true;
            seen.add(k);
            return sink(row);
          });
        };
      }
      case 'sort': {
        const input = this.compile(op.input);
        const keys = op.keys.map((k) => [compileExpr(k.expr, this), k.desc ? -1 : 1] as const);
        return (outer, sink) => {
          const rows: { row: Row; keys: Value[] }[] = [];
          input(outer, (row) => {
            rows.push({ row: row.slice(), keys: keys.map(([f]) => f(row)) });
            return true;
          });
          rows.sort((a, b) => {
            for (let i = 0; i < keys.length; i++) {
              const c = orderCompare(a.keys[i]!, b.keys[i]!);
              if (c !== 0) return c * keys[i]![1];
            }
            return 0;
          });
          for (const r of rows) if (!sink(r.row)) return false;
          return true;
        };
      }
      case 'eager': {
        const input = this.compile(op.input);
        return (outer, sink) => {
          const rows: Row[] = [];
          input(outer, (row) => (rows.push(row.slice()), true));
          for (const r of rows) if (!sink(r)) return false;
          return true;
        };
      }
      case 'aggregate': return this.aggregate(op);
      case 'union': {
        const branches = op.inputs.map((i) => this.compile(i));
        const slots = op.slots;
        const all = op.all;
        const vals: Value[] = new Array(slots.length);
        return (outer, sink) => {
          const seen = new Set<string>();
          for (const b of branches) {
            const go = b(outer, (row) => {
              if (!all) {
                for (let i = 0; i < slots.length; i++) vals[i] = row[slots[i]!]!;
                const k = rowKey(vals);
                if (seen.has(k)) return true;
                seen.add(k);
              }
              return sink(row);
            });
            if (!go) return false;
          }
          return true;
        };
      }
      case 'match': {
        const input = this.compile(op.input);
        const plan = planMatch(op.pattern, op.where, boundSlots(op.input), this.store);
        this.matchPlans.set(op, plan);
        const run = this.matchRunner(op.pattern, plan);
        if (!op.optional) return (outer, sink) => input(outer, (row) => run(row, sink));
        const newSlots = plan.newSlots;
        return (outer, sink) =>
          input(outer, (row) => {
            let any = false;
            const go = run(row, (r) => ((any = true), sink(r)));
            if (!go) return false;
            if (any) return true;
            for (const s of newSlots) row[s] = null;
            return sink(row);
          });
      }
      case 'create': {
        const input = this.compile(op.input);
        const create = this.creator(op.pattern, boundSlots(op.input));
        return (outer, sink) => input(outer, (row) => (create(row), sink(row)));
      }
      case 'merge': {
        const input = this.compile(op.input);
        const boundIn = boundSlots(op.input);
        const plan = planMatch(op.pattern, undefined, boundIn, this.store);
        this.matchPlans.set(op, plan);
        const run = this.matchRunner(op.pattern, plan);
        const create = this.creator(op.pattern, boundIn);
        const onMatch = this.setter(op.onMatch);
        const onCreate = this.setter(op.onCreate);
        return (outer, sink) =>
          input(outer, (row) => {
            const found: Row[] = [];
            run(row, (r) => (found.push(r.slice()), true));
            if (found.length) {
              for (const r of found) {
                onMatch(r);
                if (!sink(r)) return false;
              }
              return true;
            }
            create(row);
            onCreate(row);
            return sink(row);
          });
      }
      case 'set': {
        const input = this.compile(op.input);
        const set = this.setter(op.items);
        return (outer, sink) => input(outer, (row) => (set(row), sink(row)));
      }
      case 'remove': {
        const input = this.compile(op.input);
        const remove = this.remover(op.items);
        return (outer, sink) => input(outer, (row) => (remove(row), sink(row)));
      }
      case 'delete': {
        const input = this.compile(op.input);
        const targets = op.targets.map((t) => compileExpr(t, this));
        const detach = op.detach;
        return (outer, sink) =>
          input(outer, (row) => {
            for (const t of targets) this.deleteValue(t(row), detach);
            return sink(row);
          });
      }
    }
  }

  private aggregate(op: Extract<Op, { op: 'aggregate' }>): Runner {
    const input = this.compile(op.input);
    const keys = op.keys.map((k) => [k.slot, compileExpr(k.expr, this)] as const);
    const aggs = op.aggs.map((a) => {
      const base = aggregateFunctions.get(a.fn);
      if (!base) throw new SmaltcyError('SMALTCY_NOT_FOUND', `Unknown aggregate ${a.fn}()`);
      const def = a.distinct ? distinctAggregate(base) : base;
      return { slot: a.slot, def, args: a.args.map((x) => compileExpr(x, this)) };
    });
    const width = this.width;
    return (outer, sink) => {
      const groups = new Map<string, { keys: Value[]; states: unknown[] }>();
      const keyVals: Value[] = new Array(keys.length);
      input(outer, (row) => {
        for (let i = 0; i < keys.length; i++) keyVals[i] = keys[i]![1](row);
        const k = rowKey(keyVals);
        let g = groups.get(k);
        if (!g) groups.set(k, (g = { keys: keyVals.slice(), states: aggs.map((a) => a.def.init()) }));
        for (let i = 0; i < aggs.length; i++) {
          const a = aggs[i]!;
          g.states[i] = a.def.step(g.states[i], a.args.map((f) => f(row)));
        }
        return true;
      });
      if (groups.size === 0 && keys.length === 0) groups.set('', { keys: [], states: aggs.map((a) => a.def.init()) });
      for (const g of groups.values()) {
        const out: Row = new Array(width).fill(null);
        keys.forEach(([s], i) => (out[s] = g.keys[i]!));
        aggs.forEach((a, i) => (out[a.slot] = a.def.final(g.states[i])));
        if (!sink(out)) return false;
      }
      return true;
    };
  }

  // Matching.

  /** A function that runs a planned match from a row, pushing every match to the sink. */
  private matchRunner(pattern: Pattern, plan: MatchPlan): (row: Row, sink: Sink) => boolean {
    type StepFn = (row: Row, used: Set<number>, sink: Sink) => boolean;
    const store = this.store;
    const nodeSlot = (i: number) => pattern.nodes[i]!.slot;
    const relSlot = (i: number) => pattern.rels[i]!.slot;
    const paths = (pattern.paths ?? []).map((p) => ({ slot: p.slot, start: nodeSlot(p.nodes[0]!), rels: p.rels.map(relSlot) }));

    let next: StepFn = (row, _used, sink) => {
      for (const p of paths) row[p.slot] = this.pathOf(row, p.start, p.rels);
      return sink(row);
    };
    for (let i = plan.steps.length - 1; i >= 0; i--) next = this.stepFn(plan.steps[i]!, pattern, next);
    const first = next;
    return (row, sink) => first(row, new Set(), sink);
  }

  private pathOf(row: Row, startSlot: number, relSlots: readonly number[]): PathRef | null {
    const start = row[startSlot];
    if (!(start instanceof NodeRef)) return null;
    const nodes = [start.id];
    const rels: number[] = [];
    let cur = start.id;
    const step = (r: number) => {
      rels.push(r);
      cur = this.store.relStart(r) === cur ? this.store.relEnd(r) : this.store.relStart(r);
      nodes.push(cur);
    };
    for (const s of relSlots) {
      const v = row[s];
      if (v instanceof RelRef) step(v.id);
      else if (Array.isArray(v)) for (const r of v) step((r as RelRef).id);
      else return null;
    }
    return new PathRef(nodes, rels);
  }

  private stepFn(step: MatchStep, pattern: Pattern, next: (row: Row, used: Set<number>, sink: Sink) => boolean): (row: Row, used: Set<number>, sink: Sink) => boolean {
    const store = this.store;
    const nodeSlot = (i: number) => pattern.nodes[i]!.slot;
    switch (step.s) {
      case 'scan': {
        const slot = nodeSlot(step.node);
        const label = step.label;
        return (row, used, sink) => {
          let go = true;
          store.scanNodes(label, (id) => {
            row[slot] = new NodeRef(id);
            return (go = next(row, used, sink));
          });
          return go;
        };
      }
      case 'seek': {
        const slot = nodeSlot(step.node);
        const { label, key } = step;
        const value = compileExpr(step.value, this);
        return (row, used, sink) => {
          const v = value(row);
          if (v === null) return true;
          if (typeof v === 'object' && !Array.isArray(v)) return true; // a node or map never equals a property
          const ids = store.nodesByProperty(label, key, v as PropertyValue);
          if (ids) {
            for (const id of ids) {
              row[slot] = new NodeRef(id);
              if (!next(row, used, sink)) return false;
            }
            return true;
          }
          let go = true;
          store.scanNodes(label, (id) => {
            const p = store.nodeProperty(id, key);
            if (p === undefined || equals(p as Value, v) !== true) return true;
            row[slot] = new NodeRef(id);
            return (go = next(row, used, sink));
          });
          return go;
        };
      }
      case 'byId': {
        const slot = nodeSlot(step.node);
        const id = compileExpr(step.id, this);
        return (row, used, sink) => {
          const v = id(row);
          if (typeof v !== 'number' || !store.hasNode(v)) return true;
          row[slot] = new NodeRef(v);
          return next(row, used, sink);
        };
      }
      case 'bound': {
        const slot = nodeSlot(step.node);
        return (row, used, sink) => {
          const v = row[slot];
          if (v === null || v === undefined) return true;
          if (!(v instanceof NodeRef)) throw new SmaltcyError('SMALTCY_TYPE', `Expected a node in the pattern, got a ${typeName(v)}`);
          if (!store.hasNode(v.id)) return true;
          return next(row, used, sink);
        };
      }
      case 'boundRel': {
        const rs = pattern.rels[step.rel]!.slot;
        const fs = nodeSlot(step.from);
        const ts = nodeSlot(step.to);
        const dir = step.dir;
        const tryEnds = (row: Row, used: Set<number>, sink: Sink, r: number, a: number, b: number): boolean | null => {
          const fv = row[fs];
          const tv = row[ts];
          if (fv instanceof NodeRef && fv.id !== a) return null;
          if (tv instanceof NodeRef && tv.id !== b) return null;
          const oldF = fv;
          const oldT = tv;
          row[fs] = new NodeRef(a);
          row[ts] = new NodeRef(b);
          used.add(r);
          const go = next(row, used, sink);
          used.delete(r);
          row[fs] = oldF ?? null;
          row[ts] = oldT ?? null;
          return go;
        };
        return (row, used, sink) => {
          const v = row[rs];
          if (!(v instanceof RelRef) || !store.hasRel(v.id) || used.has(v.id)) return true;
          const s = store.relStart(v.id);
          const e = store.relEnd(v.id);
          if (dir !== 'in' && tryEnds(row, used, sink, v.id, s, e) === false) return false;
          if (dir !== 'out' && (dir === 'in' || s !== e) && tryEnds(row, used, sink, v.id, e, s) === false) return false;
          return true;
        };
      }
      case 'expand': {
        const rel = pattern.rels[step.rel]!;
        const rs = rel.slot;
        const fs = nodeSlot(step.from);
        const ts = nodeSlot(step.to);
        const { dir, into } = step;
        const types = rel.types.length ? rel.types : null;
        return (row, used, sink) => {
          const f = row[fs];
          if (!(f instanceof NodeRef)) return true;
          let target = -1;
          if (into) {
            const t = row[ts];
            if (!(t instanceof NodeRef)) return true;
            target = t.id;
          }
          const rels: number[] = [];
          const others: number[] = [];
          store.expand(f.id, dir, types, (r, o) => {
            if (into && o !== target) return;
            rels.push(r);
            others.push(o);
          });
          for (let i = 0; i < rels.length; i++) {
            const r = rels[i]!;
            if (used.has(r)) continue;
            row[rs] = new RelRef(r);
            if (!into) row[ts] = new NodeRef(others[i]!);
            used.add(r);
            const go = next(row, used, sink);
            used.delete(r);
            if (!go) return false;
          }
          return true;
        };
      }
      case 'varExpand': {
        const rel = pattern.rels[step.rel]!;
        const rs = rel.slot;
        const fs = nodeSlot(step.from);
        const ts = nodeSlot(step.to);
        const { dir, into, min, max } = step;
        const types = rel.types.length ? rel.types : null;
        const relProps = step.relProps.map(([k, x]) => [k, compileExpr(x, this)] as const);
        // The relationship list in the slot reads from `from` to `to`; when the planner expands from the pattern's
        // `to` end, reverse it so it reads in the pattern's direction.
        const reverse = step.from !== pattern.nodes.findIndex((n) => n.slot === pattern.nodes[rel.from]!.slot);
        return (row, used, sink) => {
          const f = row[fs];
          if (!(f instanceof NodeRef)) return true;
          let target = -1;
          if (into) {
            const t = row[ts];
            if (!(t instanceof NodeRef)) return true;
            target = t.id;
          }
          const want = relProps.map(([k, x]) => [k, x(row)] as const);
          const stack: number[] = [];
          const onPath = new Set<number>();
          const emit = (node: number): boolean => {
            if (into && node !== target) return true;
            const list = stack.map((r) => new RelRef(r));
            if (reverse) list.reverse();
            row[rs] = list;
            if (!into) row[ts] = new NodeRef(node);
            return next(row, used, sink);
          };
          const walk = (node: number, depth: number): boolean => {
            if (depth >= min && !emit(node)) return false;
            if (depth >= max) return true;
            const rels: number[] = [];
            const others: number[] = [];
            store.expand(node, dir, types, (r, o) => {
              rels.push(r);
              others.push(o);
            });
            for (let i = 0; i < rels.length; i++) {
              const r = rels[i]!;
              if (onPath.has(r) || used.has(r)) continue;
              if (want.length && !want.every(([k, v]) => equals((store.relProperty(r, k) ?? null) as Value, v) === true)) continue;
              stack.push(r);
              onPath.add(r);
              const go = walk(others[i]!, depth + 1);
              stack.pop();
              onPath.delete(r);
              if (!go) return false;
            }
            return true;
          };
          return walk(f.id, 0);
        };
      }
      case 'shortest': {
        const rel = pattern.rels[step.rel]!;
        const rs = rel.slot;
        const fs = nodeSlot(step.from);
        const ts = nodeSlot(step.to);
        const { dir, all, min, max } = step;
        const types = rel.types.length ? rel.types : null;
        const relProps = step.relProps.map(([k, x]) => [k, compileExpr(x, this)] as const);
        return (row, used, sink) => {
          const f = row[fs];
          const t = row[ts];
          if (!(f instanceof NodeRef) || !(t instanceof NodeRef)) return true;
          const want = relProps.map(([k, x]) => [k, x(row)] as const);
          for (const path of shortestPaths(store, f.id, t.id, dir, types, want, min, max, all)) {
            row[rs] = path.map((r) => new RelRef(r));
            if (!next(row, used, sink)) return false;
          }
          return true;
        };
      }
      case 'filter': {
        const pred = compileExpr(step.pred, this);
        return (row, used, sink) => truth(pred(row), 'WHERE') !== true || next(row, used, sink);
      }
    }
  }

  // Writes.

  private propsOf(x: Expr | undefined, what: string): ((row: Row) => Record<string, PropertyValue>) | null {
    if (!x) return null;
    const f = compileExpr(x, this);
    return (row) => {
      const m = f(row);
      if (m === null) return {};
      const src = m instanceof NodeRef ? this.store.nodeProperties(m.id) : m instanceof RelRef ? this.store.relProperties(m.id) : m;
      if (!isMap(src)) throw new SmaltcyError('SMALTCY_TYPE', `${what}: properties must be a map, not ${typeName(m)}`);
      const out: Record<string, PropertyValue> = {};
      for (const [k, v] of Object.entries(src)) if (v !== null) out[k] = toPropertyValue(v as Value, what);
      return out;
    };
  }

  private creator(pattern: Pattern, boundIn: ReadonlySet<number>): (row: Row) => void {
    const nodes = pattern.nodes.map((n) => ({ slot: n.slot, labels: n.labels, props: this.propsOf(n.props, 'CREATE'), bound: boundIn.has(n.slot) }));
    const rels = pattern.rels.map((r) => {
      if (r.types.length !== 1) throw new SmaltcyError('SMALTCY_SEMANTIC', 'A relationship to create needs exactly one type');
      if (r.dir === 'both') throw new SmaltcyError('SMALTCY_SEMANTIC', 'A relationship to create needs a direction');
      if (r.min !== undefined) throw new SmaltcyError('SMALTCY_SEMANTIC', "Can't create a variable-length relationship");
      return { slot: r.slot, type: r.types[0]!, from: pattern.nodes[r.from]!.slot, to: pattern.nodes[r.to]!.slot, out: r.dir === 'out', props: this.propsOf(r.props, 'CREATE') };
    });
    const paths = (pattern.paths ?? []).map((p) => ({ slot: p.slot, start: pattern.nodes[p.nodes[0]!]!.slot, rels: p.rels.map((i) => pattern.rels[i]!.slot) }));
    return (row) => {
      const w = this.writer('create');
      const done = new Set<number>();
      for (const n of nodes) {
        if (n.bound) {
          const v = row[n.slot];
          if (!(v instanceof NodeRef)) throw new SmaltcyError('SMALTCY_TYPE', `Can't create a relationship to ${v === null ? 'NULL' : `a ${typeName(v!)}`}`);
          continue;
        }
        if (done.has(n.slot)) continue;
        done.add(n.slot);
        const props = n.props ? n.props(row) : {};
        row[n.slot] = new NodeRef(w.createNode(n.labels, props));
        this.counts.nodesCreated++;
        this.counts.labelsAdded += n.labels.length;
        this.counts.propertiesSet += Object.keys(props).length;
      }
      for (const r of rels) {
        const a = (row[r.from] as NodeRef).id;
        const b = (row[r.to] as NodeRef).id;
        const props = r.props ? r.props(row) : {};
        row[r.slot] = new RelRef(r.out ? w.createRel(r.type, a, b, props) : w.createRel(r.type, b, a, props));
        this.counts.relationshipsCreated++;
        this.counts.propertiesSet += Object.keys(props).length;
      }
      for (const p of paths) row[p.slot] = this.pathOf(row, p.start, p.rels);
    };
  }

  private setter(items: readonly SetItem[]): (row: Row) => void {
    const fns = items.map((it) => {
      const target = compileExpr(it.target, this);
      switch (it.kind) {
        case 'prop': {
          const value = compileExpr(it.value, this);
          const key = it.key;
          return (row: Row) => {
            const t = target(row);
            if (t === null) return;
            const v = value(row);
            this.setProp(t, key, v === null ? undefined : toPropertyValue(v, 'SET'));
          };
        }
        case 'props': {
          const value = this.propsOf(it.value, 'SET')!;
          const rawValue = compileExpr(it.value, this);
          const merge = it.merge;
          return (row: Row) => {
            const t = target(row);
            if (t === null) return;
            const props = value(row);
            if (!merge) {
              const old = t instanceof NodeRef ? this.store.nodeProperties(t.id) : t instanceof RelRef ? this.store.relProperties(t.id) : {};
              for (const k of Object.keys(old)) if (!(k in props)) this.setProp(t, k, undefined);
            }
            // With +=, a NULL in the map removes the key.
            const raw = rawValue(row);
            if (merge && isMap(raw)) for (const [k, v] of Object.entries(raw)) if (v === null) this.setProp(t, k, undefined);
            for (const [k, v] of Object.entries(props)) this.setProp(t, k, v);
          };
        }
        case 'labels': {
          const labels = it.labels;
          return (row: Row) => {
            const t = target(row);
            if (t === null) return;
            if (!(t instanceof NodeRef)) throw new SmaltcyError('SMALTCY_TYPE', `Can't set labels on a ${typeName(t)}`);
            const w = this.writer('set labels');
            for (const l of labels) {
              if (!this.store.hasLabel(t.id, l)) this.counts.labelsAdded++;
              w.addLabel(t.id, l);
            }
          };
        }
      }
    });
    return (row) => {
      for (const f of fns) f(row);
    };
  }

  private remover(items: readonly RemoveItem[]): (row: Row) => void {
    const fns = items.map((it) => {
      const target = compileExpr(it.target, this);
      if (it.kind === 'prop') {
        const key = it.key;
        return (row: Row) => {
          const t = target(row);
          if (t !== null) this.setProp(t, key, undefined);
        };
      }
      const labels = it.labels;
      return (row: Row) => {
        const t = target(row);
        if (t === null) return;
        if (!(t instanceof NodeRef)) throw new SmaltcyError('SMALTCY_TYPE', `Can't remove labels from a ${typeName(t)}`);
        const w = this.writer('remove labels');
        for (const l of labels) {
          if (this.store.hasLabel(t.id, l)) this.counts.labelsRemoved++;
          w.removeLabel(t.id, l);
        }
      };
    });
    return (row) => {
      for (const f of fns) f(row);
    };
  }

  private setProp(t: Value, key: string, v: PropertyValue | undefined): void {
    const w = this.writer('set properties');
    if (t instanceof NodeRef) {
      if (!this.store.hasNode(t.id)) return;
      w.setNodeProperty(t.id, key, v);
    } else if (t instanceof RelRef) {
      if (!this.store.hasRel(t.id)) return;
      w.setRelProperty(t.id, key, v);
    } else throw new SmaltcyError('SMALTCY_TYPE', `Can't set a property on a ${typeName(t)}`);
    this.counts.propertiesSet++;
  }

  private deleteValue(v: Value, detach: boolean): void {
    if (v === null) return;
    const w = this.writer('delete');
    if (v instanceof RelRef) {
      if (this.store.hasRel(v.id)) {
        w.deleteRel(v.id);
        this.counts.relationshipsDeleted++;
      }
    } else if (v instanceof NodeRef) {
      if (!this.store.hasNode(v.id)) return;
      if (detach) {
        const rels: number[] = [];
        this.store.expand(v.id, 'both', null, (r) => void rels.push(r));
        for (const r of rels) this.deleteValue(new RelRef(r), false);
      }
      w.deleteNode(v.id);
      this.counts.nodesDeleted++;
    } else if (v instanceof PathRef) {
      for (const r of v.rels) this.deleteValue(new RelRef(r), false);
      for (const n of v.nodes) this.deleteValue(new NodeRef(n), detach);
    } else if (Array.isArray(v)) {
      for (const x of v) this.deleteValue(x, detach);
    } else throw new SmaltcyError('SMALTCY_TYPE', `Can't delete a ${typeName(v)}`);
  }
}

/** Shortest paths from `from` to `to` by breadth-first search: one, or all of the shortest length. */
function shortestPaths(
  store: GraphStore,
  from: number,
  to: number,
  dir: 'out' | 'in' | 'both',
  types: readonly string[] | null,
  want: readonly (readonly [string, Value])[],
  min: number,
  max: number,
  all: boolean,
): number[][] {
  if (from === to) return min === 0 ? [[]] : [];
  // For each node reached: the (relationship, previous node) pairs that reach it at its depth.
  const preds = new Map<number, [number, number][]>([[from, []]]);
  let frontier = [from];
  let depth = 0;
  let found = false;
  while (frontier.length && depth < max && !found) {
    depth++;
    const next: number[] = [];
    const levelPreds = new Map<number, [number, number][]>();
    for (const node of frontier) {
      store.expand(node, dir, types, (r, o) => {
        if (preds.has(o)) return;
        if (want.length && !want.every(([k, v]) => equals((store.relProperty(r, k) ?? null) as Value, v) === true)) return;
        let list = levelPreds.get(o);
        if (!list) {
          levelPreds.set(o, (list = []));
          next.push(o);
        }
        if (all || list.length === 0) list.push([r, node]);
        if (o === to) found = true;
      });
    }
    for (const [n, l] of levelPreds) preds.set(n, l);
    frontier = next;
  }
  if (!found || depth < min) return [];
  const out: number[][] = [];
  const back = (node: number, acc: number[]) => {
    if (node === from) {
      out.push([...acc].reverse());
      return !all && out.length > 0 ? false : true;
    }
    for (const [r, prev] of preds.get(node)!) {
      acc.push(r);
      const go = back(prev, acc);
      acc.pop();
      if (go === false) return false;
    }
    return true;
  };
  back(to, []);
  return out;
}

/** Turns an engine value into a result value, with the data of nodes, relationships and paths. */
export function toResult(v: Value, store: GraphStore): import('../values.js').ResultValue {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof NodeRef) {
    if (!store.hasNode(v.id)) return { kind: 'node', id: v.id, labels: [], properties: {} };
    return { kind: 'node', id: v.id, labels: store.labels(v.id), properties: store.nodeProperties(v.id) };
  }
  if (v instanceof RelRef) {
    if (!store.hasRel(v.id)) return { kind: 'relationship', id: v.id, type: '', start: -1, end: -1, properties: {} };
    return { kind: 'relationship', id: v.id, type: store.relType(v.id), start: store.relStart(v.id), end: store.relEnd(v.id), properties: store.relProperties(v.id) };
  }
  if (v instanceof PathRef) {
    return {
      kind: 'path',
      nodes: v.nodes.map((n) => toResult(new NodeRef(n), store) as import('../values.js').Node),
      relationships: v.rels.map((r) => toResult(new RelRef(r), store) as import('../values.js').Relationship),
    };
  }
  if (Array.isArray(v)) return v.map((x) => toResult(x, store));
  const out: Record<string, import('../values.js').ResultValue> = {};
  for (const [k, x] of Object.entries(v)) out[k] = toResult(x as Value, store);
  return out;
}

/** Runs a query plan and collects its rows. */
export function runQuery(plan: QueryPlan, store: GraphStore, params: Readonly<Record<string, Value>>): { rows: Value[][]; counts: WriteCounts; executor: Executor } {
  const ex = new Executor(store, plan.slots);
  ex.params = params;
  const run = ex.compile(plan.root);
  const cols = plan.columns.map((c) => c.slot);
  const rows: Value[][] = [];
  run([], (row) => {
    rows.push(cols.map((s) => row[s] ?? null));
    return true;
  });
  return { rows, counts: ex.counts, executor: ex };
}

/** For EXPLAIN: what the plan's slots read, by name. */
const INFIX: Record<string, string> = {
  eq: '=', neq: '<>', lt: '<', le: '<=', gt: '>', ge: '>=', add: '+', sub: '-', mul: '*', div: '/', mod: '%', pow: '^',
  in: 'IN', starts_with: 'STARTS WITH', ends_with: 'ENDS WITH', contains: 'CONTAINS', regex_match: '=~',
};

export function describeExpr(x: Expr, names: readonly string[] | undefined): string {
  const n = (i: number) => {
    const name = names?.[i] ?? `$${i}`;
    return name.startsWith(' ') ? `_${i}` : name;
  };
  if (x.k === 'call' && x.args.length === 2 && INFIX[x.fn]) return `${describeExpr(x.args[0]!, names)} ${INFIX[x.fn]} ${describeExpr(x.args[1]!, names)}`;
  switch (x.k) {
    case 'lit': return JSON.stringify(x.v);
    case 'param': return `$${x.name}`;
    case 'slot': return n(x.i);
    case 'prop': return `${describeExpr(x.of, names)}.${x.key}`;
    case 'call': return `${x.fn}(${x.args.map((a) => describeExpr(a, names)).join(', ')})`;
    case 'list': return `[${x.items.map((a) => describeExpr(a, names)).join(', ')}]`;
    case 'map': return `{${x.entries.map(([k, v]) => `${k}: ${describeExpr(v, names)}`).join(', ')}}`;
    case 'and': case 'or': case 'xor': return `(${x.args.map((a) => describeExpr(a, names)).join(` ${x.k.toUpperCase()} `)})`;
    case 'not': return `NOT ${describeExpr(x.arg, names)}`;
    case 'isNull': return `${describeExpr(x.arg, names)} IS ${x.negated ? 'NOT ' : ''}NULL`;
    case 'hasLabels': return `${describeExpr(x.of, names)}:${x.labels.join(':')}`;
    case 'exists': return 'EXISTS {…}';
    default: return x.k;
  }
}

export { slotsRead, groupKey };
