/**
 * Equality, comparison and ordering of values, as openCypher defines them:
 * - `equals` is `=`: NULL when either side is NULL (or a list holds NULL where it matters), false across types.
 * - `compare` is `<` and friends: NULL across types that don't compare.
 * - `orderCompare` is ORDER BY's total order: maps, nodes, relationships, lists, paths, strings, booleans, numbers,
 *   then NULL last.
 * - `groupKey` makes equivalent values (DISTINCT, grouping) the same string; NULL is equivalent to NULL there.
 */
import { NodeRef, PathRef, RelRef, isMap, type Value } from '../values.js';

export function equals(a: Value, b: Value): boolean | null {
  if (a === null || b === null) return null;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    let sawNull = false;
    for (let i = 0; i < a.length; i++) {
      const r = equals(a[i], b[i]);
      if (r === false) return false;
      if (r === null) sawNull = true;
    }
    return sawNull ? null : true;
  }
  if (a instanceof NodeRef) return b instanceof NodeRef && a.id === b.id;
  if (a instanceof RelRef) return b instanceof RelRef && a.id === b.id;
  if (a instanceof PathRef) return b instanceof PathRef && groupKey(a) === groupKey(b);
  if (isMap(a) && isMap(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    let sawNull = false;
    for (const k of ka) {
      if (!(k in b)) return false;
      const r = equals(a[k]!, b[k]!);
      if (r === false) return false;
      if (r === null) sawNull = true;
    }
    return sawNull ? null : true;
  }
  return false;
}

/** `<` / `>` ordering: negative, zero or positive, or NULL when the values don't compare. */
export function compare(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compare(a[i], b[i]);
      if (c === null) return null;
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return null;
}

function orderClass(v: Value): number {
  if (v === null) return 9;
  switch (typeof v) {
    case 'number': return Number.isNaN(v) ? 8 : 7;
    case 'boolean': return 6;
    case 'string': return 5;
  }
  if (v instanceof PathRef) return 4;
  if (Array.isArray(v)) return 3;
  if (v instanceof RelRef) return 2;
  if (v instanceof NodeRef) return 1;
  return 0;
}

/** ORDER BY's total order, ascending. */
export function orderCompare(a: Value, b: Value): number {
  const ca = orderClass(a);
  const cb = orderClass(b);
  if (ca !== cb) return ca - cb;
  switch (ca) {
    case 7: return (a as number) - (b as number);
    case 6: return Number(a) - Number(b);
    case 5: return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    case 1: case 2: return (a as NodeRef).id - (b as NodeRef).id;
    case 3: {
      const x = a as readonly Value[];
      const y = b as readonly Value[];
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) {
        const c = orderCompare(x[i]!, y[i]!);
        if (c !== 0) return c;
      }
      return x.length - y.length;
    }
    case 4: {
      const c = orderCompare((a as PathRef).nodes as Value, (b as PathRef).nodes as Value);
      return c !== 0 ? c : orderCompare((a as PathRef).rels as Value, (b as PathRef).rels as Value);
    }
    case 0: {
      const ka = groupKey(a);
      const kb = groupKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }
  }
  return 0;
}

/** A string that is the same for equivalent values. */
export function groupKey(v: Value): string {
  if (v === null) return '_';
  switch (typeof v) {
    case 'number': return Object.is(v, -0) ? 'n0' : `n${v}`;
    case 'string': return `s${v.length}:${v}`;
    case 'boolean': return v ? 'T' : 'F';
  }
  if (Array.isArray(v)) return `[${v.map(groupKey).join(',')}]`;
  if (v instanceof NodeRef) return `N${v.id}`;
  if (v instanceof RelRef) return `R${v.id}`;
  if (v instanceof PathRef) return `P${v.nodes.join('.')}/${v.rels.join('.')}`;
  const m = v as { readonly [k: string]: Value };
  return `{${Object.keys(m).sort().map((k) => `${k.length}:${k}=${groupKey(m[k]!)}`).join(',')}}`;
}

/** The key of several values, for grouping and DISTINCT over a row's slots. */
export function rowKey(values: readonly Value[]): string {
  if (values.length === 1) return groupKey(values[0]!);
  let s = '';
  for (const v of values) s += groupKey(v) + '|';
  return s;
}
