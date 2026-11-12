/**
 * The binder: Cypher's syntax tree to a graph plan. It resolves variables to slots, checks scopes, maps operators and
 * functions onto the engine's library, and lays clauses out as plan operations. It doesn't choose how to run a
 * pattern: that's the engine's planner, from the store's statistics.
 */
import { SmaltcyError } from '../errors.js';
import { aggregateFunctions, scalarFunctions } from '../functions/library.js';
import type { Expr as PExpr } from '../plan/expr.js';
import { PLAN_VERSION, type AggCall, type GraphPlan, type Op, type Pattern, type PatternNode, type PatternPath, type PatternRel, type Projection as PProjection, type RemoveItem as PRemoveItem, type SetItem as PSetItem, type SortKey } from '../plan/ops.js';
import type { Clause, Expr, PatternPart, Projection, ReturnItem, SetItem, Statement } from './ast.js';


type Kind = 'node' | 'rel' | 'rels' | 'path' | 'value';

interface Var {
  readonly slot: number;
  readonly kind: Kind;
}

/** Variables in scope, by name. */
type Scope = Map<string, Var>;

const semantic = (msg: string): never => {
  throw new SmaltcyError('SMALTCY_SEMANTIC', msg);
};

/**
 * Cypher's function names are case-insensitive. Looked up in the library each time (with a cache that's rebuilt when
 * the library grows), so functions registered after this module loads are found too.
 */
function lookup(map: ReadonlyMap<string, unknown>, cache: { size: number; names: Map<string, string> }, name: string): string | undefined {
  if (cache.size !== map.size) {
    cache.names = new Map([...map.keys()].map((k) => [k.toLowerCase(), k]));
    cache.size = map.size;
  }
  return cache.names.get(name.toLowerCase());
}
const fnCache = { size: -1, names: new Map<string, string>() };
const aggCache = { size: -1, names: new Map<string, string>() };
const scalarName = (name: string) => lookup(scalarFunctions, fnCache, name);
const aggregateName = (name: string) => lookup(aggregateFunctions, aggCache, name);
const isAggregateName = (name: string) => aggregateName(name) !== undefined;

const COMPARE: Record<string, string> = { '=': 'eq', '<>': 'neq', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };

export function bind(st: Statement): GraphPlan {
  if (st.t !== 'query') return { kind: st.t, planVersion: PLAN_VERSION, label: st.label, key: st.key };
  const plan = new Binder().query(st.parts, st.unionAll);
  if (!st.asOf || plan.kind !== 'query') return plan;
  const x = 'version' in st.asOf ? st.asOf.version : st.asOf.time;
  if (x.t !== 'lit' && x.t !== 'param') semantic(`AT ${'version' in st.asOf ? 'VERSION' : 'TIME'} takes a value or a parameter, not an expression`);
  const e: PExpr = x.t === 'lit' ? { k: 'lit', v: x.v } : { k: 'param', name: (x as Extract<typeof x, { t: 'param' }>).name };
  if (writesTo(plan.root)) semantic("AT VERSION and AT TIME read the past: a query that writes can't use them");
  return { ...plan, asOf: 'version' in st.asOf ? { version: e } : { time: e } };
}

function writesTo(op: Op): boolean {
  if (op.op === 'create' || op.op === 'merge' || op.op === 'set' || op.op === 'remove' || op.op === 'delete') return true;
  if (op.op === 'argument') return false;
  if (op.op === 'union') return op.inputs.some(writesTo);
  return writesTo(op.input);
}

class Binder {
  private readonly names: string[] = [];
  private anon = 0;

  private slot(name: string): number {
    this.names.push(name);
    return this.names.length - 1;
  }

