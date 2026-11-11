import { describe, expect, test } from 'vitest';
import { CsrStore, MemoryStore, open, type GraphStore } from '../src/index.js';
import { randomGraph } from './helpers/graphs.js';

/**
 * Every store answers the store interface the same way. A new store adds itself to STORES and must pass all of this,
 * plus the Cypher suites (test/cypher-read.test.ts) and the differential test below.
 */
function base(): MemoryStore {
  const s = new MemoryStore();
  const a = s.createNode(['A', 'B'], { x: 1, s: 'one' });
  const b = s.createNode(['A'], { x: 2 });
  const c = s.createNode([], {});
  s.createRel('R', a, b, { w: 1 });
  s.createRel('S', b, a, {});
  s.createRel('R', c, c, {});
  return s;
}

const STORES: [string, () => GraphStore][] = [
  ['memory', base],
  ['csr', () => CsrStore.from(base())],
];

describe.each(STORES)('%s', (_name, make) => {
  test('stats', () => {
    const st = make().stats();
    expect(st.nodes).toBe(3);
    expect(st.rels).toBe(3);
    expect(st.labels.get('A')).toBe(2);
    expect(st.types.get('R')).toBe(2);
  });

  test('scan nodes, with and without a label, and stop early', () => {
    const s = make();
    const all: number[] = [];
    s.scanNodes(null, (n) => void all.push(n));
    expect(all).toEqual([0, 1, 2]);
    const a: number[] = [];
    s.scanNodes('A', (n) => void a.push(n));
    expect(a.sort()).toEqual([0, 1]);
    let seen = 0;
    s.scanNodes(null, () => (seen++, false));
    expect(seen).toBe(1);
    s.scanNodes('Nope', () => {
      throw new Error('no nodes');
    });
  });

  test('labels and properties', () => {
    const s = make();
    expect(s.labels(0)).toEqual(['A', 'B']);
    expect(s.hasLabel(0, 'B')).toBe(true);
    expect(s.hasLabel(1, 'B')).toBe(false);
    expect(s.nodeProperty(0, 's')).toBe('one');
    expect(s.nodeProperty(0, 'nope')).toBeUndefined();
    expect(s.nodeProperties(1)).toEqual({ x: 2 });
    expect(s.hasNode(2)).toBe(true);
    expect(s.hasNode(99)).toBe(false);
  });

  test('relationships', () => {
    const s = make();
    expect(s.relType(0)).toBe('R');
    expect([s.relStart(1), s.relEnd(1)]).toEqual([1, 0]);
    expect(s.relProperties(0)).toEqual({ w: 1 });
    const r: number[] = [];
    s.scanRels(['R'], (id) => void r.push(id));
    expect(r).toEqual([0, 2]);
  });

  test('expand in every direction, with types', () => {
    const s = make();
    const adj = (n: number, dir: 'out' | 'in' | 'both', types: string[] | null) => {
      const out: [number, number][] = [];
      s.expand(n, dir, types, (r, o) => void out.push([r, o]));
      return out;
    };
    expect(adj(0, 'out', null)).toEqual([[0, 1]]);
    expect(adj(0, 'in', null)).toEqual([[1, 1]]);
    expect(adj(0, 'both', null)).toEqual([[0, 1], [1, 1]]);
    expect(adj(0, 'both', ['S'])).toEqual([[1, 1]]);
    expect(adj(0, 'both', ['Nope'])).toEqual([]);
    // A self-loop: once each way, once for both.
    expect(adj(2, 'out', null)).toEqual([[2, 2]]);
    expect(adj(2, 'in', null)).toEqual([[2, 2]]);
    expect(adj(2, 'both', null)).toEqual([[2, 2]]);
    expect(s.degree(0, 'both', null)).toBe(2);
    expect(s.degree(2, 'both', null)).toBe(1);
  });

  test('property lookups', () => {
    const s = make();
    const found = s.nodesByProperty('A', 'x', 2);
    if (s.capabilities.propertyIndexes === 'all') expect(found).toEqual([1]);
    else expect(found === null || found.length === 1).toBe(true);
  });
});

describe('differential: every store gives the same rows', () => {
  const QUERIES = [
    'MATCH (a:A)-[:X]->(b) RETURN a.i AS a, b.i AS b ORDER BY a, b',
    'MATCH (a)-[r]-(b) WHERE r.w > 5 RETURN count(*) AS c',
    'MATCH (a:A {g: 3})-[:X*1..3]->(b:B) RETURN count(*) AS c',
    'MATCH (a)-[:Y]->(b)-[:Y]->(c) WHERE a.g = c.g RETURN a.i AS a, c.i AS c ORDER BY a, c LIMIT 50',
    'MATCH (n) OPTIONAL MATCH (n)-[:X]->(m:A) RETURN n.g AS g, count(m) AS c ORDER BY g',
    'MATCH (a {i: 1}), (b {i: 40}), p = shortestPath((a)-[*..10]-(b)) RETURN length(p) AS len',
    'MATCH (a)-[:X]->(b), (b)-[:X]->(a) WHERE a.i < b.i RETURN a.i AS a, b.i AS b ORDER BY a, b',
    'MATCH (n:B) WHERE size([(n)-->(m) | m]) > 3 RETURN n.i AS i ORDER BY i',
  ];
  test.each([1, 2, 3])('seed %i', (seed) => {
    const mem = randomGraph(120, 600, seed);
    const csr = open({ store: CsrStore.from(mem.store) });
    for (const q of QUERIES) expect(csr.query(q), q).toEqual(mem.query(q));
  });
});
