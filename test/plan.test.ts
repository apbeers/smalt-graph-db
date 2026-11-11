import { describe, expect, test } from 'vitest';
import { GraphEngine, MemoryStore, PLAN_VERSION, e, validatePlan, type QueryPlan } from '../src/engine/index.js';

/** Plans built by hand, with no language: the engine's contract. */
function store() {
  const s = new MemoryStore();
  const a = s.createNode(['P'], { name: 'a' });
  const b = s.createNode(['P'], { name: 'b' });
  const c = s.createNode(['P'], { name: 'c' });
  s.createRel('R', a, b, {});
  s.createRel('R', b, c, {});
  return s;
}

const twoHops: QueryPlan = {
  kind: 'query',
  planVersion: PLAN_VERSION,
  slots: 4,
  slotNames: ['x', 'r1', 'y', 'r2'],
  root: {
    op: 'project',
    discard: false,
    items: [{ slot: 2, expr: e.prop(e.slot(2), 'name') }],
    input: {
      op: 'match',
      optional: false,
      input: { op: 'argument', slots: [] },
      pattern: {
        nodes: [{ slot: 0, labels: ['P'], props: e.map({ name: e.lit('a') }) }, { slot: 2, labels: [] }],
        rels: [{ slot: 1, from: 0, to: 1, dir: 'out', types: ['R'], min: 2, max: 2 }],
      },
    },
  },
  columns: [{ name: 'name', slot: 2 }],
};

describe('hand-built plans', () => {
  test('run with no language', () => {
    const g = new GraphEngine(store());
    expect(g.run(twoHops).rows).toEqual([['c']]);
  });

  test('plans are JSON: a round trip runs the same', () => {
    const g = new GraphEngine(store());
    const copy = JSON.parse(JSON.stringify(twoHops)) as QueryPlan;
    expect(g.run(copy).rows).toEqual(g.run(twoHops).rows);
  });

  test('EXPLAIN lists the physical steps', () => {
    const g = new GraphEngine(store());
    expect(g.explainText(twoHops)).toMatch(/VarLengthExpand/);
  });
});

describe('validation', () => {
  const bad = (p: unknown) => () => validatePlan(p as QueryPlan);

  test('version', () => {
    expect(bad({ ...twoHops, planVersion: 99 })).toThrow(/planVersion/);
  });

  test('slots out of range', () => {
    expect(bad({ ...twoHops, columns: [{ name: 'x', slot: 9 }] })).toThrow(/outside/);
  });

  test('reading an unbound slot', () => {
    const p: QueryPlan = { kind: 'query', planVersion: PLAN_VERSION, slots: 2, root: { op: 'filter', input: { op: 'argument', slots: [] }, pred: e.eq(e.slot(1), e.lit(1)) }, columns: [] };
    expect(bad(p)).toThrow(/isn't bound/);
  });

  test('unknown functions and arity', () => {
    const mk = (fn: string, n: number): QueryPlan => ({
      kind: 'query', planVersion: PLAN_VERSION, slots: 1,
      root: { op: 'project', discard: false, input: { op: 'argument', slots: [] }, items: [{ slot: 0, expr: { k: 'call', fn, args: Array(n).fill(e.lit(1)) } }] },
      columns: [{ name: 'x', slot: 0 }],
    });
    expect(bad(mk('nope', 1))).toThrow(/unknown function/);
    expect(bad(mk('abs', 2))).toThrow(/takes 1/);
    expect(bad(mk('abs', 1))).not.toThrow();
  });

  test('pattern indexes', () => {
    const p = JSON.parse(JSON.stringify(twoHops));
    p.root.input.pattern.rels[0].to = 5;
    expect(bad(p)).toThrow(/ends/);
  });
});