  query(parts: readonly (readonly Clause[])[], unionAll: readonly boolean[]): GraphPlan {
    if (parts.length === 1) {
      const { root, columns } = this.single(parts[0]!);
      return { kind: 'query', planVersion: PLAN_VERSION, slots: this.names.length, slotNames: this.names, root, columns };
    }
    if (new Set(unionAll).size > 1) semantic("Can't mix UNION and UNION ALL");
    const branches = parts.map((p) => this.single(p));
    const names = branches[0]!.columns.map((c) => c.name);
    for (const b of branches) {
      if (b.columns.length !== names.length || b.columns.some((c, i) => c.name !== names[i])) semantic('Every part of a UNION must return the same columns');
    }
    const out = names.map((n) => this.slot(n));
    const inputs = branches.map((b): Op => ({ op: 'project', input: b.root, items: b.columns.map((c, i) => ({ slot: out[i]!, expr: { k: 'slot', i: c.slot } })), discard: true }));
    const root: Op = { op: 'union', inputs, slots: out, all: unionAll[0]! };
    return { kind: 'query', planVersion: PLAN_VERSION, slots: this.names.length, slotNames: this.names, root, columns: names.map((name, i) => ({ name, slot: out[i]! })) };
  }

  private single(clauses: readonly Clause[]): { root: Op; columns: { name: string; slot: number }[] } {
    let scope: Scope = new Map();
    let cur: Op = { op: 'argument', slots: [] };
    let columns: { name: string; slot: number }[] = [];
    let lastRead = false;
    let lastWrite = false;
    clauses.forEach((c, idx) => {
      const isLast = idx === clauses.length - 1;
      const isWrite = c.t === 'create' || c.t === 'merge' || c.t === 'set' || c.t === 'remove' || c.t === 'delete';
      const isRead = c.t === 'match' || c.t === 'merge';
      // Clauses see each other's effects in order: a write after a read waits for the read to finish, and the other
      // way round.
      if ((isWrite && lastRead) || (isRead && lastWrite)) {
        if (cur.op !== 'eager' && cur.op !== 'argument') cur = { op: 'eager', input: cur };
        lastRead = lastWrite = false;
      }
      if (isRead) lastRead = true;
      if (isWrite) lastWrite = true;
      if (c.t === 'return' && !isLast) semantic('RETURN must be the last clause');
      switch (c.t) {
        case 'match': {
          const { pattern, scope: next } = this.pattern(c.pattern, scope, 'match');
          const where = c.where ? this.expr(c.where, next) : undefined;
          cur = { op: 'match', input: cur, pattern, where, optional: c.optional };
          scope = next;
          break;
        }
        case 'unwind': {
          const list = this.expr(c.list, scope);
          if (scope.has(c.name)) semantic(`Variable ${c.name} is already defined`);
          const slot = this.slot(c.name);
          cur = { op: 'unwind', input: cur, list, slot };
          scope = new Map(scope).set(c.name, { slot, kind: 'value' });
          break;
        }
        case 'with': {
          const r = this.projection(c.proj, scope, cur, false);
          cur = r.op;
          scope = r.scope;
          if (c.where) cur = { op: 'filter', input: cur, pred: this.expr(c.where, scope) };
          break;
        }
        case 'return': {
          const r = this.projection(c.proj, scope, cur, true);
          cur = r.op;
          columns = r.columns;
          break;
        }
        case 'create': {
          const { pattern, scope: next } = this.pattern(c.pattern, scope, 'create');
          cur = { op: 'create', input: cur, pattern };
          scope = next;
          break;
        }
        case 'merge': {
          const { pattern, scope: next } = this.pattern([c.part], scope, 'merge');
          cur = { op: 'merge', input: cur, pattern, onCreate: this.setItems(c.onCreate, next), onMatch: this.setItems(c.onMatch, next) };
          scope = next;
          break;
        }
        case 'set':
          cur = { op: 'set', input: cur, items: this.setItems(c.items, scope) };
          break;
        case 'remove': {
          const items: PRemoveItem[] = c.items.map((it) =>
            it.t === 'prop' ? { kind: 'prop', target: this.expr(it.target, scope), key: it.key } : { kind: 'labels', target: this.varExpr(it.name, scope), labels: it.labels },
          );
          cur = { op: 'remove', input: cur, items };
          break;
        }
        case 'delete':
          cur = { op: 'delete', input: cur, targets: c.exprs.map((x) => this.expr(x, scope)), detach: c.detach };
          break;
      }
      if (isLast && c.t === 'with') semantic('A query must end with RETURN or a write clause, not WITH');
      if (isLast && (c.t === 'match' || c.t === 'unwind')) semantic(`A query can't end with ${c.t.toUpperCase()}: add RETURN`);
    });
    return { root: cur, columns };
  }

