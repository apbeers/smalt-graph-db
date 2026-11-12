import { CsrStore, MemoryStore, open, type Graph } from '../../src/index.js';

/** A small social graph, the same in every test: people, the cities they live in, and who knows whom. */
export const SOCIAL = `
CREATE
  (ada:Person {name: 'Ada', born: 1815, langs: ['en', 'fr']}),
  (alan:Person {name: 'Alan', born: 1912}),
  (grace:Person:Admiral {name: 'Grace', born: 1906}),
  (edsger:Person {name: 'Edsger', born: 1930}),
  (barbara:Person {name: 'Barbara', born: 1939}),
  (london:City {name: 'London'}),
  (nyc:City {name: 'New York'}),
  (ada)-[:LIVES_IN]->(london),
  (alan)-[:LIVES_IN]->(london),
  (grace)-[:LIVES_IN]->(nyc),
  (barbara)-[:LIVES_IN]->(nyc),
  (ada)-[:KNOWS {since: 1833}]->(alan),
  (alan)-[:KNOWS {since: 1936}]->(grace),
  (grace)-[:KNOWS {since: 1950}]->(edsger),
  (edsger)-[:KNOWS {since: 1960}]->(barbara),
  (alan)-[:KNOWS {since: 1940}]->(edsger)
`;

export function social(): Graph {
  const g = open();
  g.run(SOCIAL);
  return g;
}

/** The same graph in each store, for read-only tests. */
export function socialStores(): [string, Graph][] {
  const mem = social();
  // A past version: the graph at version 1 of a history in which everything was deleted afterwards.
  const hist = open({ history: true });
  hist.run(SOCIAL);
  hist.run('MATCH (n) DETACH DELETE n');
  return [
    ['memory', mem],
    ['csr', open({ store: CsrStore.from(mem.store) })],
    ['past version', hist.at(1)],
  ];
}

/** A random graph with `n` nodes and `m` relationships, the same for a seed. */
export function randomGraph(n: number, m: number, seed = 1): Graph {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const store = new MemoryStore();
  const ids: number[] = [];
  for (let i = 0; i < n; i++) ids.push(store.createNode([i % 3 === 0 ? 'A' : 'B'], { i, g: i % 7 }));
  for (let j = 0; j < m; j++) {
    const a = ids[Math.floor(rand() * n)]!;
    const b = ids[Math.floor(rand() * n)]!;
    store.createRel(rand() < 0.5 ? 'X' : 'Y', a, b, { w: Math.floor(rand() * 10) });
  }
  return open({ store });
}
