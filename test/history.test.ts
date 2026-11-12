import { describe, expect, test } from 'vitest';
import { open, SmaltcyError, type Graph } from '@smaltworks/smaltcy';
import { HistoryStore, snapshotOf, type GraphDiff, type GraphSnapshot } from '@smaltworks/smaltcy/history';
import { network, ontology, social } from '@smaltworks/smaltcy/datasets';
import { createHandler } from '@smaltworks/smaltcy/worker-runtime';

/** A snapshot in a canonical order, for comparing. */
function canon(s: GraphSnapshot): unknown {
  const sortKeys = (o: object) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    nodes: [...s.nodes].sort((a, b) => a.id - b.id).map((n) => ({ id: n.id, labels: [...n.labels].sort(), props: sortKeys(n.props) })),
    rels: [...s.relationships].sort((a, b) => a.id - b.id).map((r) => ({ ...r, props: sortKeys(r.props) })),
  };
}

/** Applies a diff to a snapshot: what a drawing does as a timeline moves. */
function applyDiff(s: GraphSnapshot, d: GraphDiff): GraphSnapshot {
  const nodes = new Map(s.nodes.map((n) => [n.id, { id: n.id, labels: new Set(n.labels), props: { ...n.props } as Record<string, unknown> }]));
  const rels = new Map(s.relationships.map((r) => [r.id, { ...r, props: { ...r.props } as Record<string, unknown> }]));
  for (const id of d.relsRemoved) rels.delete(id);
  for (const id of d.nodesRemoved) nodes.delete(id);
  for (const n of d.nodesAdded) nodes.set(n.id, { id: n.id, labels: new Set(n.labels), props: { ...n.props } });
  for (const r of d.relsAdded) rels.set(r.id, { ...r, props: { ...r.props } });
  for (const c of d.nodesChanged) {
    const n = nodes.get(c.id)!;
    for (const [k, v] of Object.entries(c.set)) v === null ? delete n.props[k] : (n.props[k] = v);
    for (const l of c.labelsAdded) n.labels.add(l);
    for (const l of c.labelsRemoved) n.labels.delete(l);
  }
  for (const c of d.relsChanged) {
    const r = rels.get(c.id)!;
    for (const [k, v] of Object.entries(c.set)) v === null ? delete r.props[k] : (r.props[k] = v);
  }
  return {
    version: d.to,
    nodes: [...nodes.values()].map((n) => ({ id: n.id, labels: [...n.labels], props: n.props as never })),
    relationships: [...rels.values()].map((r) => r as never),
  };
}

/** Random writes, one commit each (some in multi-statement transactions, some rolled back), recording every version. */
function randomHistory(seed: number, commits: number, checkpointEvery = 7): { g: Graph; versions: GraphSnapshot[] } {
  let s = seed;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
  let t = Date.UTC(2026, 0, 1);
  const g = open({ history: { checkpointEvery, clock: () => (t += 60_000), author: 'test' } });
  const versions: GraphSnapshot[] = [snapshotOf(g.store, 0)];
  const statements = [
    () => `CREATE (:${pick(['A', 'B', 'C'])} {k: ${Math.floor(rand() * 5)}, name: 'n${Math.floor(rand() * 1000)}'})`,
    () => `MATCH (a), (b) WHERE id(a) = ${Math.floor(rand() * 40)} AND id(b) = ${Math.floor(rand() * 40)} CREATE (a)-[:R {w: ${Math.floor(rand() * 9)}}]->(b)`,
    () => `MATCH (n) WHERE id(n) % 3 = ${Math.floor(rand() * 3)} SET n.k = ${Math.floor(rand() * 9)}`,
    () => `MATCH (n:A) WHERE n.k = ${Math.floor(rand() * 5)} SET n:Tagged REMOVE n.name`,
    () => `MATCH (n:Tagged) REMOVE n:Tagged SET n.name = 'back'`,
    () => `MATCH (n) WHERE id(n) = ${Math.floor(rand() * 40)} DETACH DELETE n`,
    () => `MATCH ()-[r:R]->() WHERE r.w = ${Math.floor(rand() * 9)} DELETE r`,
    () => `MATCH ()-[r:R]->() WHERE r.w > 4 SET r.w = r.w - 1, r.seen = true`,
  ];
  while (g.version! < commits) {
    const before = g.version!;
    const roll = rand();
    if (roll < 0.1) {
      // A transaction that fails changes nothing and makes no version.
      expect(() => g.transaction((tx) => {
        tx.run(pick(statements)());
        throw new Error('stop');
      })).toThrow('stop');
      expect(g.version).toBe(before);
      continue;
    }
    if (roll < 0.25) g.transaction((tx) => { tx.run(pick(statements)()); tx.run(pick(statements)()); }, { message: 'two at once' });
    else g.run(pick(statements)(), {}, rand() < 0.5 ? { author: pick(['ana', 'bo']), message: 'edit' } : {});
    if (g.version! > before) {
      expect(g.version).toBe(before + 1);
      versions.push(snapshotOf(g.store, g.version!));
    }
  }
  return { g, versions };
}