  private setItems(items: readonly SetItem[], scope: Scope): PSetItem[] {
    return items.map((it): PSetItem => {
      switch (it.t) {
        case 'prop': return { kind: 'prop', target: this.expr(it.target, scope), key: it.key, value: this.expr(it.value, scope) };
        case 'props': return { kind: 'props', target: this.varExpr(it.name, scope), value: this.expr(it.value, scope), merge: it.merge };
        case 'labels': return { kind: 'labels', target: this.varExpr(it.name, scope), labels: it.labels };
      }
    });
  }

  private varExpr(name: string, scope: Scope): PExpr {
    const v = scope.get(name);
    if (!v) return semantic(`Variable ${name} is not defined`);
    return { k: 'slot', i: v.slot };
  }

  // Patterns.

  private pattern(parts: readonly PatternPart[], scope: Scope, mode: 'match' | 'create' | 'merge' | 'exists'): { pattern: Pattern; scope: Scope } {
    const next = new Map(scope);
    const nodes: PatternNode[] = [];
    const rels: PatternRel[] = [];
    const paths: PatternPath[] = [];
    // Variables introduced in this pattern, so a second mention is the same element.
    const local = new Map<string, Var>();
    for (const part of parts) {
      const nodeIdx: number[] = [];
      const relIdx: number[] = [];
      part.nodes.forEach((np) => {
        let slot: number;
        if (np.name !== undefined) {
          const v = next.get(np.name);
          if (v) {
            // A value (from WITH or UNWIND) may hold a node: the match checks it when it runs.
            if (v.kind !== 'node' && v.kind !== 'value') semantic(`${np.name} is a ${v.kind === 'rels' ? 'relationship list' : v.kind}, not a node`);
            const outer = !local.has(np.name);
            if ((mode === 'create' || mode === 'merge') && outer && (np.labels.length || np.props)) {
              semantic(`Can't add labels or properties to ${np.name}, which is already bound, in ${mode.toUpperCase()}`);
            }
            if (mode === 'create' && !outer) {
              // `CREATE (a)-[:R]->(a)` names the node it just created again: fine.
            }
            slot = v.slot;
          } else {
            slot = this.slot(np.name);
            const nv: Var = { slot, kind: 'node' };
            next.set(np.name, nv);
            local.set(np.name, nv);
          }
        } else slot = this.slot(`  node${this.anon++}`);
        nodeIdx.push(nodes.length);
        nodes.push({ slot, labels: np.labels, props: np.props ? this.propsExpr(np.props, next) : undefined });
      });
      part.rels.forEach((rp, i) => {
        let slot: number;
        const kind: Kind = rp.hops || part.shortest ? 'rels' : 'rel';
        if (rp.name !== undefined) {
          const v = next.get(rp.name);
          if (v) {
            if (mode !== 'match' && mode !== 'exists') semantic(`Relationship ${rp.name} is already bound`);
            if (local.has(rp.name)) semantic(`Relationship ${rp.name} can't appear twice in a pattern`);
            if (v.kind !== 'rel' && v.kind !== 'value') semantic(`${rp.name} is not a relationship`);
            slot = v.slot;
          } else {
            slot = this.slot(rp.name);
            const nv: Var = { slot, kind };
            next.set(rp.name, nv);
            local.set(rp.name, nv);
          }
        } else slot = this.slot(`  rel${this.anon++}`);
        if (mode === 'create' || mode === 'merge') {
          if (rp.types.length !== 1) semantic(`A relationship in ${mode.toUpperCase()} needs exactly one type`);
          if (rp.dir === 'both' && mode === 'create') semantic('A relationship in CREATE needs a direction');
          if (rp.hops) semantic(`Variable-length relationships can't be used in ${mode.toUpperCase()}`);
        }
        const hops = rp.hops ?? (part.shortest ? { min: 1 } : undefined);
        relIdx.push(rels.length);
        rels.push({
          slot,
          from: nodeIdx[i]!,
          to: nodeIdx[i + 1]!,
          // MERGE without a direction matches either way and creates left to right.
          dir: mode === 'merge' && rp.dir === 'both' ? 'both' : rp.dir,
          types: rp.types,
          props: rp.props ? this.propsExpr(rp.props, next) : undefined,
          ...(hops ? { min: hops.min ?? 1, ...(hops.max !== undefined ? { max: hops.max } : {}) } : {}),
          ...(part.shortest ? { shortest: part.shortest } : {}),
        });
      });
      if (part.path !== undefined) {
        if (next.has(part.path)) semantic(`Variable ${part.path} is already defined`);
        const slot = this.slot(part.path);
        next.set(part.path, { slot, kind: 'path' });
        paths.push({ slot, nodes: nodeIdx, rels: relIdx });
      }
    }
    if (mode === 'merge') {
      // MERGE creates in the pattern's direction; with none, left to right.
      rels.forEach((r, i) => {
        if (r.dir === 'both') rels[i] = { ...r, dir: 'out' };
      });
    }
    return { pattern: { nodes, rels, ...(paths.length ? { paths } : {}) }, scope: next };
  }

