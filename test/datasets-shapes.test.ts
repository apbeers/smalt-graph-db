import { describe, expect, test } from 'vitest';
import { DEMO_DATASETS } from '../docs/.vitepress/theme/demo-datasets.js';
import { airline, gitHistory, microservices, network, orgChart, packages, powerGrid, supplyChain } from '../src/datasets/index.js';
import { open, type GraphJSON } from '../src/index.js';

type Gen = (size: number, options?: { history?: boolean }) => GraphJSON;
const SHAPES: Record<string, Gen> = {
  network: (n, o) => network(n, 42, o),
  'org-chart': orgChart,
  packages,
  airline,
  'power-grid': powerGrid,
  'git-history': gitHistory,
  'supply-chain': supplyChain,
  microservices,
};

function degrees(g: GraphJSON, type?: string): number[] {
  const d = new Array<number>(g.nodes.length).fill(0);
  for (const r of g.relationships) {
    if (type && r.type !== type) continue;
    d[r.start as number]!++;
    d[r.end as number]!++;
  }
  return d;
}

describe('real-world shapes', () => {
  test.each(Object.keys(SHAPES).filter((k) => k !== 'network'))('%s: the size asked for, the same every time, valid ends', (name) => {
    for (const size of [50, 1000]) {
      const g = SHAPES[name]!(size);
      // The power grid adds its plants on top of the substations.
      expect(g.nodes.length).toBeGreaterThanOrEqual(size);
      expect(g.nodes.length).toBeLessThanOrEqual(size * 1.06);
      for (const r of g.relationships) {
        expect(r.start).toBeLessThan(g.nodes.length);
        expect(r.end).toBeLessThan(g.nodes.length);
      }
      expect(JSON.stringify(SHAPES[name]!(size))).toBe(JSON.stringify(g));
    }
  });

  test.each(['packages', 'supply-chain', 'org-chart', 'airline', 'power-grid', 'git-history', 'microservices'])('%s: nothing on its own', (name) => {
    for (const size of [50, 1000]) {
      const g = SHAPES[name]!(size);
      expect(degrees(g).filter((d) => d === 0).length, `${name} at ${size}`).toBe(0);
    }
  });

  test('org chart: a tree, everyone but the CEO reports to one manager', () => {
    const g = orgChart(1000);
    const reports = g.relationships.filter((r) => r.type === 'REPORTS_TO');
    expect(reports.length).toBe(g.nodes.length - 1);
    expect(new Set(reports.map((r) => r.start)).size).toBe(g.nodes.length - 1);
    expect(Math.max(...g.nodes.map((n) => n.properties!.level as number))).toBeGreaterThanOrEqual(4);
  });

  test('packages: a few hubs, most packages without dependents', () => {
    const g = packages(2000);
    const dependents = new Array<number>(g.nodes.length).fill(0);
    for (const r of g.relationships) dependents[r.end as number]!++;
    expect(Math.max(...dependents)).toBeGreaterThan(100);
    expect(dependents.filter((d) => d === 0).length).toBeGreaterThan(g.nodes.length / 2);
  });

  test('airline: hubs hold most routes, small airports one or two', () => {
    const g = airline(1000);
    const d = degrees(g);
    const hubs = g.nodes.filter((n) => n.labels!.includes('Hub')).map((n) => n.id as number);
    expect(hubs.length).toBeLessThan(50);
    expect(Math.min(...hubs.map((h) => d[h]!))).toBeGreaterThan(3);
    const small = g.nodes.filter((n) => !n.labels!.includes('Hub')).map((n) => d[n.id as number]!);
    expect(Math.max(...small)).toBeLessThanOrEqual(2);
  });

  test('power grid: sparse, nobody has many lines', () => {
    const g = powerGrid(1000);
    expect(Math.max(...degrees(g, 'LINE'))).toBeLessThanOrEqual(8);
    expect(g.relationships.length / g.nodes.length).toBeLessThan(2);
  });

  test('git history: commits with one or two parents, a long main line', () => {
    const g = gitHistory(1000);
    const parents = new Array<number>(g.nodes.length).fill(0);
    for (const r of g.relationships) parents[r.start as number]!++;
    expect(parents.filter((p) => p === 0).length).toBe(1);
    expect(Math.max(...parents)).toBe(2);
    expect(g.nodes.filter((n) => n.labels!.includes('Merge')).length).toBeGreaterThan(20);
  });

  test('supply chain: SUPPLIES only goes one tier down', () => {
    const g = supplyChain(1000);
    const order = ['Supplier', 'Manufacturer', 'Factory', 'Warehouse', 'Store'];
    const tier = (id: unknown) => order.indexOf(g.nodes[id as number]!.labels![0]!);
    for (const r of g.relationships) expect(tier(r.end) - tier(r.start)).toBe(1);
    expect(g.nodes.filter((n) => n.labels![0] === 'Store').length).toBeGreaterThan(g.nodes.length / 2);
  });

  test('microservices: most calls stay within the team', () => {
    const g = microservices(1000);
    const calls = g.relationships.filter((r) => r.type === 'CALLS');
    const team = (id: unknown) => g.nodes[id as number]!.properties!.team;
    expect(calls.filter((r) => team(r.start) !== team(r.end)).length / calls.length).toBeLessThan(0.1);
  });

  test('100,000 nodes each, quickly', () => {
    for (const [name, gen] of Object.entries(SHAPES)) {
      if (name === 'network') continue;
      const t = performance.now();
      gen(100_000);
      expect(performance.now() - t, name).toBeLessThan(3000);
    }
  });

  test.each(Object.keys(SHAPES).filter((k) => k !== 'network'))('%s: loads with its growth, a commit a step', (name) => {
    const g = open({ history: true });
    g.load(SHAPES[name]!(300, { history: true }));
    const commits = g.run('RETURN size(commits()) AS n').rows[0]![0] as number;
    expect(commits).toBeGreaterThan(250);
    expect(g.run('AT VERSION 10 MATCH (n) RETURN count(n)').rows[0]![0]).toBeGreaterThan(0);
  });
});

describe.each(DEMO_DATASETS.map((d) => [d.name, d] as const))('the demo on %s', (name, d) => {
  test.each([50, 1000])('every query gives rows at %i', (size) => {
    const g = open();
    g.load(SHAPES[name]!(size));
    for (const q of d.queries) {
      const t = performance.now();
      const r = g.run(q.query);
      expect(r.rows.length, `${q.title} at ${size}`).toBeGreaterThan(0);
      expect(performance.now() - t, q.title).toBeLessThan(2000);
    }
  });

  test('every search finds a caption', () => {
    const g = SHAPES[name]!(1000);
    const captions = g.nodes.map((n) => String(n.properties!.name ?? '').toLowerCase());
    for (const s of d.searches) expect(captions.some((c) => c.includes(s.toLowerCase())), s).toBe(true);
  });

  test('the colour group is a property every node has', () => {
    const g = SHAPES[name]!(1000);
    for (const n of g.nodes) expect(d.group(n.labels!, n.properties![d.groupKey])).not.toBe('');
  });
});
