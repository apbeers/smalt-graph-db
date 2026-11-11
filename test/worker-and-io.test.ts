import { describe, expect, test } from 'vitest';
import { family, metro, network, social } from '../src/datasets/index.js';
import { open } from '../src/index.js';
import { createHandler } from '../src/worker/handler.js';

describe('JSON import and export', () => {
  test('a round trip keeps the graph', () => {
    const a = open();
    a.load(social());
    const b = open();
    b.load(JSON.parse(JSON.stringify(a.toJSON())));
    const q = 'MATCH (p:Person)-[k:KNOWS]->(q) RETURN p.name AS p, q.name AS q, k.since AS s ORDER BY p, q';
    expect(b.query(q)).toEqual(a.query(q));
    expect(b.store.indexes()).toEqual([{ label: 'Person', key: 'name' }]);
  });

  test('a bad file loads nothing', () => {
    const g = open();
    expect(() => g.load({ nodes: [{ id: 1 }], relationships: [{ start: 1, end: 2, type: 'R' }] })).toThrow(/isn't in the file/);
    expect(g.query('MATCH (n) RETURN count(n) AS c')).toEqual([{ c: 0 }]);
  });
});

describe('datasets', () => {
  test.each([
    ['family', family()],
    ['social', social()],
    ['metro', metro()],
    ['network', network(500)],
  ])('%s loads', (_n, data) => {
    const g = open();
    g.load(data);
    expect(g.store.stats().nodes).toBe(data.nodes.length);
    expect(g.store.stats().rels).toBe(data.relationships.length);
  });

  test('datasets are the same every time', () => {
    expect(JSON.stringify(metro())).toBe(JSON.stringify(metro()));
    expect(JSON.stringify(network(300))).toBe(JSON.stringify(network(300)));
  });

  test('metro has routes', () => {
    const g = open();
    g.load(metro());
    const [row] = g.query(
      "MATCH (:Line {name: 'Line 1'})<-[:ON]-(s) WITH collect(s) AS st WITH st[0] AS a, st[-1] AS b MATCH p = shortestPath((a)-[:CONNECTS*]->(b)) RETURN length(p) AS hops",
    );
    expect(row!.hops).toBeGreaterThan(0);
  });
});

describe('worker handler', () => {
  test('runs, loads, reports errors as data', () => {
    const h = createHandler();
    expect(h.handle({ id: 1, type: 'load', data: family() })).toMatchObject({ ok: true });
    const r = h.handle({ id: 2, type: 'run', cypher: "MATCH (p:Product)-[:BUILT_ON]->(:Product {name: 'smaltdb'}) RETURN count(p) AS c" });
    expect(r).toMatchObject({ id: 2, ok: true, result: { rows: [[5]] } });
    const bad = h.handle({ id: 3, type: 'run', cypher: 'MATCH (' });
    expect(bad).toMatchObject({ id: 3, ok: false, error: { code: 'SMALTCY_SYNTAX' } });
    const ov = h.handle({ id: 4, type: 'overview' });
    expect(ov.ok && (ov.result as { ids: number[] }).ids.length).toBe(family().nodes.length);
    // Results cross to the page by structured clone.
    expect(() => structuredClone(r)).not.toThrow();
  });
});

describe('sample datasets in the worker', () => {
  test('a run on a dataset starts from it as generated', () => {
    const h = createHandler();
    const social = { name: 'social' } as const;
    const count = () => h.handle({ id: 0, type: 'run', cypher: 'MATCH (p:Person) RETURN count(p) AS c', dataset: social });
    expect(count()).toMatchObject({ ok: true, result: { rows: [[12]] } });
    // A write changes the graph: the next run on the dataset loads it again.
    h.handle({ id: 1, type: 'run', cypher: "CREATE (:Person {name: 'New'})", dataset: social });
    expect(count()).toMatchObject({ result: { rows: [[12]] } });
    // Unchanged, it is kept.
    expect(h.handle({ id: 2, type: 'dataset', dataset: social })).toMatchObject({ ok: true, result: { reused: true, nodes: 22 } });
  });

  test('sizes and stores', () => {
    const h = createHandler();
    const r = h.handle({ id: 1, type: 'dataset', dataset: { name: 'network', size: 300, store: 'csr' } });
    expect(r).toMatchObject({ ok: true, result: { reused: false, nodes: 308 } });
    expect(h.graph.store.name).toBe('csr');
    expect(h.handle({ id: 2, type: 'run', cypher: 'CREATE (:X)' })).toMatchObject({ ok: false, error: { code: 'SMALTCY_UNSUPPORTED' } });
  });
});