  private propsExpr(x: Expr, scope: Scope): PExpr {
    if (x.t !== 'map' && x.t !== 'param') semantic('Pattern properties must be a map or a parameter');
    return this.expr(x, scope);
  }

  // Projections: WITH and RETURN.

  private projection(p: Projection, scope: Scope, input: Op, isReturn: boolean): { op: Op; scope: Scope; columns: { name: string; slot: number }[] } {
    let items: ReturnItem[] = [...p.items];
    if (p.star) {
      const named = [...scope.keys()].filter((n) => !n.startsWith(' ')).sort();
      if (named.length === 0 && items.length === 0) semantic('RETURN * needs at least one variable in scope');
      items = [...named.map((name): ReturnItem => ({ expr: { t: 'var', name, start: 0, end: 0 }, text: name })), ...items];
    }
    const outNames = items.map((it) => it.alias ?? (it.expr.t === 'var' ? it.expr.name : it.text));
    if (!isReturn) {
      for (const [i, it] of items.entries()) {
        if (!it.alias && it.expr.t !== 'var') semantic(`WITH ${it.text}: an expression in WITH needs an alias (AS name)`);
        if (outNames.indexOf(outNames[i]!) !== i) semantic(`WITH has the name ${outNames[i]} twice`);
      }
    } else {
      for (const [i, n] of outNames.entries()) if (outNames.indexOf(n) !== i) semantic(`RETURN has the column ${n} twice`);
    }
    const aggregating = items.some((it) => hasAggregate(it.expr));
    const newScope: Scope = new Map();
    const outSlots: number[] = [];
    let op = input;
    const kindOf = (x: Expr): Kind => (x.t === 'var' ? (scope.get(x.name)?.kind ?? 'value') : 'value');

    if (aggregating) {
      const keys: PProjection[] = [];
      const aggs: AggCall[] = [];
      const post: PProjection[] = [];
      for (const [i, it] of items.entries()) {
        if (!hasAggregate(it.expr)) {
          const slot = this.slot(outNames[i]!);
          keys.push({ slot, expr: this.expr(it.expr, scope) });
          outSlots.push(slot);
          newScope.set(outNames[i]!, { slot, kind: kindOf(it.expr) });
          continue;
        }
        // Each aggregate call gets a slot; the item's expression reads them.
        const rewritten = this.extractAggregates(it.expr, scope, aggs);
        if (rewritten.k === 'slot') {
          this.names[rewritten.i] = outNames[i]!;
          outSlots.push(rewritten.i);
          newScope.set(outNames[i]!, { slot: rewritten.i, kind: 'value' });
        } else {
          const slot = this.slot(outNames[i]!);
          post.push({ slot, expr: rewritten });
          outSlots.push(slot);
          newScope.set(outNames[i]!, { slot, kind: 'value' });
        }
      }
      op = { op: 'aggregate', input: op, keys, aggs };
      if (post.length) {
        // Post-aggregation expressions may read the grouping keys by name.
        op = { op: 'project', input: op, items: post, discard: false };
      }
      if (p.distinct) op = { op: 'distinct', input: op, slots: outSlots };
      op = this.orderSkipLimit(p, op, newScope, items, outSlots, null);
    } else {
      const projected: PProjection[] = [];
      for (const [i, it] of items.entries()) {
        const v = it.expr.t === 'var' ? scope.get(it.expr.name) : undefined;
        if (it.expr.t === 'var' && !v) semantic(`Variable ${it.expr.name} is not defined`);
        // `WITH a` and `RETURN a` keep a's slot.
        if (v && outNames[i] === (it.expr as { name: string }).name) {
          outSlots.push(v.slot);
          newScope.set(outNames[i]!, v);
          continue;
        }
        const slot = this.slot(outNames[i]!);
        projected.push({ slot, expr: this.expr(it.expr, scope) });
        outSlots.push(slot);
        newScope.set(outNames[i]!, { slot, kind: v?.kind ?? kindOf(it.expr) });
      }
      if (projected.length) op = { op: 'project', input: op, items: projected, discard: false };
      if (p.distinct) {
        op = { op: 'distinct', input: op, slots: outSlots };
        op = this.orderSkipLimit(p, op, newScope, items, outSlots, null);
      } else {
        // Without DISTINCT, ORDER BY may also read the variables from before the projection.
        const both = new Map(scope);
        for (const [k, v] of newScope) both.set(k, v);
        op = this.orderSkipLimit(p, op, both, items, outSlots, scope);
      }
    }
    if (!isReturn) {
      // WITH starts a new scope: only its items go on.
      op = { op: 'project', input: op, items: outSlots.map((s) => ({ slot: s, expr: { k: 'slot', i: s } })), discard: true };
    }
    return { op, scope: newScope, columns: outNames.map((name, i) => ({ name, slot: outSlots[i]! })) };
  }

