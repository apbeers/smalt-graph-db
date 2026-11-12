/**
 * Checks a plan before it runs: the version, slot numbers, that every expression reads only slots bound where it is,
 * that pattern indexes point into their pattern, and that functions exist. A language's bug shows up here as
 * SMALTCY_PLAN, not as a wrong answer.
 */
import { SmaltcyError } from '../errors.js';
import { aggregateFunctions, scalarFunctions } from '../functions/library.js';
import { forEachChild, slotsRead, type Expr } from './expr.js';
import { PLAN_VERSION, boundSlots, exprsOf, inputs, type GraphPlan, type Op, type Pattern } from './ops.js';

const bad = (msg: string): never => {
  throw new SmaltcyError('SMALTCY_PLAN', `Invalid plan: ${msg}`);
};

export function validatePlan(plan: GraphPlan): void {
  if (plan.planVersion !== PLAN_VERSION) bad(`planVersion ${plan.planVersion} (this engine reads ${PLAN_VERSION})`);
  if (plan.kind !== 'query') {
    if (plan.kind !== 'createIndex' && plan.kind !== 'dropIndex') bad(`unknown plan kind ${(plan as { kind: string }).kind}`);
    if (!plan.label || !plan.key) bad('an index needs a label and a key');
    return;
  }
  const width = plan.slots;
  if (!Number.isInteger(width) || width < 0) bad('slots must be a non-negative integer');
  const slot = (i: number, what: string) => {
    if (!Number.isInteger(i) || i < 0 || i >= width) bad(`${what} uses slot ${i}, outside 0..${width - 1}`);
  };
  const names = plan.slotNames;
  const name = (i: number) => names?.[i] ?? `slot ${i}`;

  const checkExpr = (x: Expr, bound: ReadonlySet<number>) => {
    for (const s of slotsRead(x)) {
      slot(s, 'An expression');
      if (!bound.has(s)) bad(`an expression reads ${name(s)}, which isn't bound there`);
    }
    walkExpr(x);
  };
  const walkExpr = (x: Expr) => {
    if (x.k === 'call' && !scalarFunctions.has(x.fn)) bad(`unknown function ${x.fn}()`);
    if (x.k === 'call') {
      const [lo, hi] = scalarFunctions.get(x.fn)!.arity;
      if (x.args.length < lo || (hi >= 0 && x.args.length > hi)) bad(`${x.fn}() takes ${lo === hi ? lo : `${lo} to ${hi < 0 ? 'any number of' : hi}`} arguments, not ${x.args.length}`);
    }
    if (x.k === 'listComp' || x.k === 'quantifier') slot(x.slot, 'A list expression');
    if (x.k === 'exists' || x.k === 'collectSub') checkOp(x.plan);
    forEachChild(x, walkExpr);
  };

  const checkPattern = (p: Pattern, what: string) => {
    for (const n of p.nodes) slot(n.slot, what);
    for (const r of p.rels) {
      slot(r.slot, what);
      if (!p.nodes[r.from] || !p.nodes[r.to]) bad(`${what}: a relationship's ends must be nodes of its pattern`);
      if (r.dir !== 'out' && r.dir !== 'in' && r.dir !== 'both') bad(`${what}: direction ${r.dir}`);
      if (r.min !== undefined && (!Number.isInteger(r.min) || r.min < 0)) bad(`${what}: min hops must be a non-negative integer`);
      if (r.max !== undefined && (r.min === undefined || r.max < r.min)) bad(`${what}: max hops needs min hops no larger`);
      if (r.shortest && r.min === undefined) bad(`${what}: a shortest path is variable-length`);
    }
    for (const path of p.paths ?? []) {
      slot(path.slot, what);
      if (path.nodes.length !== path.rels.length + 1) bad(`${what}: a path has one more node than relationships`);
      for (const i of path.nodes) if (!p.nodes[i]) bad(`${what}: a path's nodes must be in its pattern`);
      for (const i of path.rels) if (!p.rels[i]) bad(`${what}: a path's relationships must be in its pattern`);
    }
  };

  const checkOp = (op: Op): void => {
    for (const i of inputs(op)) checkOp(i);
    if (op.op === 'argument') {
      for (const s of op.slots) slot(s, 'argument');
      return;
    }
    const before = op.op === 'union' ? new Set<number>() : boundSlots(op.input);
    switch (op.op) {
      case 'match': case 'create': case 'merge': {
        checkPattern(op.pattern, op.op);
        // Pattern expressions see the slots bound before the pattern, and (for match) its own nodes.
        const within = new Set(before);
        if (op.op === 'match') for (const s of boundSlots(op)) within.add(s);
        for (const x of exprsOf(op)) checkExpr(x, op.op === 'merge' ? boundSlots(op) : within);
        return;
      }
      case 'aggregate':
        for (const a of op.aggs) {
          slot(a.slot, 'aggregate');
          const def = aggregateFunctions.get(a.fn);
          if (!def) bad(`unknown aggregate ${a.fn}()`);
          if (a.args.length < def!.arity[0] || a.args.length > def!.arity[1]) bad(`${a.fn}() takes ${def!.arity[0]}–${def!.arity[1]} arguments`);
        }
        for (const k of op.keys) slot(k.slot, 'aggregate');
        break;
      case 'project':
        for (const p of op.items) slot(p.slot, 'project');
        break;
      case 'unwind':
        slot(op.slot, 'unwind');
        break;
      case 'distinct':
        for (const s of op.slots) if (!before.has(s)) bad(`distinct on ${name(s)}, which isn't bound`);
        break;
      case 'union':
        for (const i of op.inputs) {
          const b = boundSlots(i);
          for (const s of op.slots) if (!b.has(s)) bad(`a union branch doesn't bind ${name(s)}`);
        }
        return;
    }
    for (const x of exprsOf(op)) checkExpr(x, before);
  };

  checkOp(plan.root);
  if (plan.asOf) {
    const x = 'version' in plan.asOf ? plan.asOf.version : plan.asOf.time;
    if (x.k !== 'lit' && x.k !== 'param') bad('asOf takes a literal or a parameter');
    if (writesIn(plan.root)) bad("a plan that reads a past version can't write");
  }
  const out = boundSlots(plan.root);
  for (const c of plan.columns) {
    slot(c.slot, `Column ${c.name}`);
    if (!out.has(c.slot)) bad(`column ${c.name} reads ${name(c.slot)}, which isn't bound at the end`);
  }
}

function writesIn(op: Op): boolean {
  if (op.op === 'create' || op.op === 'merge' || op.op === 'set' || op.op === 'remove' || op.op === 'delete') return true;
  return inputs(op).some(writesIn);
}
