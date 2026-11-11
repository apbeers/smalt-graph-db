import { describe, expect, test } from 'vitest';
import { socialStores } from './helpers/graphs.js';

/**
 * Reading Cypher. Every case runs on every store: the same plan must give the same rows (in the same order where the
 * query orders them).
 */
const CASES: [string, string, unknown[]][] = [
  ['label scan', "MATCH (p:Person) RETURN p.name AS name ORDER BY name", [
    { name: 'Ada' }, { name: 'Alan' }, { name: 'Barbara' }, { name: 'Edsger' }, { name: 'Grace' },
  ]],
  ['all nodes', 'MATCH (n) RETURN count(n) AS n', [{ n: 7 }]],
  ['property in pattern', "MATCH (p:Person {name: 'Grace'}) RETURN p.born AS born", [{ born: 1906 }]],
  ['two labels', 'MATCH (p:Person:Admiral) RETURN p.name AS name', [{ name: 'Grace' }]],
  ['label predicate', 'MATCH (p) WHERE p:Admiral RETURN p.name AS name', [{ name: 'Grace' }]],
  ['one hop out', "MATCH (:Person {name: 'Alan'})-[:KNOWS]->(b) RETURN b.name AS name ORDER BY name", [{ name: 'Edsger' }, { name: 'Grace' }]],
  ['one hop in', "MATCH (:Person {name: 'Alan'})<-[:KNOWS]-(b) RETURN b.name AS name", [{ name: 'Ada' }]],
  ['either direction', "MATCH (:Person {name: 'Alan'})-[:KNOWS]-(b) RETURN b.name AS name ORDER BY name", [{ name: 'Ada' }, { name: 'Edsger' }, { name: 'Grace' }]],
  ['relationship property', "MATCH (a)-[r:KNOWS]->(b) WHERE r.since < 1940 RETURN a.name AS a, b.name AS b ORDER BY r.since", [
    { a: 'Ada', b: 'Alan' }, { a: 'Alan', b: 'Grace' },
  ]],
  ['type()', "MATCH (:Person {name: 'Ada'})-[r]->() RETURN type(r) AS t ORDER BY t", [{ t: 'KNOWS' }, { t: 'LIVES_IN' }]],
  ['type alternatives', "MATCH (:Person {name: 'Ada'})-[r:KNOWS|LIVES_IN]->(x) RETURN count(*) AS n", [{ n: 2 }]],
  ['two hops', "MATCH (a:Person {name: 'Ada'})-[:KNOWS]->()-[:KNOWS]->(c) RETURN c.name AS name ORDER BY name", [{ name: 'Edsger' }, { name: 'Grace' }]],
  ['triangle', "MATCH (a)-[:KNOWS]->(b)-[:KNOWS]->(c), (a)-[:KNOWS]->(c) RETURN a.name AS a, b.name AS b, c.name AS c", [{ a: 'Alan', b: 'Grace', c: 'Edsger' }]],
  ['shared neighbour', "MATCH (a:Person)-[:LIVES_IN]->(c:City)<-[:LIVES_IN]-(b:Person) WHERE a.name < b.name RETURN a.name AS a, b.name AS b, c.name AS city ORDER BY a", [
    { a: 'Ada', b: 'Alan', city: 'London' }, { a: 'Barbara', b: 'Grace', city: 'New York' },
  ]],
  ['variable length', "MATCH (:Person {name: 'Ada'})-[:KNOWS*]->(x) RETURN DISTINCT x.name AS name ORDER BY name", [
    { name: 'Alan' }, { name: 'Barbara' }, { name: 'Edsger' }, { name: 'Grace' },
  ]],
  ['variable length bounds', "MATCH (:Person {name: 'Ada'})-[:KNOWS*2..2]->(x) RETURN x.name AS name ORDER BY name", [{ name: 'Edsger' }, { name: 'Grace' }]],
  ['variable length zero', "MATCH (a:Person {name: 'Ada'})-[:KNOWS*0..1]->(x) RETURN x.name AS name ORDER BY name", [{ name: 'Ada' }, { name: 'Alan' }]],
  ['variable length paths count', "MATCH (:Person {name: 'Ada'})-[:KNOWS*]->(x:Person {name: 'Barbara'}) RETURN count(*) AS paths", [{ paths: 2 }]],
  ['relationship list', "MATCH (:Person {name: 'Ada'})-[rs:KNOWS*3]->(x {name: 'Edsger'}) RETURN [r IN rs | r.since] AS years", [{ years: [1833, 1936, 1950] }]],
  ['variable length with props', "MATCH (:Person {name: 'Ada'})-[:KNOWS*1..5 {since: 1833}]->(x) RETURN x.name AS name", [{ name: 'Alan' }]],
  ['named path', "MATCH p = (:Person {name: 'Ada'})-[:KNOWS]->(:Person)-[:KNOWS]->(c {name: 'Grace'}) RETURN length(p) AS len, [n IN nodes(p) | n.name] AS names", [
    { len: 2, names: ['Ada', 'Alan', 'Grace'] },
  ]],
  ['shortest path', "MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Barbara'}), p = shortestPath((a)-[:KNOWS*]->(b)) RETURN [n IN nodes(p) | n.name] AS names", [
    { names: ['Ada', 'Alan', 'Edsger', 'Barbara'] },
  ]],
  ['all shortest paths', "MATCH (a:Person {name: 'Ada'}), (c:City {name: 'New York'}), p = allShortestPaths((a)-[*]-(c)) RETURN length(p) AS len, count(*) AS n", [{ len: 3, n: 1 }]],
  ['all shortest paths, several', "MATCH (a:Person {name: 'Ada'}), (c:Person {name: 'Edsger'}), p = allShortestPaths((a)-[*]-(c)) RETURN length(p) AS len, count(*) AS n", [{ len: 2, n: 1 }]],
  ['all shortest paths, one route', "MATCH (a:City {name: 'London'}), (c:Person {name: 'Grace'}), p = allShortestPaths((a)-[*]-(c)) RETURN length(p) AS len, count(*) AS n", [{ len: 2, n: 1 }]],
  ['no shortest path', "MATCH (a:City {name: 'London'}), (b:Person {name: 'Barbara'}), p = shortestPath((a)-[*]->(b)) RETURN p", []],
  ['optional match', "MATCH (p:Person) OPTIONAL MATCH (p)-[:LIVES_IN]->(c) RETURN p.name AS name, c.name AS city ORDER BY name", [
    { name: 'Ada', city: 'London' }, { name: 'Alan', city: 'London' }, { name: 'Barbara', city: 'New York' },
    { name: 'Edsger', city: null }, { name: 'Grace', city: 'New York' },
  ]],
  ['optional match where', "MATCH (p:Person {name: 'Alan'}) OPTIONAL MATCH (p)-[r:KNOWS]->(q) WHERE r.since > 2000 RETURN p.name AS name, q", [{ name: 'Alan', q: null }]],
  ['count group', 'MATCH (p:Person)-[:LIVES_IN]->(c:City) RETURN c.name AS city, count(*) AS n ORDER BY city', [{ city: 'London', n: 2 }, { city: 'New York', n: 2 }]],
  ['aggregates', 'MATCH (p:Person) RETURN min(p.born) AS lo, max(p.born) AS hi, sum(p.born) AS s, avg(p.born) AS a, count(p.langs) AS withLangs', [
    { lo: 1815, hi: 1939, s: 9502, a: 1900.4, withLangs: 1 },
  ]],
  ['collect distinct', 'MATCH (:Person)-[:LIVES_IN]->(c) RETURN collect(DISTINCT c.name) AS cities', [{ cities: ['London', 'New York'] }]],
  ['count on empty', "MATCH (p:Nobody) RETURN count(p) AS n, collect(p) AS all", [{ n: 0, all: [] }]],
  ['grouping by key with no rows', "MATCH (p:Nobody) RETURN p.name AS name, count(*) AS n", []],
  ['aggregate expression', 'MATCH (p:Person) RETURN count(*) * 10 + 1 AS x', [{ x: 51 }]],
  ['with and where', 'MATCH (p:Person)-[:KNOWS]->(q) WITH p, count(q) AS out WHERE out > 1 RETURN p.name AS name, out', [{ name: 'Alan', out: 2 }]],
  ['with order limit', 'MATCH (p:Person) WITH p ORDER BY p.born DESC LIMIT 2 RETURN p.name AS name', [{ name: 'Barbara' }, { name: 'Edsger' }]],
  ['skip limit', 'MATCH (p:Person) RETURN p.name AS name ORDER BY name SKIP 1 LIMIT 2', [{ name: 'Alan' }, { name: 'Barbara' }]],
  ['order by hidden', 'MATCH (p:Person) RETURN p.name AS name ORDER BY p.born LIMIT 1', [{ name: 'Ada' }]],
  ['distinct', 'MATCH (:Person)-[:LIVES_IN]->(c) RETURN DISTINCT c.name AS name ORDER BY name', [{ name: 'London' }, { name: 'New York' }]],
  ['unwind', 'UNWIND [3, 1, 2] AS x RETURN x ORDER BY x DESC', [{ x: 3 }, { x: 2 }, { x: 1 }]],
  ['unwind and match', "UNWIND ['Ada', 'Grace'] AS n MATCH (p:Person {name: n}) RETURN p.born AS born", [{ born: 1815 }, { born: 1906 }]],
  ['pattern predicate', "MATCH (p:Person) WHERE NOT (p)-[:LIVES_IN]->() RETURN p.name AS name", [{ name: 'Edsger' }]],
  ['exists subquery', "MATCH (p:Person) WHERE EXISTS { MATCH (p)-[:KNOWS]->(q) WHERE q.born > 1925 } RETURN p.name AS name ORDER BY name", [{ name: 'Alan' }, { name: 'Edsger' }, { name: 'Grace' }]],
  ['pattern comprehension', "MATCH (p:Person {name: 'Alan'}) RETURN [(p)-[:KNOWS]->(q) | q.name] AS knows", [{ knows: ['Grace', 'Edsger'] }]],
  ['id lookup', 'MATCH (p) WHERE id(p) = 0 RETURN p.name AS name', [{ name: 'Ada' }]],
  ['in list', "MATCH (p:Person) WHERE p.name IN ['Ada', 'Edsger'] RETURN p.name AS name ORDER BY name", [{ name: 'Ada' }, { name: 'Edsger' }]],
  ['string ops', "MATCH (p:Person) WHERE p.name STARTS WITH 'A' AND p.name ENDS WITH 'a' RETURN p.name AS name", [{ name: 'Ada' }]],
  ['contains and regex', "MATCH (p:Person) WHERE p.name CONTAINS 'r' AND p.name =~ '[BG].*' RETURN p.name AS name ORDER BY name", [{ name: 'Barbara' }, { name: 'Grace' }]],
  ['is null', 'MATCH (p:Person) WHERE p.langs IS NOT NULL RETURN p.name AS name', [{ name: 'Ada' }]],
  ['chained comparison', 'MATCH (p:Person) WHERE 1900 < p.born < 1920 RETURN p.name AS name ORDER BY name', [{ name: 'Alan' }, { name: 'Grace' }]],
  ['case', "MATCH (p:Person) RETURN p.name AS name, CASE WHEN p.born < 1900 THEN 'old' ELSE 'new' END AS era ORDER BY p.born LIMIT 2", [
    { name: 'Ada', era: 'old' }, { name: 'Grace', era: 'new' },
  ]],
  ['labels and keys', "MATCH (p {name: 'Grace'}) RETURN labels(p) AS labels, keys(p) AS keys", [{ labels: ['Person', 'Admiral'], keys: ['name', 'born'] }]],
  ['degree', "MATCH (p:Person {name: 'Alan'}) RETURN degree(p) AS all, degree(p, 'out', 'KNOWS') AS knowsOut", [{ all: 4, knowsOut: 2 }]],
  ['quantifiers', "RETURN any(x IN [1, 2, 3] WHERE x > 2) AS a, all(x IN [1, 2] WHERE x > 0) AS b, none(x IN [1] WHERE x > 5) AS c, single(x IN [1, 2] WHERE x = 2) AS d", [
    { a: true, b: true, c: true, d: true },
  ]],
  ['union', "MATCH (p:Person {name: 'Ada'}) RETURN p.name AS name UNION MATCH (c:City {name: 'London'}) RETURN c.name AS name", [{ name: 'Ada' }, { name: 'London' }]],
  ['union dedups', 'RETURN 1 AS x UNION RETURN 1 AS x', [{ x: 1 }]],
  ['union all', 'RETURN 1 AS x UNION ALL RETURN 1 AS x', [{ x: 1 }, { x: 1 }]],
  ['parameters', 'MATCH (p:Person) WHERE p.born > $year RETURN count(*) AS n', [{ n: 2 }]],
  ['return star', "MATCH (c:City {name: 'London'}) WITH c.name AS city, 1 AS one RETURN *", [{ city: 'London', one: 1 }]],
];

