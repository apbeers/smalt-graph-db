/**
 * Plans a `match` pattern: chooses where to start and the order to expand relationships in, from the store's
 * statistics, and puts each predicate at the first step where everything it reads is bound. The result is a list of
 * steps the executor runs depth-first.
 */
import { e, slotsRead, type Expr } from '../plan/expr.js';
import type { Direction, Pattern, PatternRel } from '../plan/ops.js';
import type { GraphStore, StoreStats } from '../store/interface.js';

export type MatchStep =
  /** Nodes with the label (or all nodes) into the pattern node's slot. */
  | { readonly s: 'scan'; readonly node: number; readonly label: string | null; readonly est: number }
  /** Nodes with the label whose property equals the value: an index lookup, or a scan where the store has none. */
  | { readonly s: 'seek'; readonly node: number; readonly label: string; readonly key: string; readonly value: Expr; readonly est: number; readonly indexed: boolean }
  | { readonly s: 'byId'; readonly node: number; readonly id: Expr }
  /** The node's slot is bound before the match: it must hold a node. */
  | { readonly s: 'bound'; readonly node: number }
  /** The relationship's slot is bound before the match: bind or check its ends. */
  | { readonly s: 'boundRel'; readonly rel: number; readonly from: number; readonly to: number; readonly dir: Direction }
  /** One hop from `from` to `to` (`into`: `to` is bound already, so only check it). `dir` is relative to `from`. */
  | { readonly s: 'expand'; readonly rel: number; readonly from: number; readonly to: number; readonly dir: Direction; readonly into: boolean; readonly est: number }
  | {
      readonly s: 'varExpand';
      readonly rel: number;
      readonly from: number;
      readonly to: number;
      readonly dir: Direction;
      readonly into: boolean;
      readonly min: number;
      readonly max: number;
      /** Property equalities every relationship on the way must meet. */
      readonly relProps: readonly (readonly [string, Expr])[];
      readonly est: number;
    }
  | { readonly s: 'shortest'; readonly rel: number; readonly from: number; readonly to: number; readonly dir: Direction; readonly all: boolean; readonly min: number; readonly max: number; readonly relProps: readonly (readonly [string, Expr])[] }
  | { readonly s: 'filter'; readonly pred: Expr };

export interface MatchPlan {
  readonly steps: readonly MatchStep[];
  /** Slots the match binds (to clear for an optional match with no result). */
  readonly newSlots: readonly number[];
}

const flip = (d: Direction): Direction => (d === 'out' ? 'in' : d === 'in' ? 'out' : 'both');

/** The parts of an AND. */
export function conjuncts(x: Expr | undefined): Expr[] {
  if (!x) return [];
  if (x.k === 'and') return x.args.flatMap(conjuncts);
  return [x];
}

/** The `[key, value]` pairs of a pattern's property map, when it's written out; null when it's a parameter or the like. */
function propEntries(x: Expr | undefined): (readonly [string, Expr])[] | null {
  if (!x) return [];
  if (x.k === 'map') return [...x.entries];
  if (x.k === 'lit' && x.v !== null && typeof x.v === 'object' && !Array.isArray(x.v)) {
    return Object.entries(x.v).map(([k, v]) => [k, e.lit(v)] as const);
  }
  return null;
}

/** A predicate that the pattern's properties must match: `props` may be any map expression. */
function propsPredicate(slot: number, props: Expr): Expr[] {
  const entries = propEntries(props);
  if (entries) return entries.map(([k, v]) => e.eq(e.prop(e.slot(slot), k), v));
  return [{ k: 'call', fn: 'props_match', args: [e.slot(slot), props] }];
}