  private orderSkipLimit(p: Projection, input: Op, scope: Scope, items: readonly ReturnItem[], outSlots: readonly number[], _before: Scope | null): Op {
    let op = input;
    if (p.order.length) {
      const keys: SortKey[] = p.order.map((o) => {
        // An ORDER BY expression written like a projected item reads that item.
        const same = items.findIndex((it) => sameExpr(it.expr, o.expr));
        if (same >= 0) return { expr: { k: 'slot', i: outSlots[same]! }, desc: o.desc };
        if (hasAggregate(o.expr)) semantic('ORDER BY can only use an aggregate that is also projected');
        return { expr: this.expr(o.expr, scope), desc: o.desc };
      });
      op = { op: 'sort', input: op, keys };
    }
    if (p.skip || p.limit) {
      const constant = (x: Expr | undefined, what: string) => {
        if (!x) return undefined;
        const b = this.expr(x, new Map());
        if (b.k !== 'lit' && b.k !== 'param' && b.k !== 'call') semantic(`${what} must be a number or a parameter`);
        return b;
      };
      op = { op: 'limit', input: op, skip: constant(p.skip, 'SKIP'), count: constant(p.limit, 'LIMIT') };
    }
    return op;
  }

  private extractAggregates(x: Expr, scope: Scope, aggs: AggCall[]): PExpr {
    if (x.t === 'call' && isAggregateName(x.name)) {
      const fn = aggregateName(x.name)!;
      if (x.args.some(hasAggregate)) semantic(`Can't nest aggregates: ${x.name}()`);
      if (x.star && fn !== 'count') semantic(`${x.name}(*) isn't a function`);
      const slot = this.slot(`  ${fn}${aggs.length}`);
      aggs.push({ slot, fn, args: x.args.map((a) => this.expr(a, scope)), distinct: x.distinct });
      return { k: 'slot', i: slot };
    }
    if (!hasAggregate(x)) return this.expr(x, scope);
    // Rebuild the expression around the aggregates.
    return this.expr(x, scope, (inner) => (hasAggregate(inner) ? this.extractAggregates(inner, scope, aggs) : null));
  }

