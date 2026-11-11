import { describe, expect, test } from 'vitest';
import { CsrStore, SmaltcyError, open } from '../src/index.js';
import { social } from './helpers/graphs.js';

describe('CREATE', () => {
  test('nodes, relationships and counts', () => {
    const g = open();
    const r = g.run("CREATE (a:A {x: 1})-[:R {w: 2}]->(b:B), (b)-[:R]->(:C) RETURN a.x AS x");
    expect(r.rows).toEqual([[1]]);
    expect(r.counts).toMatchObject({ nodesCreated: 3, relationshipsCreated: 2, labelsAdded: 3, propertiesSet: 2 });
    expect(g.query('MATCH (:A)-[:R]->(:B)-[:R]->(c) RETURN labels(c) AS l')).toEqual([{ l: ['C'] }]);
  });

  test('per input row', () => {
    const g = open();
    g.run('UNWIND range(1, 5) AS i CREATE (:N {i: i})');
    expect(g.query('MATCH (n:N) RETURN sum(n.i) AS s')).toEqual([{ s: 15 }]);
  });

  test('between matched nodes', () => {
    const g = social();
    g.run("MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Barbara'}) CREATE (a)-[:KNOWS {since: 2000}]->(b)");
    expect(g.query("MATCH (:Person {name: 'Ada'})-[:KNOWS]->(b) RETURN b.name AS n ORDER BY n")).toEqual([{ n: 'Alan' }, { n: 'Barbara' }]);
  });

  test('reads before writes: MATCH then CREATE sees only what was there', () => {
    const g = open();
    g.run('CREATE (:N), (:N)');
    g.run('MATCH (n:N) CREATE (:N)');
    expect(g.query('MATCH (n:N) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });

  test('a relationship needs a type and a direction', () => {
    expect(() => open().run('CREATE (a)-[:R]-(b)')).toThrow(/direction/);
    expect(() => open().run('CREATE (a)-[r]->(b)')).toThrow(/one type/);
  });

  test('properties must be storable', () => {
    expect(() => open().run('CREATE (a {m: {x: 1}})')).toThrow(SmaltcyError);
  });
});

describe('MERGE', () => {
  test('matches or creates', () => {
    const g = open();
    g.run("MERGE (n:Person {name: 'Ada'}) ON CREATE SET n.created = true");
    g.run("MERGE (n:Person {name: 'Ada'}) ON MATCH SET n.seen = true");
    expect(g.query('MATCH (n:Person) RETURN n.created AS c, n.seen AS s')).toEqual([{ c: true, s: true }]);
  });

  test('sees its own creations on later rows', () => {
    const g = open();
    g.run('UNWIND [1, 2, 1, 3, 2] AS v MERGE (:V {v: v})');
    expect(g.query('MATCH (n:V) RETURN count(*) AS c')).toEqual([{ c: 3 }]);
  });

  test('relationships between bound nodes', () => {
    const g = open();
    g.run('CREATE (:A {id: 1}), (:B {id: 2})');
    g.run('MATCH (a:A), (b:B) MERGE (a)-[:R]->(b)');
    g.run('MATCH (a:A), (b:B) MERGE (a)-[:R]->(b)');
    expect(g.query('MATCH ()-[r:R]->() RETURN count(r) AS c')).toEqual([{ c: 1 }]);
  });
});

describe('SET, REMOVE, DELETE', () => {
  test('properties and labels', () => {
    const g = social();
    g.run("MATCH (p:Person {name: 'Ada'}) SET p.title = 'Countess', p:Mathematician, p.born = null");
    expect(g.query("MATCH (p:Mathematician) RETURN p.title AS t, p.born AS b")).toEqual([{ t: 'Countess', b: null }]);
    g.run("MATCH (p:Person {name: 'Ada'}) REMOVE p.title, p:Mathematician");
    expect(g.query("MATCH (p:Person {name: 'Ada'}) RETURN p.title AS t, labels(p) AS l")).toEqual([{ t: null, l: ['Person'] }]);
  });

  test('replace and merge maps', () => {
    const g = open();
    g.run("CREATE (:N {a: 1, b: 2})");
    g.run('MATCH (n:N) SET n += {b: 3, c: 4}');
    expect(g.query('MATCH (n:N) RETURN properties(n) AS p')).toEqual([{ p: { a: 1, b: 3, c: 4 } }]);
    g.run('MATCH (n:N) SET n = {z: 9}');
    expect(g.query('MATCH (n:N) RETURN properties(n) AS p')).toEqual([{ p: { z: 9 } }]);
  });

  test('delete needs DETACH when relationships remain', () => {
    const g = social();
    expect(() => g.run("MATCH (p:Person {name: 'Ada'}) DELETE p")).toThrow(/DETACH/);
    const r = g.run("MATCH (p:Person {name: 'Ada'}) DETACH DELETE p");
    expect(r.counts).toMatchObject({ nodesDeleted: 1, relationshipsDeleted: 2 });
    expect(g.query('MATCH (p:Person) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
  });

  test('delete relationships', () => {
    const g = social();
    g.run('MATCH ()-[r:LIVES_IN]->() DELETE r');
    expect(g.query('MATCH ()-[r:LIVES_IN]->() RETURN count(r) AS c')).toEqual([{ c: 0 }]);
  });
});

describe('transactions', () => {
  test('a failing statement changes nothing', () => {
    const g = social();
    // The CREATE happens, then the DELETE fails: both are undone.
    expect(() => g.run("CREATE (:Temp) WITH 1 AS x MATCH (p:Person {name: 'Ada'}) DELETE p")).toThrow();
    expect(g.query('MATCH (t:Temp) RETURN count(t) AS c')).toEqual([{ c: 0 }]);
  });

  test('transaction() commits together or not at all', () => {
    const g = open();
    expect(() =>
      g.transaction((t) => {
        t.run('CREATE (:X)');
        t.run('CREATE (:X)');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(g.query('MATCH (x:X) RETURN count(x) AS c')).toEqual([{ c: 0 }]);
    g.transaction((t) => {
      t.run('CREATE (:X)');
      t.run('CREATE (:X)');
    });
    expect(g.query('MATCH (x:X) RETURN count(x) AS c')).toEqual([{ c: 2 }]);
  });

  test('undo restores indexes', () => {
    const g = open();
    g.run('CREATE INDEX FOR (n:P) ON (n.k)');
    g.run("CREATE (:P {k: 'a'})");
    expect(() => g.run("MATCH (p:P {k: 'a'}) SET p.k = 'b' WITH p RETURN 1/0")).toThrow(/zero/);
    expect(g.query("MATCH (p:P {k: 'a'}) RETURN count(p) AS c")).toEqual([{ c: 1 }]);
    expect(g.query("MATCH (p:P {k: 'b'}) RETURN count(p) AS c")).toEqual([{ c: 0 }]);
  });
});

describe('indexes', () => {
  test('the planner seeks with an index and finds the same rows', () => {
    const g = social();
    const q = "MATCH (p:Person {name: 'Grace'}) RETURN p.born AS b";
    expect(g.explain(q)).toContain('NodeByLabelScan+Filter');
    g.run('CREATE INDEX FOR (p:Person) ON (p.name)');
    expect(g.explain(q)).toContain('NodeIndexSeek');
    expect(g.query(q)).toEqual([{ b: 1906 }]);
    // Writes keep the index up to date.
    g.run("MATCH (p:Person {name: 'Grace'}) SET p.name = 'Grace H'");
    expect(g.query(q)).toEqual([]);
    expect(g.query("MATCH (p:Person {name: 'Grace H'}) RETURN p.born AS b")).toEqual([{ b: 1906 }]);
    g.run('DROP INDEX ON :Person(name)');
    expect(g.explain(q)).not.toContain('NodeIndexSeek');
  });
});

describe('read-only stores', () => {
  test('writes fail on CsrStore', () => {
    const g = open({ store: CsrStore.from(social().store) });
    expect(() => g.run('CREATE (:X)')).toThrow(/read-only/);
  });
});