export function planMatch(pattern: Pattern, where: Expr | undefined, boundIn: ReadonlySet<number>, store: GraphStore): MatchPlan {
  const stats = store.stats();
  const nodes = pattern.nodes;
  const rels = pattern.rels;
  const steps: MatchStep[] = [];
  const bound = new Set(boundIn);
  const visited = new Set<number>();
  let pending = conjuncts(where);
  const newSlots = new Set<number>();
  for (const n of nodes) if (!boundIn.has(n.slot)) newSlots.add(n.slot);
  for (const r of rels) if (!boundIn.has(r.slot)) newSlots.add(r.slot);
  for (const p of pattern.paths ?? []) newSlots.add(p.slot);

  // Node predicates, waiting for their node: labels and properties. Seek steps consume one of them.
  const nodePreds = nodes.map((n) => {
    const preds: Expr[] = [];
    if (n.labels.length) preds.push({ k: 'hasLabels', of: e.slot(n.slot), labels: n.labels });
    if (n.props) preds.push(...propsPredicate(n.slot, n.props));
    return preds;
  });
  // A node used twice in the pattern with different labels is one node: merge the predicates of its occurrences.
  const firstOfSlot = new Map<number, number>();
  nodes.forEach((n, i) => {
    const first = firstOfSlot.get(n.slot);
    if (first === undefined) firstOfSlot.set(n.slot, i);
  });
  const canonical = (i: number) => firstOfSlot.get(nodes[i]!.slot)!;
  nodes.forEach((_, i) => {
    const c = canonical(i);
    if (c !== i) {
      nodePreds[c]!.push(...nodePreds[i]!);
      nodePreds[i] = [];
    }
  });

  const flushPending = () => {
    const ready: Expr[] = [];
    pending = pending.filter((c) => {
      for (const s of slotsRead(c)) if (!bound.has(s)) return true;
      ready.push(c);
      return false;
    });
    for (const pred of ready) steps.push({ s: 'filter', pred });
  };

  const visit = (i: number, skip?: Expr, label?: string | null) => {
    const c = canonical(i);
    visited.add(c);
    bound.add(nodes[c]!.slot);
    for (const p of nodePreds[c]!) {
      if (p === skip) continue;
      // The scan or seek that bound the node already guarantees its label.
      if (label && p.k === 'hasLabels' && p.labels.includes(label)) {
        const rest = p.labels.filter((l) => l !== label);
        if (rest.length) steps.push({ s: 'filter', pred: { ...p, labels: rest } });
        continue;
      }
      steps.push({ s: 'filter', pred: p });
    }
    nodePreds[c] = [];
    flushPending();
  };

  // Nodes bound before the match.
  flushPending();
  nodes.forEach((n, i) => {
    if (boundIn.has(n.slot) && !visited.has(canonical(i))) {
      steps.push({ s: 'bound', node: canonical(i) });
      visit(i);
    }
  });

  const remaining = new Set<number>(rels.map((_, i) => i).filter((i) => !rels[i]!.shortest));
  // Relationships bound before the match fix their ends.
  for (const ri of [...remaining]) {
    const r = rels[ri]!;
    if (!boundIn.has(r.slot)) continue;
    remaining.delete(ri);
    steps.push({ s: 'boundRel', rel: ri, from: canonical(r.from), to: canonical(r.to), dir: r.dir });
    for (const end of [r.from, r.to]) if (!visited.has(canonical(end))) visit(end);
    if (r.props) for (const p of propsPredicate(r.slot, r.props)) steps.push({ s: 'filter', pred: p });
  }

  const fanout = (r: PatternRel, dir: Direction) => avgDegree(stats, r.types, dir);

  while (true) {
    // The cheapest relationship next to what's bound.
    let best: { ri: number; from: number; to: number; dir: Direction; cost: number; into: boolean } | null = null;
    for (const ri of remaining) {
      const r = rels[ri]!;
      const a = canonical(r.from);
      const b = canonical(r.to);
      for (const [from, to, dir] of [[a, b, r.dir], [b, a, flip(r.dir)]] as const) {
        if (!visited.has(from)) continue;
        const into = visited.has(to);
        const f = fanout(r, dir);
        let cost = r.min !== undefined ? f ** Math.min(r.max ?? 3, 3) : f;
        if (into) cost = Math.min(cost, 0.5);
        if (!best || cost < best.cost) best = { ri, from, to, dir, cost, into };
      }
    }
    if (best) {
      const r = rels[best.ri]!;
      remaining.delete(best.ri);
      if (r.min !== undefined) {
        const relProps = propEntries(r.props) ?? [];
        steps.push({ s: 'varExpand', rel: best.ri, from: best.from, to: best.to, dir: best.dir, into: best.into, min: r.min, max: r.max ?? Infinity, relProps, est: best.cost });
      } else {
        steps.push({ s: 'expand', rel: best.ri, from: best.from, to: best.to, dir: best.dir, into: best.into, est: best.cost });
      }
      bound.add(r.slot);
      if (r.min === undefined && r.props) for (const p of propsPredicate(r.slot, r.props)) steps.push({ s: 'filter', pred: p });
      if (!best.into) visit(best.to);
      else flushPending();
      continue;
    }
    // Nothing to expand: start from the cheapest node not yet bound.
    let start: { i: number; step: MatchStep; cost: number; consumed?: Expr } | null = null;
    for (let i = 0; i < nodes.length; i++) {
      if (canonical(i) !== i || visited.has(i)) continue;
      const cand = startFor(i);
      if (!start || cand.cost < start.cost) start = { i, ...cand };
    }
    if (!start) break;
    steps.push(start.step);
    if (start.consumed) pending = pending.filter((c) => c !== start!.consumed);
    visit(start.i, start.consumed, start.step.s === 'scan' || start.step.s === 'seek' ? start.step.label : null);
  }

  function startFor(i: number): { step: MatchStep; cost: number; consumed?: Expr } {
    const n = nodes[i]!;
    const slot = n.slot;
    const usable = (x: Expr) => [...slotsRead(x)].every((s) => bound.has(s));
    // id(n) = value
    for (const c of pending) {
      const v = matchEq(c, (x) => x.k === 'call' && x.fn === 'id' && x.args.length === 1 && x.args[0]!.k === 'slot' && x.args[0]!.i === slot);
      if (v && usable(v)) return { step: { s: 'byId', node: i, id: v }, cost: 1, consumed: c };
    }
    // A label with a property equality: from the pattern, then from WHERE.
    const labels = n.labels;
    let bestLabel: string | null = null;
    let labelCount = stats.nodes;
    for (const l of labels) {
      const c = stats.labels.get(l) ?? 0;
      if (bestLabel === null || c < labelCount) {
        bestLabel = l;
        labelCount = c;
      }
    }
    if (bestLabel !== null) {
      const indexed = (key: string) =>
        store.capabilities.propertyIndexes === 'all' ||
        (store.capabilities.propertyIndexes === 'declared' && store.indexes().some((x) => x.label === bestLabel && x.key === key));
      const candidates: { key: string; value: Expr; consumed: Expr }[] = [];
      for (const p of nodePreds[i]!) {
        const v = matchEq(p, (x) => x.k === 'prop' && x.of.k === 'slot' && x.of.i === slot);
        if (v && usable(v)) candidates.push({ key: propKey(p, slot)!, value: v, consumed: p });
      }
      for (const c of pending) {
        const v = matchEq(c, (x) => x.k === 'prop' && x.of.k === 'slot' && x.of.i === slot);
        if (v && usable(v)) candidates.push({ key: propKey(c, slot)!, value: v, consumed: c });
      }
      const seek = candidates.find((c) => indexed(c.key)) ?? candidates[0];
      if (seek) {
        const est = indexed(seek.key) ? Math.max(1, labelCount / 100) : labelCount;
        // A seek without an index still scans the label, but saves building the predicate.
        const cost = indexed(seek.key) ? est : labelCount * 0.9;
        return { step: { s: 'seek', node: i, label: bestLabel, key: seek.key, value: seek.value, est, indexed: indexed(seek.key) }, cost, consumed: seek.consumed };
      }
      return { step: { s: 'scan', node: i, label: bestLabel, est: labelCount }, cost: labelCount };
    }
    return { step: { s: 'scan', node: i, label: null, est: stats.nodes }, cost: stats.nodes };
  }

  // Shortest paths, once both ends are bound.
  for (const [ri, r] of rels.entries()) {
    if (!r.shortest) continue;
    steps.push({
      s: 'shortest', rel: ri, from: canonical(r.from), to: canonical(r.to), dir: r.dir, all: r.shortest === 'all',
      min: r.min ?? 1, max: r.max ?? Infinity, relProps: propEntries(r.props) ?? [],
    });
    bound.add(r.slot);
  }
  for (const p of pattern.paths ?? []) bound.add(p.slot);
  flushPending();
  for (const c of pending) steps.push({ s: 'filter', pred: c });
  return { steps, newSlots: [...newSlots] };
}

/** For `eq(lhs, v)` or `eq(v, lhs)` where `lhs` passes `test`: `v`. */
function matchEq(c: Expr, test: (x: Expr) => boolean): Expr | null {
  if (c.k !== 'call' || c.fn !== 'eq' || c.args.length !== 2) return null;
  const [a, b] = c.args as [Expr, Expr];
  if (test(a)) return b;
  if (test(b)) return a;
  return null;
}

function propKey(c: Expr, slot: number): string | null {
  if (c.k !== 'call') return null;
  for (const a of c.args) if (a.k === 'prop' && a.of.k === 'slot' && a.of.i === slot) return a.key;
  return null;
}

/** The average number of relationships of these types at a node, in a direction. */
function avgDegree(stats: StoreStats, types: readonly string[], dir: Direction): number {
  const total = types.length ? types.reduce((s, t) => s + (stats.types.get(t) ?? 0), 0) : stats.rels;
  const per = total / Math.max(1, stats.nodes);
  return dir === 'both' ? 2 * per : per;
}
