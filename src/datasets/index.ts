/**
 * Sample graphs for the docs, the playground and benchmarks (`@smaltworks/smaltcy/datasets`). All are made up here:
 * no outside data.
 */
import type { GraphJSON } from '../engine/io.js';

type Node = GraphJSON['nodes'][number];
type Rel = GraphJSON['relationships'][number];

/** A seeded random number generator, so a dataset is the same every time. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

/** The smalt family: products, what they're built on, and the people-shaped roles that use them. */
export function family(): GraphJSON {
  const p = (id: string, kind: string, line: string): Node => ({ id, labels: ['Product', kind], properties: { name: id, line } });
  const nodes: Node[] = [
    p('smaltdb', 'Engine', 'A fast alternative database for the browser, written in TypeScript.'),
    p('smaltql', 'Language', 'The SQL you know, for smaltdb.'),
    p('smaltdf', 'Language', 'Dataframes for smaltdb. Small and fast.'),
    p('smaltcy', 'Language', 'A graph database for the browser that speaks Cypher.'),
    p('smaltui', 'App', 'A SQL console for smaltdb that runs entirely in the browser.'),
    p('smaltbi', 'App', 'Business intelligence in the browser, powered by smaltdb.'),
    p('smaltnb', 'App', 'TypeScript notebooks for smaltdb.'),
    p('smaltkit', 'Kit', 'Shared UI code for the smalt apps.'),
    { id: 'io', labels: ['Plugin'], properties: { name: 'smaltdb IO' } },
    { id: 'external', labels: ['Plugin'], properties: { name: 'smaltdb External' } },
    { id: 'parquet', labels: ['Plugin'], properties: { name: 'smaltdb Parquet' } },
    { id: 'opfs', labels: ['Platform'], properties: { name: 'OPFS' } },
    { id: 'worker', labels: ['Platform'], properties: { name: 'Web Workers' } },
    { id: 'webgpu', labels: ['Platform'], properties: { name: 'WebGPU' } },
    { id: 'analyst', labels: ['Role'], properties: { name: 'Analyst' } },
    { id: 'developer', labels: ['Role'], properties: { name: 'Developer' } },
  ];
  const r = (start: string, type: string, end: string): Rel => ({ start, end, type });
  const relationships: Rel[] = [
    r('smaltql', 'BUILT_ON', 'smaltdb'), r('smaltdf', 'BUILT_ON', 'smaltdb'), r('smaltui', 'BUILT_ON', 'smaltdb'),
    r('smaltbi', 'BUILT_ON', 'smaltdb'), r('smaltnb', 'BUILT_ON', 'smaltdb'),
    r('smaltui', 'USES', 'smaltql'), r('smaltbi', 'USES', 'smaltql'), r('smaltnb', 'USES', 'smaltql'), r('smaltnb', 'USES', 'smaltdf'),
    r('smaltui', 'USES', 'smaltkit'), r('smaltbi', 'USES', 'smaltkit'), r('smaltnb', 'USES', 'smaltkit'),
    r('io', 'EXTENDS', 'smaltdb'), r('external', 'EXTENDS', 'smaltdb'), r('parquet', 'EXTENDS', 'smaltdb'), r('parquet', 'USES', 'external'),
    r('smaltdb', 'RUNS_ON', 'opfs'), r('smaltdb', 'RUNS_ON', 'worker'), r('smaltcy', 'RUNS_ON', 'worker'), r('smaltcy', 'RUNS_ON', 'webgpu'),
    r('analyst', 'WORKS_IN', 'smaltbi'), r('analyst', 'WORKS_IN', 'smaltnb'), r('developer', 'WORKS_IN', 'smaltui'),
    r('developer', 'WORKS_IN', 'smaltql'), r('developer', 'WORKS_IN', 'smaltcy'),
  ];
  return { nodes, relationships };
}

/** People who know each other, the cities they live in and what they like. A small fixed graph for examples. */
export function social(): GraphJSON {
  const people: [string, number, string][] = [
    ['Ada', 1815, 'London'], ['Alan', 1912, 'London'], ['Grace', 1906, 'New York'], ['Edsger', 1930, 'Austin'],
    ['Barbara', 1939, 'New York'], ['Donald', 1938, 'Palo Alto'], ['Frances', 1932, 'New York'], ['John', 1927, 'Palo Alto'],
    ['Margaret', 1936, 'Boston'], ['Tim', 1955, 'London'], ['Radia', 1951, 'Boston'], ['Ken', 1943, 'Palo Alto'],
  ];
  const cities = ['London', 'New York', 'Austin', 'Palo Alto', 'Boston'];
  const topics = ['Compilers', 'Graphs', 'Networks', 'Algorithms', 'Languages'];
  const nodes: Node[] = [
    ...people.map(([name, born]) => ({ id: name, labels: ['Person'], properties: { name, born } })),
    ...cities.map((name) => ({ id: name, labels: ['City'], properties: { name } })),
    ...topics.map((name) => ({ id: name, labels: ['Topic'], properties: { name } })),
  ];
  const knows: [string, string, number][] = [
    ['Ada', 'Alan', 1833], ['Alan', 'Grace', 1936], ['Grace', 'Edsger', 1950], ['Edsger', 'Barbara', 1960],
    ['Alan', 'Edsger', 1940], ['Donald', 'Edsger', 1965], ['Frances', 'Grace', 1955], ['John', 'Donald', 1960],
    ['Margaret', 'Radia', 1975], ['Tim', 'Radia', 1990], ['Ken', 'Donald', 1970], ['Barbara', 'Frances', 1970],
    ['Radia', 'Barbara', 1980], ['Ken', 'John', 1965],
  ];
  const likes: [string, string][] = [
    ['Ada', 'Algorithms'], ['Alan', 'Algorithms'], ['Grace', 'Compilers'], ['Frances', 'Compilers'], ['Edsger', 'Graphs'],
    ['Donald', 'Algorithms'], ['Barbara', 'Languages'], ['John', 'Languages'], ['Radia', 'Networks'], ['Tim', 'Networks'],
    ['Ken', 'Languages'], ['Margaret', 'Compilers'], ['Edsger', 'Algorithms'],
  ];
  const relationships: Rel[] = [
    ...people.map(([name, , city]) => ({ start: name, end: city, type: 'LIVES_IN' })),
    ...knows.map(([a, b, since]) => ({ start: a, end: b, type: 'KNOWS', properties: { since } })),
    ...likes.map(([a, t]) => ({ start: a, end: t, type: 'LIKES' })),
  ];
  return { nodes, relationships, indexes: [{ label: 'Person', key: 'name' }] };
}

