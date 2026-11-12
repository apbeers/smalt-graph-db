/**
 * Sample graphs for the docs, the playground and benchmarks (`@smaltworks/smaltcy/datasets`). All are made up here:
 * no outside data.
 */
import type { GraphJSON } from '../engine/io.js';
import type { PropertyValue } from '../values.js';
import { HistoryBuilder } from './history.js';

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
export function network(people = 2000, seed = 42, options: { history?: boolean } = {}): GraphJSON {
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
  const json: GraphJSON = { nodes, relationships, indexes: [{ label: 'Person', key: 'name' }] };
  return options.history ? growthHistory(json) : json;
}

/**
 * The network as it grew: the cities first, then one commit per person joining (with where they live and whom they
 * know), an hour apart from 1 January 2025.
 */
function growthHistory(json: GraphJSON): GraphJSON {
  const b = new HistoryBuilder();
  const ids = new Map<string | number, number>();
  const start = Date.UTC(2025, 0, 1);
  const byStart = new Map<string | number, GraphJSON['relationships'][number][]>();
  for (const r of json.relationships) {
    let list = byStart.get(r.start);
    if (!list) byStart.set(r.start, (list = []));
    list.push(r);
  }
  for (const n of json.nodes) if (n.labels?.includes('City')) ids.set(n.id, b.node(n.labels ?? [], n.properties ?? {}));
  b.commit(start, 'growth', 'Add the cities');
  for (const n of json.nodes) {
    if (n.labels?.includes('City')) continue;
    ids.set(n.id, b.node(n.labels ?? [], n.properties ?? {}));
    for (const r of byStart.get(n.id) ?? []) b.rel(r.type, ids.get(r.start)!, ids.get(r.end)!, r.properties ?? {});
    b.commit(start + (Number(n.id) + 1) * 3_600_000, 'growth', `${n.properties?.name ?? n.id} joins`);
  }
  b.index('Person', 'name');
  return b.build();
}

/**
 * A data platform's ontology as it changed over six months: systems, datasets, the flows between them, the teams that
 * own them and the dashboards on top, with who changed what and why. 40-odd commits by four people.
 */