  // Expressions.

  expr(x: Expr, scope: Scope, hook?: (x: Expr) => PExpr | null): PExpr {
    const go = (y: Expr, s: Scope = scope): PExpr => {
      if (hook && y !== x) {
        const h = hook(y);
        if (h) return h;
      }
      return this.expr(y, s, hook);
    };
    switch (x.t) {
      case 'lit': return { k: 'lit', v: x.v };
      case 'param': return { k: 'param', name: x.name };
      case 'var': {
        const v = scope.get(x.name);
        if (!v) return semantic(`Variable ${x.name} is not defined`);
        return { k: 'slot', i: v.slot };
      }
      case 'prop': return { k: 'prop', of: go(x.of), key: x.key };
      case 'labels': return { k: 'hasLabels', of: go(x.of), labels: x.labels };
      case 'binary': {
        if (x.op === 'and' || x.op === 'or' || x.op === 'xor') {
          // Flatten chains of the same operator.
          const args: PExpr[] = [];
          const flat = (y: Expr) => {
            if (y.t === 'binary' && y.op === x.op) {
              flat(y.a);
              flat(y.b);
            } else args.push(go(y));
          };
          flat(x);
          return { k: x.op, args };
        }
        // JavaScript has one number type: a float is known from how it's written (see floatish).
        const fn = x.op === 'div' && (floatish(x.a) || floatish(x.b)) ? 'div_float' : x.op;
        return { k: 'call', fn, args: [go(x.a), go(x.b)] };
      }
      case 'unary':
        if (x.op === 'not') return { k: 'not', arg: go(x.a) };
        if (x.op === 'neg') return { k: 'call', fn: 'neg', args: [go(x.a)] };
        return go(x.a);
      case 'compare': {
        const parts: PExpr[] = [];
        const args = x.args.map((a) => go(a));
        x.ops.forEach((op, i) => parts.push({ k: 'call', fn: COMPARE[op]!, args: [args[i]!, args[i + 1]!] }));
        return parts.length === 1 ? parts[0]! : { k: 'and', args: parts };
      }
      case 'isNull': return { k: 'isNull', arg: go(x.a), negated: x.negated };
      case 'list': return { k: 'list', items: x.items.map((i) => go(i)) };
      case 'map': return { k: 'map', entries: x.entries.map(([k, v]) => [k, go(v)] as const) };
      case 'index': return { k: 'index', of: go(x.of), index: go(x.index) };
      case 'slice': return { k: 'slice', of: go(x.of), ...(x.from ? { from: go(x.from) } : {}), ...(x.to ? { to: go(x.to) } : {}) };
      case 'case':
        return {
          k: 'case',
          ...(x.operand ? { operand: go(x.operand) } : {}),
          whens: x.whens.map(([w, t]) => [go(w), go(t)] as const),
          ...(x.else ? { else: go(x.else) } : {}),
        };
      case 'listComp': {
        const list = go(x.list);
        const slot = this.slot(x.name);
        const inner = new Map(scope).set(x.name, { slot, kind: 'value' });
        return { k: 'listComp', list, slot, ...(x.where ? { where: go(x.where, inner) } : {}), ...(x.map ? { map: go(x.map, inner) } : {}) };
      }
      case 'quantifier': {
        const list = go(x.list);
        const slot = this.slot(x.name);
        const inner = new Map(scope).set(x.name, { slot, kind: 'value' });
        return { k: 'quantifier', q: x.q, list, slot, where: go(x.where, inner) };
      }
      case 'exists': {
        const { plan } = this.nested(x.pattern, x.where, scope);
        return { k: 'exists', plan };
      }
      case 'patternComp': {
        const { plan, scope: inner } = this.nested([x.pattern], x.where, scope);
        return { k: 'collectSub', plan, map: this.expr(x.map, inner) };
      }
      case 'call': {
        const lower = x.name.toLowerCase();
        if (isAggregateName(lower)) semantic(`${x.name}() is an aggregate: use it in RETURN or WITH`);
        if (x.distinct) semantic(`DISTINCT is only for aggregates, not ${x.name}()`);
        // exists(n.prop) is the property test of older Cypher.
        if (lower === 'exists' && x.args.length === 1) {
          const a = x.args[0]!;
          if (a.t === 'prop') return { k: 'isNull', arg: go(a), negated: true };
          if (a.t === 'exists') return go(a);
          semantic('exists() takes a property or a pattern');
        }
        let fn = scalarName(lower);
        if (!fn) return semantic(`Unknown function ${x.name}()`);
        if (fn === 'toString' && x.args.length === 1 && floatish(x.args[0]!)) fn = 'toString_float';
        return { k: 'call', fn, args: x.args.map((a) => go(a)) };
      }
    }
  }