describe.each(socialStores())('%s store', (_name, g) => {
  test.each(CASES)('%s', (_label, query, expected) => {
    expect(g.query(query, { year: 1925 })).toEqual(expected);
  });

  test('nodes and relationships in results', () => {
    const [row] = g.query("MATCH (a:Person {name: 'Ada'})-[r:KNOWS]->(b) RETURN a, r, b");
    expect(row!.a).toMatchObject({ kind: 'node', labels: ['Person'], properties: { name: 'Ada', born: 1815, langs: ['en', 'fr'] } });
    expect(row!.r).toMatchObject({ kind: 'relationship', type: 'KNOWS', properties: { since: 1833 } });
    const r = row!.r as { start: number; end: number };
    expect([r.start, r.end]).toEqual([(row!.a as { id: number }).id, (row!.b as { id: number }).id]);
  });

  test('paths in results', () => {
    const [row] = g.query("MATCH p = (:Person {name: 'Ada'})-[:KNOWS]->(b) RETURN p");
    const p = row!.p as { kind: string; nodes: { properties: { name: string } }[]; relationships: unknown[] };
    expect(p.kind).toBe('path');
    expect(p.nodes.map((n) => n.properties.name)).toEqual(['Ada', 'Alan']);
    expect(p.relationships).toHaveLength(1);
  });

  test('relationships are distinct within a match', () => {
    // a-[r1]-b-[r2]-c can't use the same relationship twice, so a and c differ.
    const rows = g.query("MATCH (a:Person {name: 'Ada'})-[:KNOWS]-(b)-[:KNOWS]-(c) RETURN c.name AS name ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(['Edsger', 'Grace']);
  });

  test('EXPLAIN shows the steps', () => {
    const text = g.explain("MATCH (a:Person {name: 'Ada'})-[:KNOWS]->(b) RETURN b.name");
    expect(text).toContain('Match');
    expect(text).toContain('Expand(All)');
  });
});