export function ontology(): GraphJSON {
  const b = new HistoryBuilder();
  let t = Date.UTC(2026, 4, 4, 9);
  const day = 86_400_000;
  const at = (days: number, hours = 0) => (t += days * day + hours * 3_600_000);
  const sys = (name: string, kind: string) => b.node(['System'], { name, kind });
  const ds = (name: string, props: Record<string, PropertyValue> = {}) => b.node(['Dataset'], { name, ...props });
  const flow = (name: string, schedule: string) => b.node(['Flow'], { name, schedule, status: 'active' });
  const team = (name: string) => b.node(['Team'], { name });

  const ordersDb = sys('Orders DB', 'database');
  const stream = sys('Event stream', 'stream');
  b.commit(at(0), 'ana', 'Add the source systems');
  const warehouse = sys('Warehouse', 'warehouse');
  const lake = sys('Raw file store', 'files');
  b.commit(at(1), 'ana', 'Add the warehouse and the raw file store');
  const payments = team('Payments');
  const growth = team('Growth');
  const platform = team('Data platform');
  b.commit(at(2), 'ana', 'Add the teams');
  const orders = ds('orders', { rows: 1_200_000 });
  const customers = ds('customers', { rows: 85_000 });
  b.rel('STORED_IN', orders, ordersDb);
  b.rel('STORED_IN', customers, ordersDb);
  b.rel('OWNS', payments, orders);
  b.rel('OWNS', payments, customers);
  b.commit(at(1, 3), 'ana', 'Model the orders database');
  const events = ds('click_events', { rows: 40_000_000 });
  b.rel('STORED_IN', events, stream);
  b.rel('OWNS', growth, events);
  b.commit(at(2), 'bo', 'Add click events');
  const rawOrders = ds('raw_orders');
  b.rel('STORED_IN', rawOrders, lake);
  const ingest = flow('ingest_orders', 'hourly');
  b.rel('READS', ingest, orders);
  b.rel('WRITES', ingest, rawOrders);
  b.rel('OWNS', platform, ingest);
  b.commit(at(3), 'chen', 'Ingest orders to the raw store');
  const factOrders = ds('fact_orders');
  b.rel('STORED_IN', factOrders, warehouse);
  const load = flow('load_orders', 'hourly');
  b.rel('READS', load, rawOrders);
  b.rel('WRITES', load, factOrders);
  b.rel('OWNS', platform, load);
  b.commit(at(1), 'chen', 'Load orders into the warehouse');
  const dimCustomers = ds('dim_customers');
  b.rel('STORED_IN', dimCustomers, warehouse);
  const cdc = flow('cdc_customers', 'streaming');
  b.rel('READS', cdc, customers);
  b.rel('WRITES', cdc, dimCustomers);
  b.rel('OWNS', platform, cdc);
  b.commit(at(2), 'chen', 'Stream customer changes into the warehouse');
  b.label(customers, 'PII');
  b.label(dimCustomers, 'PII');
  b.commit(at(1), 'dara', 'Tag personal data');
  const sessions = ds('sessions');
  b.rel('STORED_IN', sessions, warehouse);
  const sessionize = flow('sessionize', 'daily');
  b.rel('READS', sessionize, events);
  b.rel('WRITES', sessionize, sessions);
  b.rel('OWNS', growth, sessionize);
  b.commit(at(4), 'bo', 'Sessionize click events');
  const revenue = ds('revenue_daily');
  b.rel('STORED_IN', revenue, warehouse);
  const rollup = flow('revenue_rollup', 'daily');
  b.rel('READS', rollup, factOrders);
  b.rel('READS', rollup, dimCustomers);
  b.rel('WRITES', rollup, revenue);
  b.rel('OWNS', payments, rollup);
  b.commit(at(3), 'ana', 'Daily revenue');
  const dashRevenue = b.node(['Dashboard'], { name: 'Revenue' });
  b.rel('SHOWS', dashRevenue, revenue);
  b.rel('OWNS', payments, dashRevenue);
  b.commit(at(1), 'ana', 'Revenue dashboard');
  const funnel = ds('conversion_funnel');
  b.rel('STORED_IN', funnel, warehouse);
  const funnelFlow = flow('build_funnel', 'daily');
  b.rel('READS', funnelFlow, sessions);
  b.rel('READS', funnelFlow, factOrders);
  b.rel('WRITES', funnelFlow, funnel);
  b.rel('OWNS', growth, funnelFlow);
  const dashFunnel = b.node(['Dashboard'], { name: 'Funnel' });
  b.rel('SHOWS', dashFunnel, funnel);
  b.rel('OWNS', growth, dashFunnel);
  b.commit(at(6), 'bo', 'Conversion funnel and its dashboard');
  b.set(orders, 'rows', 1_900_000);
  b.set(events, 'rows', 72_000_000);
  b.commit(at(10), 'chen', 'Update row counts');
  b.set(ingest, 'schedule', 'every 15 minutes');
  b.commit(at(5), 'chen', 'Ingest orders more often');
  const payDb = sys('Payments DB', 'database');
  const charges = ds('charges', { rows: 2_400_000 });
  b.rel('STORED_IN', charges, payDb);
  b.rel('OWNS', payments, charges);
  b.label(charges, 'PII');
  b.commit(at(7), 'dara', 'Add the payments database');
  const factCharges = ds('fact_charges');
  b.rel('STORED_IN', factCharges, warehouse);
  const loadCharges = flow('load_charges', 'hourly');
  b.rel('READS', loadCharges, charges);
  b.rel('WRITES', loadCharges, factCharges);
  b.rel('OWNS', platform, loadCharges);
  b.rel('READS', rollup, factCharges);
  b.commit(at(2), 'dara', 'Charges into the warehouse; revenue reads them');
  // The orders pipeline moves off the raw store: load reads the database directly.
  b.set(ingest, 'status', 'deprecated');
  b.commit(at(12), 'chen', 'Deprecate ingest_orders');
  for (const rid of b.relsFrom(load, 'READS')) b.deleteRel(rid);
  b.rel('READS', load, orders);
  b.commit(at(1), 'chen', 'load_orders reads the orders database directly');
  b.deleteNode(ingest);
  b.deleteNode(rawOrders);
  b.commit(at(14), 'chen', 'Remove ingest_orders and raw_orders');
  const ml = team('Machine learning');
  const features = ds('customer_features');
  b.rel('STORED_IN', features, warehouse);
  const featureFlow = flow('build_features', 'daily');
  b.rel('READS', featureFlow, dimCustomers);
  b.rel('READS', featureFlow, sessions);
  b.rel('READS', featureFlow, factCharges);
  b.rel('WRITES', featureFlow, features);
  b.rel('OWNS', ml, featureFlow);
  b.rel('OWNS', ml, features);
  b.label(features, 'PII');
  b.commit(at(9), 'ana', 'Customer features for machine learning');
  const churn = ds('churn_scores');
  b.rel('STORED_IN', churn, warehouse);
  const score = flow('score_churn', 'daily');
  b.rel('READS', score, features);
  b.rel('WRITES', score, churn);
  b.rel('OWNS', ml, score);
  const dashChurn = b.node(['Dashboard'], { name: 'Churn risk' });
  b.rel('SHOWS', dashChurn, churn);
  b.rel('OWNS', growth, dashChurn);
  b.commit(at(6), 'ana', 'Churn scoring and its dashboard');
  b.set(platform, 'name', 'Data engineering');
  b.commit(at(4), 'dara', 'Rename the data platform team');
  b.set(sessionize, 'schedule', 'hourly');
  b.set(funnelFlow, 'schedule', 'hourly');
  b.commit(at(8), 'bo', 'Sessions and the funnel hourly');
  b.deleteNode(dashFunnel);
  b.commit(at(10), 'bo', 'Retire the funnel dashboard');
  b.set(orders, 'rows', 2_600_000);
  b.set(charges, 'rows', 3_100_000);
  b.set(events, 'rows', 118_000_000);
  b.commit(at(12), 'chen', 'Update row counts');
  b.index('Dataset', 'name');
  return b.build();
}

export { airline, gitHistory, microservices, orgChart, packages, powerGrid, supplyChain, type ShapeOptions } from './real-world.js';