  /** A pattern run from the current row, for EXISTS and pattern comprehensions. */
  private nested(pattern: readonly PatternPart[], where: Expr | undefined, scope: Scope): { plan: Op; scope: Scope } {
    const carried = [...new Set([...scope.values()].map((v) => v.slot))];
    const { pattern: p, scope: inner } = this.pattern(pattern, scope, 'exists');
    const w = where ? this.expr(where, inner) : undefined;
    return { plan: { op: 'match', input: { op: 'argument', slots: carried }, pattern: p, ...(w ? { where: w } : {}), optional: false }, scope: inner };
  }
}

function hasAggregate(x: Expr): boolean {
  switch (x.t) {
    case 'call': return isAggregateName(x.name) || x.args.some(hasAggregate);
    case 'lit': case 'param': case 'var': case 'exists': case 'patternComp': return false;
    case 'prop': case 'labels': return hasAggregate(x.of);
    case 'binary': return hasAggregate(x.a) || hasAggregate(x.b);
    case 'unary': case 'isNull': return hasAggregate(x.a);
    case 'compare': return x.args.some(hasAggregate);
    case 'list': return x.items.some(hasAggregate);
    case 'map': return x.entries.some(([, v]) => hasAggregate(v));
    case 'index': return hasAggregate(x.of) || hasAggregate(x.index);
    case 'slice': return hasAggregate(x.of) || (!!x.from && hasAggregate(x.from)) || (!!x.to && hasAggregate(x.to));
    case 'case': return (!!x.operand && hasAggregate(x.operand)) || x.whens.some(([a, b]) => hasAggregate(a) || hasAggregate(b)) || (!!x.else && hasAggregate(x.else));
    case 'listComp': return hasAggregate(x.list);
    case 'quantifier': return hasAggregate(x.list);
  }
}

const FLOAT_FUNCTIONS = new Set(['tofloat', 'sqrt', 'exp', 'log', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pi', 'e', 'rand', 'avg', 'stdev', 'stdevp']);

/**
 * Whether an expression is a float by how it's written: a literal with a point or exponent, a function that returns
 * floats, or arithmetic on one. Values read from properties carry no such mark: there, a whole number acts as an
 * integer (docs/reference/cypher/divergences.md).
 */
function floatish(x: Expr): boolean {
  switch (x.t) {
    case 'lit': return !!x.float;
    case 'unary': return floatish(x.a);
    case 'binary': return ['add', 'sub', 'mul', 'div', 'mod', 'pow'].includes(x.op) && (floatish(x.a) || floatish(x.b));
    case 'call': return FLOAT_FUNCTIONS.has(x.name.toLowerCase());
    default: return false;
  }
}

/** Same expression, ignoring where it is in the text. */
function sameExpr(a: Expr, b: Expr): boolean {
  return JSON.stringify(a, (k, v) => (k === 'start' || k === 'end' ? undefined : v)) === JSON.stringify(b, (k, v) => (k === 'start' || k === 'end' ? undefined : v));
}
