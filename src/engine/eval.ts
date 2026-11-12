/**
 * Expressions compile once, per plan, into closures over the row.
 */
import { SmaltcyError } from '../errors.js';
import type { Expr } from '../plan/expr.js';
import type { Op } from '../plan/ops.js';
import type { GraphStore } from '../store/interface.js';
import { NodeRef, RelRef, isMap, typeName, type Value } from '../values.js';
import { equals } from '../functions/compare.js';
import { scalarFunctions, type FnContext } from '../functions/library.js';

export type Row = Value[];
export type Compiled = (row: Row) => Value;

export interface EvalContext extends FnContext {
  /** The engine reads more of the store than functions do. */
  readonly store: GraphStore;
  readonly params: Readonly<Record<string, Value>>;
  /** Runs a nested plan from `row`, calling `emit` with each of its rows until it returns false. */
  runNested(plan: Op, row: Row, emit: (r: Row) => boolean): void;
}

/** Three-valued truth: true, false or NULL. Anything else in a predicate is an error. */
export function truth(v: Value, what = 'A predicate'): boolean | null {
  if (v === null || typeof v === 'boolean') return v;
  throw new SmaltcyError('SMALTCY_TYPE', `${what} must be a boolean, not ${typeName(v)}`);
}

export function compileExpr(x: Expr, ctx: EvalContext): Compiled {
  switch (x.k) {
    case 'lit': {
      const v = x.v as Value;
      return () => v;
    }
    case 'param': {
      const name = x.name;
      return () => {
        const v = ctx.params[name];
        if (v === undefined) throw new SmaltcyError('SMALTCY_PARAM', `Missing parameter $${name}`);
        return v;
      };
    }
    case 'slot': {
      const i = x.i;
      return (row) => row[i] ?? null;
    }
    case 'prop': {
      const of = compileExpr(x.of, ctx);
      const key = x.key;
      const store = ctx.store;
      return (row) => {
        const v = of(row);
        if (v === null) return null;
        if (v instanceof NodeRef) return (store.nodeProperty(v.id, key) ?? null) as Value;
        if (v instanceof RelRef) return (store.relProperty(v.id, key) ?? null) as Value;
        if (isMap(v)) return v[key] ?? null;
        throw new SmaltcyError('SMALTCY_TYPE', `Can't read property ${key} of a ${typeName(v)}`);
      };
    }
    case 'call': {
      const def = scalarFunctions.get(x.fn);
      if (!def) throw new SmaltcyError('SMALTCY_NOT_FOUND', `Unknown function ${x.fn}()`);
      const args = x.args.map((a) => compileExpr(a, ctx));
      const fn = def.fn;
      if (args.length === 1) {
        const [a] = args as [Compiled];
        return (row) => fn([a(row)], ctx);
      }
      if (args.length === 2) {
        const [a, b] = args as [Compiled, Compiled];
        return (row) => fn([a(row), b(row)], ctx);
      }
      return (row) => fn(args.map((a) => a(row)), ctx);
    }
    case 'list': {
      const items = x.items.map((a) => compileExpr(a, ctx));
      return (row) => items.map((a) => a(row));
    }
    case 'map': {
      const entries = x.entries.map(([k, v]) => [k, compileExpr(v, ctx)] as const);
      return (row) => {
        const out: Record<string, Value> = {};
        for (const [k, v] of entries) out[k] = v(row);
        return out;
      };
    }
    case 'and': {
      const args = x.args.map((a) => compileExpr(a, ctx));
      return (row) => {
        let sawNull = false;
        for (const a of args) {
          const t = truth(a(row));
          if (t === false) return false;
          if (t === null) sawNull = true;
        }
        return sawNull ? null : true;
      };
    }
    case 'or': {
      const args = x.args.map((a) => compileExpr(a, ctx));
      return (row) => {
        let sawNull = false;
        for (const a of args) {
          const t = truth(a(row));
          if (t === true) return true;
          if (t === null) sawNull = true;
        }
        return sawNull ? null : false;
      };
    }
    case 'xor': {
      const args = x.args.map((a) => compileExpr(a, ctx));
      return (row) => {
        let r = false;
        for (const a of args) {
          const t = truth(a(row));
          if (t === null) return null;
          r = r !== t;
        }
        return r;
      };
    }
    case 'not': {
      const a = compileExpr(x.arg, ctx);
      return (row) => {
        const t = truth(a(row));
        return t === null ? null : !t;
      };
    }
    case 'isNull': {
      const a = compileExpr(x.arg, ctx);
      return x.negated ? (row) => a(row) !== null : (row) => a(row) === null;
    }
    case 'hasLabels': {
      const of = compileExpr(x.of, ctx);
      const labels = x.labels;
      const store = ctx.store;
      return (row) => {
        const v = of(row);
        if (v === null) return null;
        if (v instanceof NodeRef) return labels.every((l) => store.hasLabel(v.id, l));
        if (v instanceof RelRef) return labels.includes(store.relType(v.id));
        throw new SmaltcyError('SMALTCY_TYPE', `Can't test the labels of a ${typeName(v)}`);
      };
    }
    case 'case': {
      const operand = x.operand ? compileExpr(x.operand, ctx) : null;
      const whens = x.whens.map(([w, t]) => [compileExpr(w, ctx), compileExpr(t, ctx)] as const);
      const otherwise = x.else ? compileExpr(x.else, ctx) : () => null;
      if (operand) {
        return (row) => {
          const v = operand(row);
          for (const [w, t] of whens) if (equals(v, w(row)) === true) return t(row);
          return otherwise(row);
        };
      }
      return (row) => {
        for (const [w, t] of whens) if (truth(w(row), 'A CASE condition') === true) return t(row);
        return otherwise(row);
      };
    }
    case 'index': {
      const of = compileExpr(x.of, ctx);
      const index = compileExpr(x.index, ctx);
      const store = ctx.store;
      return (row) => {
        const v = of(row);
        const i = index(row);
        if (v === null || i === null) return null;
        if (Array.isArray(v)) {
          if (typeof i !== 'number' || !Number.isInteger(i)) throw new SmaltcyError('SMALTCY_TYPE', 'A list index must be an integer');
          return v[i < 0 ? v.length + i : i] ?? null;
        }
        if (typeof i !== 'string') throw new SmaltcyError('SMALTCY_TYPE', `Can't index a ${typeName(v)} with a ${typeName(i)}`);
        if (v instanceof NodeRef) return (store.nodeProperty(v.id, i) ?? null) as Value;
        if (v instanceof RelRef) return (store.relProperty(v.id, i) ?? null) as Value;
        if (isMap(v)) return v[i] ?? null;
        throw new SmaltcyError('SMALTCY_TYPE', `Can't index a ${typeName(v)}`);
      };
    }
    case 'slice': {
      const of = compileExpr(x.of, ctx);
      const from = x.from ? compileExpr(x.from, ctx) : null;
      const to = x.to ? compileExpr(x.to, ctx) : null;
      return (row) => {
        const v = of(row);
        const a = from ? from(row) : 0;
        const b = to ? to(row) : null;
        if (v === null || a === null || (to && b === null)) return null;
        if (!Array.isArray(v)) throw new SmaltcyError('SMALTCY_TYPE', `Can't slice a ${typeName(v)}`);
        return v.slice(a as number, b === null ? undefined : (b as number));
      };
    }
    case 'listComp': {
      const list = compileExpr(x.list, ctx);
      const where = x.where ? compileExpr(x.where, ctx) : null;
      const map = x.map ? compileExpr(x.map, ctx) : null;
      const slot = x.slot;
      return (row) => {
        const l = list(row);
        if (l === null) return null;
        if (!Array.isArray(l)) throw new SmaltcyError('SMALTCY_TYPE', `Can't iterate over a ${typeName(l)}`);
        const out: Value[] = [];
        for (const v of l) {
          row[slot] = v;
          if (where && truth(where(row)) !== true) continue;
          out.push(map ? map(row) : v);
        }
        return out;
      };
    }
    case 'quantifier': {
      const list = compileExpr(x.list, ctx);
      const where = compileExpr(x.where, ctx);
      const { slot, q } = x;
      return (row) => {
        const l = list(row);
        if (l === null) return null;
        if (!Array.isArray(l)) throw new SmaltcyError('SMALTCY_TYPE', `Can't iterate over a ${typeName(l)}`);
        let yes = 0;
        let nulls = 0;
        for (const v of l) {
          row[slot] = v;
          const t = truth(where(row));
          if (t === true) {
            yes++;
            if (q === 'any') return true;
            if (q === 'none') return false;
            if (q === 'single' && yes > 1) return false;
          } else if (t === null) nulls++;
          else if (q === 'all') return false;
        }
        if (q === 'any') return nulls ? null : false;
        if (q === 'none') return nulls ? null : true;
        if (q === 'all') return nulls ? null : true;
        return nulls ? (yes <= 1 ? null : false) : yes === 1;
      };
    }
    case 'exists': {
      const plan = x.plan;
      return (row) => {
        let found = false;
        ctx.runNested(plan, row, () => ((found = true), false));
        return found;
      };
    }
    case 'collectSub': {
      const plan = x.plan;
      const map = compileExpr(x.map, ctx);
      return (row) => {
        const out: Value[] = [];
        ctx.runNested(plan, row, (r) => (out.push(map(r)), true));
        return out;
      };
    }
  }
}