describe('history: every version as it was', () => {
  test.each([1, 2, 3])('seed %i: at(v) is the graph as it was at every version', (seed) => {
    const { g, versions } = randomHistory(seed, 60);
    for (const snap of versions) expect(canon(snapshotOf(g.history!.at(snap.version), snap.version)), `version ${snap.version}`).toEqual(canon(snap));
  });

  test('a diff, applied, turns one version into the other, both ways', () => {
    const { g, versions } = randomHistory(9, 50);
    let s = 5;
    const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 80; i++) {
      const a = versions[Math.floor(rand() * versions.length)]!;
      const b = versions[Math.floor(rand() * versions.length)]!;
      expect(canon(applyDiff(a, g.diff(a.version, b.version))), `${a.version} → ${b.version}`).toEqual(canon(b));
    }
  });

  test('a history survives JSON, every version and every id', () => {
    const { g, versions } = randomHistory(4, 40);
    const copy = open({ history: true });
    copy.load(JSON.parse(JSON.stringify(g.toJSON())));
    expect(copy.version).toBe(g.version);
    expect(copy.commits()).toEqual(g.commits());
    for (const snap of versions) expect(canon(snapshotOf(copy.history!.at(snap.version), snap.version))).toEqual(canon(snap));
    // And the copy goes on from where it was.
    copy.run('CREATE (:New)');
    expect(copy.version).toBe(g.version! + 1);
  });

  test('forget() drops old versions and keeps the rest exact', () => {
    const { g, versions } = randomHistory(6, 30);
    (g.store as HistoryStore).forget(10);
    expect(() => g.history!.at(9)).toThrow(SmaltcyError);
    for (const snap of versions.filter((v) => v.version >= 10)) expect(canon(snapshotOf(g.history!.at(snap.version), snap.version))).toEqual(canon(snap));
    expect(g.commits()[0]!.version).toBe(11);
  });
});

describe('commits', () => {
  test('carry time, author, message and counts; only writes make one', () => {
    let t = 1_000;
    const g = open({ history: { author: 'system', clock: () => (t += 10) } });
    g.run("CREATE (:Person {name: 'Ada'})");
    g.run('MATCH (n) RETURN n'); // a read: no version
    g.run("MATCH (p:Person) SET p.born = 1815", {}, { author: 'ana', message: 'Add birth year' });
    g.run("MATCH (p:Person) SET p.born = 1815"); // the same value: no change, no version
    expect(g.version).toBe(2);
    const [a, b] = g.commits();
    expect(a).toMatchObject({ version: 1, author: 'system', size: 1, nodes: 1, counts: { nodesCreated: 1 } });
    expect(b).toMatchObject({ version: 2, author: 'ana', message: 'Add birth year', counts: { propertiesSet: 1 } });
    expect(b!.time).toBeGreaterThan(a!.time);
    expect(g.history!.versionAt(a!.time)).toBe(1);
    expect(g.history!.versionAt(0)).toBe(0);
  });

  test('a graph without history says so', () => {
    expect(() => open().commits()).toThrow(/no history/);
    expect(() => open().query('AT VERSION 1 MATCH (n) RETURN n')).toThrow(/keeps no history/);
  });
});

