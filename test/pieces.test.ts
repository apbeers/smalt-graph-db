import { describe, expect, test } from 'vitest';
import { registerAggregate, registerFunction, scalarFunctions, aggregateFunctions } from '@smaltworks/smaltcy/functions';
import { open } from '@smaltworks/smaltcy';
import { compile } from '@smaltworks/smaltcy/cypher';
import { GraphEngine } from '@smaltworks/smaltcy/engine';
import { CsrStore, MemoryStore } from '@smaltworks/smaltcy/store';
import { resultsToGraph } from '@smaltworks/smaltcy/render';
import { social } from '@smaltworks/smaltcy/datasets';

/** The pieces used on their own and together, as docs/guide/modules.md shows them. */
describe('the function library', () => {
  test('a registered function is callable from Cypher, in any letter case', () => {
    registerFunction('test_shout', { arity: [1, 1], fn: ([v]) => (typeof v === 'string' ? v.toUpperCase() + '!' : null) });
    registerAggregate('test_longest', {
      arity: [1, 1],
      init: () => ({ v: null as string | null }),
      step: (s, [v]) => {
        const st = s as { v: string | null };
        if (typeof v === 'string' && (st.v === null || v.length > st.v.length)) st.v = v;
        return s;
      },
      final: (s) => (s as { v: string | null }).v,
    });
    try {
      const g = open();
      g.load(social());
      expect(g.query("RETURN TEST_SHOUT('hi') AS v")).toEqual([{ v: 'HI!' }]);
      expect(g.query('MATCH (p:Person) RETURN test_longest(p.name) AS v')).toEqual([{ v: 'Margaret' }]);
    } finally {
      scalarFunctions.delete('test_shout');
      aggregateFunctions.delete('test_longest');
    }
  });

  test('bad names are refused', () => {
    expect(() => registerFunction('no spaces', { arity: [0, 0], fn: () => null })).toThrow(/Bad function name/);
  });
});

describe('Cypher, the engine and stores apart', () => {
  test('compile once, run on any engine and store', () => {
    const { plan } = compile("MATCH (p:Person)-[:LIVES_IN]->(:City {name: 'London'}) RETURN p.name AS name ORDER BY name");
    const json = JSON.stringify(plan); // a plan travels as JSON
    const mem = new MemoryStore();
    const g = new GraphEngine(mem);
    open({ store: mem }).load(social());
    const a = g.run(JSON.parse(json)).rows;
    const b = new GraphEngine(CsrStore.from(mem)).run(JSON.parse(json)).rows;
    expect(a).toEqual([['Ada'], ['Alan'], ['Tim']]);
    expect(b).toEqual(a);
  });
});

describe('resultsToGraph', () => {
  const g = open();
  g.load(social());

  test('nodes, relationships and paths, nested anywhere, once each', () => {
    const rows = g.run("MATCH p = (:Person {name: 'Ada'})-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN p, {friend: b}, [c]").rows;
    const { graph, nodes, relationships } = resultsToGraph(rows);
    expect(nodes.map((n) => n.properties.name).sort()).toEqual(['Ada', 'Alan', 'Edsger', 'Grace']);
    expect(relationships).toHaveLength(3);
    expect(graph.nodes.map((n) => n.label).sort()).toEqual(['Ada', 'Alan', 'Edsger', 'Grace']);
    for (const e of graph.edges) {
      expect(graph.nodes[e.source]).toBeDefined();
      expect(graph.nodes[e.target]).toBeDefined();
    }
    // A hit's index finds its element.
    const i = graph.nodes.findIndex((n) => n.label === 'Ada');
    expect(nodes[i]!.labels).toEqual(['Person']);
  });

  test('relationships bring their ends; options set captions and groups', () => {
    const rows = g.run("MATCH (:Person {name: 'Ada'})-[r:LIVES_IN]->() RETURN r").rows;
    const { graph } = resultsToGraph(rows, { caption: (n) => `#${n.id}`, group: () => 'all' });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ source: 0, target: 1, label: 'LIVES_IN', group: 'LIVES_IN' }]);
    expect(graph.nodes.every((n) => n.group === 'all' && n.label!.startsWith('#'))).toBe(true);
  });

  test('no graph values: an empty graph', () => {
    expect(resultsToGraph(g.run('RETURN 1 AS x').rows).graph).toEqual({ nodes: [], edges: [] });
  });
});
