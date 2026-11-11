/**
 * EXPLAIN: the plan as a tree, with the steps the planner chose for each match on a given store.
 */
import type { Expr } from '../plan/expr.js';
import type { GraphPlan, Op, Pattern } from '../plan/ops.js';
import type { GraphStore } from '../store/interface.js';
import { boundSlots } from '../plan/ops.js';
import { describeExpr } from './exec.js';
import { planMatch, type MatchStep } from './match-planner.js';

export interface ExplainLine {
  readonly depth: number;
  readonly op: string;
  readonly detail: string;
}

export function explainPlan(plan: GraphPlan, store: GraphStore): ExplainLine[] {
  if (plan.kind !== 'query') return [{ depth: 0, op: plan.kind === 'createIndex' ? 'CreateIndex' : 'DropIndex', detail: `:${plan.label}(${plan.key})` }];
  const names = plan.slotNames;
  const x = (e: Expr) => describeExpr(e, names);
  // Anonymous elements are named with a leading space: show them without a name.
  const n = (i: number) => {
    const name = names?.[i] ?? `$${i}`;
    return name.startsWith(' ') ? '' : name;
  };
  const lines: ExplainLine[] = [];
  lines.push({ depth: 0, op: 'Results', detail: plan.columns.map((c) => c.name).join(', ') });

  const patternText = (p: Pattern) => {
    const node = (i: number) => {
      const nd = p.nodes[i]!;
      return `(${n(nd.slot)}${nd.labels.map((l) => `:${l}`).join('')})`;
    };
    const parts = p.rels.map((r) => {
      const t = r.types.length ? `:${r.types.join('|')}` : '';
      const hops = r.min !== undefined ? `*${r.min}..${r.max ?? ''}` : '';
      const body = `[${n(r.slot)}${t}${hops}]`;
      const arrow = r.dir === 'out' ? `-${body}->` : r.dir === 'in' ? `<-${body}-` : `-${body}-`;
      return `${node(r.from)}${arrow}${node(r.to)}`;
    });
    const lone = p.nodes.map((_, i) => i).filter((i) => !p.rels.some((r) => r.from === i || r.to === i));
    return [...parts, ...lone.map(node)].join(', ');
  };

  const step = (s: MatchStep, p: Pattern): [string, string] => {
    const node = (i: number) => n(p.nodes[i]!.slot);
    const rel = (i: number) => p.rels[i]!;
    const est = (v: number) => (Number.isFinite(v) ? ` ~${v < 10 ? v.toFixed(1) : Math.round(v)}` : '');
    switch (s.s) {
      case 'scan': return s.label ? ['NodeByLabelScan', `${node(s.node)}:${s.label}${est(s.est)}`] : ['AllNodesScan', `${node(s.node)}${est(s.est)}`];
      case 'seek': return [s.indexed ? 'NodeIndexSeek' : 'NodeByLabelScan+Filter', `${node(s.node)}:${s.label}(${s.key} = ${x(s.value)})${est(s.est)}`];
      case 'byId': return ['NodeById', `${node(s.node)} = ${x(s.id)}`];
      case 'bound': return ['Argument', node(s.node)];
      case 'boundRel': return ['RelationshipArgument', n(rel(s.rel).slot)];
      case 'expand': {
        const r = rel(s.rel);
        const t = r.types.length ? `:${r.types.join('|')}` : '';
        const a = s.dir === 'out' ? '->' : '-';
        const b = s.dir === 'in' ? '<-' : '-';
        return [s.into ? 'Expand(Into)' : 'Expand(All)', `(${node(s.from)})${b}[${n(r.slot)}${t}]${a}(${node(s.to)})${est(s.est)}`];
      }
      case 'varExpand': {
        const r = rel(s.rel);
        return ['VarLengthExpand', `(${node(s.from)})-[${n(r.slot)}${r.types.length ? `:${r.types.join('|')}` : ''}*${s.min}..${Number.isFinite(s.max) ? s.max : ''}]-(${node(s.to)})`];
      }
      case 'shortest': return [s.all ? 'AllShortestPaths' : 'ShortestPath', `(${node(s.from)}) → (${node(s.to)})`];
      case 'filter': return ['Filter', x(s.pred)];
    }
  };

  const walk = (op: Op, depth: number) => {
    const add = (o: string, detail = '') => lines.push({ depth, op: o, detail });
    switch (op.op) {
      case 'argument':
        if (op.slots.length) add('Argument', op.slots.map(n).join(', '));
        return;
      case 'match': case 'merge': {
        add(op.op === 'merge' ? 'Merge' : op.optional ? 'OptionalMatch' : 'Match', patternText(op.pattern));
        const mp = planMatch(op.pattern, op.op === 'match' ? op.where : undefined, boundSlots(op.input), store);
        for (const s of mp.steps) {
          const [o, d] = step(s, op.pattern);
          lines.push({ depth: depth + 1, op: o, detail: d });
        }
        break;
      }
      case 'filter': add('Filter', x(op.pred)); break;
      case 'project': add(op.discard ? 'Projection' : 'Extend', op.items.map((p) => `${x(p.expr)} AS ${n(p.slot)}`).join(', ')); break;
      case 'aggregate':
        add('Aggregate', [...op.keys.map((k) => x(k.expr)), ...op.aggs.map((a) => `${a.fn}(${a.distinct ? 'DISTINCT ' : ''}${a.args.length ? a.args.map(x).join(', ') : '*'}) AS ${n(a.slot)}`)].join(', '));
        break;
      case 'distinct': add('Distinct', op.slots.map(n).join(', ')); break;
      case 'sort': add('Sort', op.keys.map((k) => `${x(k.expr)}${k.desc ? ' DESC' : ''}`).join(', ')); break;
      case 'limit': add('Limit', [op.skip ? `skip ${x(op.skip)}` : '', op.count ? `limit ${x(op.count)}` : ''].filter(Boolean).join(', ')); break;
      case 'unwind': add('Unwind', `${x(op.list)} AS ${n(op.slot)}`); break;
      case 'eager': add('Eager'); break;
      case 'union': add(op.all ? 'UnionAll' : 'Union'); for (const i of op.inputs) walk(i, depth + 1); return;
      case 'create': add('Create', patternText(op.pattern)); break;
      case 'set': add('Set', `${op.items.length} item${op.items.length === 1 ? '' : 's'}`); break;
      case 'remove': add('Remove', `${op.items.length} item${op.items.length === 1 ? '' : 's'}`); break;
      case 'delete': add(op.detach ? 'DetachDelete' : 'Delete', op.targets.map(x).join(', ')); break;
    }
    walk(op.input, depth + 1);
  };
  walk(plan.root, 1);
  return lines;
}

/** EXPLAIN lines as indented text. */
export function explainText(lines: readonly ExplainLine[]): string {
  return lines.map((l) => `${'  '.repeat(l.depth)}${l.op}${l.detail ? `  ${l.detail}` : ''}`).join('\n');
}