describe('temporal Cypher', () => {
  function evolving() {
    let t = Date.UTC(2026, 10, 1);
    const g = open({ history: { clock: () => (t += 86_400_000), author: 'ana' } }); // a day apart
    g.load(social(), { message: 'Load the social graph' }); // version 1
    g.run("MATCH (p:Person {name: 'Ada'}) SET p.title = 'Countess'", {}, { message: 'Add title' }); // 2
    g.run("MATCH (p:Person {name: 'Tim'}) DETACH DELETE p", {}, { author: 'bo', message: 'Remove Tim' }); // 3
    g.run("CREATE (:Person {name: 'Hedy', born: 1914})", {}, { message: 'Add Hedy' }); // 4
    return g;
  }

  test('AT VERSION reads the graph as it was', () => {
    const g = evolving();
    const people = (q: string, p = {}) => g.query(q, p).map((r) => r.name).sort();
    expect(people('MATCH (p:Person) RETURN p.name AS name')).toContain('Hedy');
    expect(people('AT VERSION 2 MATCH (p:Person) RETURN p.name AS name')).toContain('Tim');
    expect(people('AT VERSION 2 MATCH (p:Person) RETURN p.name AS name')).not.toContain('Hedy');
    expect(g.query('AT VERSION 0 MATCH (n) RETURN count(n) AS n')).toEqual([{ n: 0 }]);
    expect(g.query('AT VERSION $v MATCH (p:Person {name: $n}) RETURN p.title AS t', { v: 1, n: 'Ada' })).toEqual([{ t: null }]);
    expect(g.run('AT VERSION 3 MATCH (n) RETURN count(n) AS n').version).toBe(3);
  });

  test('AT TIME reads the last version at a moment', () => {
    const g = evolving();
    const v3 = g.commits()[2]!;
    expect(g.run('AT TIME $t MATCH (n) RETURN count(n) AS n', { t: v3.time + 1000 }).version).toBe(3);
    expect(g.run(`AT TIME '${new Date(v3.time).toISOString()}' MATCH (n) RETURN 1 AS x`).version).toBe(3);
    expect(g.run("AT TIME '2000-01-01' MATCH (n) RETURN count(n) AS n").rows).toEqual([[0]]);
  });

  test('graph.at() gives a read-only graph every query works on', () => {
    const g = evolving();
    const past = g.at(2);
    expect(past.query("MATCH (a:Person {name: 'Ada'})-[:KNOWS*1..2]->(f) RETURN count(DISTINCT f) AS n")).toEqual(g.query("AT VERSION 2 MATCH (a:Person {name: 'Ada'})-[:KNOWS*1..2]->(f) RETURN count(DISTINCT f) AS n"));
    expect(() => past.run('CREATE (:X)')).toThrow(/read-only/);
    expect(g.at(new Date(g.commits()[0]!.time)).version).toBe(1);
  });

  test("the past can't be written", () => {
    expect(() => evolving().run('AT VERSION 1 CREATE (:X)')).toThrow(/read the past/);
  });

  test('version(), commits(), commit() and history()', () => {
    const g = evolving();
    expect(g.query('RETURN version() AS v')).toEqual([{ v: 4 }]);
    expect(g.query('AT VERSION 2 RETURN version() AS v, size(commits()) AS n')).toEqual([{ v: 2, n: 2 }]);
    expect(g.query("UNWIND commits() AS c WITH c WHERE c.author = 'bo' RETURN c.message AS m")).toEqual([{ m: 'Remove Tim' }]);
    expect(g.query('RETURN commit(2).message AS m, commit(99) AS none')).toEqual([{ m: 'Add title', none: null }]);
    const [h] = g.query("MATCH (p:Person {name: 'Ada'}) RETURN [c IN history(p) | c.change + ' ' + coalesce(c.key, '') + ' @' + toString(c.version)] AS h");
    expect(h!.h).toEqual(['created  @1', 'set title @2']);
    // The past's history stops at its version.
    expect(g.query("AT VERSION 1 MATCH (p:Person {name: 'Ada'}) RETURN size(history(p)) AS n")).toEqual([{ n: 1 }]);
    expect(open().query('RETURN version() AS v, commits() AS c')).toEqual([{ v: null, c: null }]);
  });

  test('EXPLAIN shows the version read', () => {
    expect(evolving().explain('AT VERSION 2 MATCH (n) RETURN n')).toBeDefined();
    const r = evolving().run('EXPLAIN AT VERSION 2 MATCH (n) RETURN n');
    expect(String(r.rows[0]![0])).toMatch(/AsOf  version 2/);
  });
});