/**
 * A made-up metro: `lines` lines of stations across a city, with transfers where lines cross. Each CONNECTS has the
 * minutes it takes. Good for shortest paths.
 */
export function metro(lines = 8, stationsPerLine = 30, seed = 7): GraphJSON {
  const rand = rng(seed);
  const nodes: Node[] = [];
  const relationships: Rel[] = [];
  const syll = ['ka', 'lo', 'mi', 'ner', 'sa', 'tu', 'vel', 'ro', 'an', 'is', 'do', 'bri', 'gate', 'ford', 'ham', 'ton'];
  const stationName = () => {
    const n = 2 + Math.floor(rand() * 2);
    let s = '';
    for (let i = 0; i < n; i++) s += syll[Math.floor(rand() * syll.length)];
    return s[0]!.toUpperCase() + s.slice(1);
  };
  const grid = new Map<string, string>();
  let id = 0;
  for (let l = 0; l < lines; l++) {
    const line = `Line ${l + 1}`;
    nodes.push({ id: line, labels: ['Line'], properties: { name: line } });
    // Each line walks across a 40×40 grid in a direction of its own.
    let x = Math.floor(rand() * 40);
    let y = Math.floor(rand() * 40);
    const dx = rand() < 0.5 ? 1 : -1;
    const dy = rand() < 0.5 ? 1 : -1;
    let prev: string | null = null;
    for (let s = 0; s < stationsPerLine; s++) {
      const key = `${x},${y}`;
      let sid = grid.get(key);
      if (!sid) {
        sid = `s${id++}`;
        grid.set(key, sid);
        nodes.push({ id: sid, labels: ['Station'], properties: { name: stationName(), x, y } });
      }
      relationships.push({ start: sid, end: line, type: 'ON' });
      if (prev && prev !== sid) {
        const minutes = 1 + Math.floor(rand() * 4);
        relationships.push({ start: prev, end: sid, type: 'CONNECTS', properties: { line, minutes } });
        relationships.push({ start: sid, end: prev, type: 'CONNECTS', properties: { line, minutes } });
      }
      prev = sid;
      if (rand() < 0.6) x = Math.max(0, Math.min(39, x + dx));
      else y = Math.max(0, Math.min(39, y + dy));
    }
  }
  return { nodes, relationships, indexes: [{ label: 'Station', key: 'name' }] };
}

/**
 * A larger social network grown by preferential attachment (well-connected people gain more friends), with
 * communities and cities. `people` sets the size: 5,000 people make about 25,000 relationships.
 */
export function network(people = 2000, seed = 42): GraphJSON {
  const rand = rng(seed);
  const cities = ['Lisbon', 'Osaka', 'Accra', 'Quito', 'Tallinn', 'Perth', 'Montreal', 'Pune'];
  const first = ['Ana', 'Bo', 'Chen', 'Dara', 'Eli', 'Femi', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lea', 'Mo', 'Nia', 'Oto', 'Pia', 'Quin', 'Rui', 'Sol', 'Tae', 'Uma', 'Vik', 'Wen', 'Yara', 'Zed'];
  const nodes: Node[] = cities.map((name) => ({ id: name, labels: ['City'], properties: { name } }));
  const relationships: Rel[] = [];
  const ends: number[] = [];
  const community: number[] = [];
  for (let i = 0; i < people; i++) {
    const c = Math.floor(rand() * 6);
    community.push(c);
    nodes.push({ id: i, labels: ['Person'], properties: { name: `${first[i % first.length]} ${i}`, community: c, age: 18 + Math.floor(rand() * 60) } });
    relationships.push({ start: i, end: cities[Math.floor(rand() * cities.length)]!, type: 'LIVES_IN' });
    const links = i === 0 ? 0 : Math.min(i, 1 + Math.floor(rand() * 3));
    const chosen = new Set<number>();
    for (let k = 0; k < links; k++) {
      let j: number;
      // Mostly people from the same community, mostly people who already have friends.
      let tries = 0;
      do {
        j = ends.length && rand() < 0.8 ? ends[Math.floor(rand() * ends.length)]! : Math.floor(rand() * i);
        tries++;
      } while ((chosen.has(j) || (community[j] !== c && rand() < 0.85)) && tries < 20);
      if (chosen.has(j) || j === i) continue;
      chosen.add(j);
      relationships.push({ start: i, end: j, type: 'KNOWS', properties: { since: 2000 + Math.floor(rand() * 26) } });
      ends.push(i, j);
    }
  }
  return { nodes, relationships, indexes: [{ label: 'Person', key: 'name' }] };
}