describe('datasets with history', () => {
  test('the network grows a person at a time, ending as the plain network', () => {
    const g = open({ history: true });
    g.load(network(300, 42, { history: true }));
    expect(g.version).toBe(301); // the cities, then 300 people
    const plain = open();
    plain.load(network(300, 42));
    const q = 'MATCH (p:Person)-[:KNOWS]->(q) RETURN p.name AS p, q.name AS q ORDER BY p, q';
    expect(g.query(q)).toEqual(plain.query(q));
    expect(g.query('AT VERSION 10 MATCH (p:Person) RETURN count(p) AS n')).toEqual([{ n: 9 }]);
    expect(g.commits()[4]).toMatchObject({ author: 'growth', message: expect.stringMatching(/joins$/) });
  });

  test('the ontology changes over six months', () => {
    const g = open({ history: true });
    g.load(ontology());
    const commits = g.commits();
    expect(commits.length).toBeGreaterThan(20);
    expect(new Set(commits.map((c) => c.author))).toEqual(new Set(['ana', 'bo', 'chen', 'dara']));
    // ingest_orders came, was deprecated, then went.
    const v = commits.find((c) => c.message === 'Deprecate ingest_orders')!.version;
    expect(g.query(`AT VERSION ${v} MATCH (f:Flow {name: 'ingest_orders'}) RETURN f.status AS s`)).toEqual([{ s: 'deprecated' }]);
    expect(g.query("MATCH (f:Flow {name: 'ingest_orders'}) RETURN f")).toEqual([]);
    const [h] = g.query(`AT VERSION ${v} MATCH (f:Flow {name: 'ingest_orders'}) RETURN [c IN history(f) | c.author + ': ' + c.change] AS h`);
    expect(h!.h).toEqual(['chen: created', 'chen: set', 'chen: set']);
    // Lineage at the end: what feeds the churn dashboard.
    const lineage = g.query("MATCH (:Dashboard {name: 'Churn risk'})-[:SHOWS]->(d)-[:WRITES|READS*1..8]-(x:Dataset) RETURN DISTINCT x.name AS n ORDER BY n");
    expect(lineage.map((r) => r.n)).toContain('customers');
  });
});

describe('the worker with history', () => {
  test('datasets with history, commits, diffs and past overviews', () => {
    const h = createHandler();
    const loaded = h.handle({ id: 1, type: 'dataset', dataset: { name: 'ontology', history: true } });
    expect(loaded).toMatchObject({ ok: true, result: { reused: false } });
    const version = (loaded as { result: { version: number } }).result.version;
    expect(version).toBeGreaterThan(20);
    const commits = h.handle({ id: 2, type: 'commits' });
    expect(commits.ok && (commits.result as unknown[]).length).toBe(version);
    const diff = h.handle({ id: 3, type: 'diff', from: version, to: 3 });
    expect(diff).toMatchObject({ ok: true, result: { from: version, to: 3 } });
    const past = h.handle({ id: 4, type: 'overview', asOf: 3 });
    expect(past.ok && (past.result as { ids: number[] }).ids.length).toBe(7); // 4 systems and 3 teams
    // Without history, past versions fail cleanly.
    const plain = createHandler();
    plain.handle({ id: 5, type: 'dataset', dataset: { name: 'social' } });
    expect(plain.handle({ id: 6, type: 'commits' })).toMatchObject({ ok: false, error: { code: 'SMALTCY_UNSUPPORTED' } });
  });
});
