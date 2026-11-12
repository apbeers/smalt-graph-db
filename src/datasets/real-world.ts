/**
 * Graphs with the shapes of real systems, generated at any size: an org chart (a tree), package dependencies (a few
 * huge hubs), airline routes (hub and spoke), a power grid (a sparse mesh spread over a map), a git history (long
 * chains that fork and merge), a supply chain (tiers) and microservices (tight clusters). Each is the same for a seed,
 * made in the order the real thing would grow, and can come with that growth as history (a commit per step).
 */
import type { GraphJSON } from '../engine/io.js';
import type { PropertyValue } from '../values.js';
import { HistoryBuilder } from './history.js';

type Props = Record<string, PropertyValue>;

export interface ShapeOptions {
  /** Same seed, same graph (default 7). */
  readonly seed?: number;
  /** Come with history: a commit per step of growth, by an author, with a message and a time. */
  readonly history?: boolean;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

/** Collects a graph in the order it grows, step by step, and turns it into JSON with or without that history. */
class Growth {
  private readonly nodes: { labels: string[]; props: Props }[] = [];
  private readonly rels: { type: string; start: number; end: number; props: Props }[] = [];
  private readonly steps: { nodes: number; rels: number; time: number; author: string; message: string }[] = [];
  private markNodes = 0;
  private markRels = 0;

  node(labels: string[], props: Props): number {
    this.nodes.push({ labels, props });
    return this.nodes.length - 1;
  }

  rel(type: string, start: number, end: number, props: Props = {}): void {
    this.rels.push({ type, start, end, props });
  }

  /** Ends a step: everything added since the last one is one commit. */
  step(time: number, author: string, message: string): void {
    if (this.nodes.length === this.markNodes && this.rels.length === this.markRels) return;
    this.steps.push({ nodes: this.nodes.length, rels: this.rels.length, time, author, message });
    this.markNodes = this.nodes.length;
    this.markRels = this.rels.length;
  }

  /** A node's department property, for generators that look back at what they made. */
  department(id: number): PropertyValue | undefined {
    return this.nodes[id]?.props.department;
  }

  get size(): number {
    return this.nodes.length;
  }

  build(history: boolean | undefined, index: { label: string; key: string }): GraphJSON {
    if (!history) {
      return {
        nodes: this.nodes.map((n, id) => ({ id, labels: n.labels, properties: n.props })),
        relationships: this.rels.map((r) => ({ start: r.start, end: r.end, type: r.type, properties: r.props })),
        indexes: [index],
      };
    }
    const b = new HistoryBuilder();
    let n = 0;
    let r = 0;
    for (const s of this.steps) {
      for (; n < s.nodes; n++) b.node(this.nodes[n]!.labels, this.nodes[n]!.props);
      for (; r < s.rels; r++) {
        const x = this.rels[r]!;
        b.rel(x.type, x.start, x.end, x.props);
      }
      b.commit(s.time, s.author, s.message);
    }
    b.index(index.label, index.key);
    return b.build();
  }
}

const FIRST = ['Ada', 'Ben', 'Chloe', 'Dev', 'Elena', 'Femi', 'Grace', 'Hiro', 'Ines', 'Jonas', 'Kofi', 'Lena', 'Mateo', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sven', 'Tara', 'Umar', 'Vera', 'Wei', 'Ximena', 'Yusuf', 'Zoe'];
const LAST = ['Okafor', 'Lindqvist', 'Tanaka', 'Moreau', 'Silva', 'Novak', 'Haddad', 'Kowalski', 'Mensah', 'Rossi', 'Iyer', 'Fischer', 'Park', 'Duarte', 'Byrne', 'Sato', 'Petrov', 'Nguyen', 'Larsen', 'Cohen'];
const DAY = 86_400_000;

function names(rand: () => number) {
  const used = new Map<string, number>();
  return () => {
    const base = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
    const k = (used.get(base) ?? 0) + 1;
    used.set(base, k);
    return k === 1 ? base : `${base} ${k}`;
  };
}

/**
 * A company's org chart: a CEO, VPs for each department, then directors, managers, leads and their teams. A tree:
 * everyone reports to one manager (REPORTS_TO), plus a few MENTORS links across teams. About as many relationships
 * as people. Grows hire by hire from 2014.
 */
export function orgChart(people = 1000, options: ShapeOptions = {}): GraphJSON {
  const rand = rng(options.seed ?? 7);
  const name = names(rand);
  const g = new Growth();
  const departments = ['Engineering', 'Sales', 'Marketing', 'Finance', 'Operations', 'Support', 'People', 'Legal'];
  const weights = [0.38, 0.18, 0.1, 0.06, 0.12, 0.1, 0.04, 0.02];
  const staff = ['Engineer', 'Account Executive', 'Marketer', 'Analyst', 'Coordinator', 'Support Agent', 'Recruiter', 'Counsel'];
  const titles = ['CEO', 'VP', 'Director', 'Senior Manager', 'Manager', 'Team Lead'];
  let t = Date.UTC(2014, 0, 6);
  const hire = (level: number, department: string, manager: number | null, manages: boolean) => {
    const role = !manages ? staff[departments.indexOf(department)]! : titles[Math.min(level, titles.length - 1)]!;
    const id = g.node(['Employee'], { name: name(), title: level === 0 ? 'CEO' : `${role}, ${department}`, department, level, hired: new Date(t).getUTCFullYear() });
    if (manager !== null) g.rel('REPORTS_TO', id, manager);
    t += Math.round(Math.round((DAY * 3650) / Math.max(people, 1)) * (0.5 + rand()));
    g.step(t, 'People team', `Hire ${level ? `a ${role} in ${department}` : 'the CEO'}`);
    return id;
  };
  // Each manager has a headcount to fill: a small one is a team of staff, a large one is split between managers who
  // report to them. Filled breadth first, so the company grows from the top down.
  const ceo = hire(0, 'Executive', null, true);
  const queue: { id: number; level: number; department: string; budget: number }[] = [];
  let left = people - 1;
  for (let d = 0; d < departments.length && left > 0; d++) {
    const budget = d === departments.length - 1 ? left - 1 : Math.min(left - 1, Math.round((people - 1) * weights[d]!) - 1);
    queue.push({ id: hire(1, departments[d]!, ceo, true), level: 1, department: departments[d]!, budget: Math.max(0, budget) });
    left -= 1 + Math.max(0, budget);
  }
  for (let q = 0; q < queue.length; q++) {
    const m = queue[q]!;
    if (m.budget <= 0) continue;
    if (m.budget <= 6 + Math.floor(rand() * 4)) {
      for (let i = 0; i < m.budget; i++) hire(m.level + 1, m.department, m.id, false);
      continue;
    }
    const k = Math.min(m.budget, 3 + Math.floor(rand() * 4));
    const shares = Array.from({ length: k }, () => 0.5 + rand());
    const total = shares.reduce((a, b) => a + b, 0);
    let rest = m.budget - k;
    shares.forEach((w, i) => {
      const budget = i === k - 1 ? rest : Math.min(rest, Math.round(((m.budget - k) * w) / total));
      rest -= budget;
      queue.push({ id: hire(m.level + 1, m.department, m.id, budget > 0), level: m.level + 1, department: m.department, budget });
    });
  }
  // Mentoring across departments: about 2% of people, at least a few.
  const count = g.size;
  const dept = (i: number) => g.department(i);
  for (let i = 0, made = 0; made < Math.max(3, Math.floor(count * 0.02)) && i < count * 10 && count > 2; i++) {
    const a = 1 + Math.floor(rand() * (count - 1));
    const b = 1 + Math.floor(rand() * (count - 1));
    if (dept(a) === dept(b)) continue;
    g.rel('MENTORS', a, b);
    made++;
  }
  g.step(t + DAY, 'People team', 'Start the mentoring programme');
  return g.build(options.history, { label: 'Employee', key: 'name' });
}

const SYL = ['fast', 'tiny', 'json', 'router', 'parse', 'cli', 'color', 'date', 'stream', 'glob', 'hash', 'test', 'mock', 'lint', 'type', 'path', 'http', 'cache', 'queue', 'log', 'env', 'uuid', 'yaml', 'deep', 'merge', 'pretty', 'micro', 'web', 'sql', 'auth'];
const CATEGORIES = ['utilities', 'http', 'parsing', 'testing', 'cli', 'build', 'crypto', 'data'];

/**
 * A package registry: each package depends on a few earlier ones, and well-used packages are picked far more often,
 * so a handful of hubs end up depended on by thousands while most packages have no dependents (DEPENDS_ON). Grows a
 * publish at a time from 2015.
 */
export function packages(count = 1000, options: ShapeOptions = {}): GraphJSON {
  const rand = rng(options.seed ?? 7);
  const g = new Growth();
  const used = new Set<string>();
  const pkgName = () => {
    for (;;) {
      const a = SYL[Math.floor(rand() * SYL.length)]!;
      const b = SYL[Math.floor(rand() * SYL.length)]!;
      const n = a === b ? a : `${a}-${b}`;
      const name = used.has(n) ? `${n}-${used.size}` : n;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  // Preferential attachment: a package appears in `ends` once, plus once per dependent, so picking from it favours
  // popular packages.
  const ends: number[] = [];
  let t = Date.UTC(2015, 0, 1);
  const authors = ['ana', 'bo', 'chen', 'dara', 'eli', 'femi', 'gus', 'hana'];
  for (let i = 0; i < count; i++) {
    const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!;
    const name = pkgName();
    const id = g.node(['Package'], { name, version: `${1 + Math.floor(rand() * 4)}.${Math.floor(rand() * 20)}.${Math.floor(rand() * 10)}`, category, license: rand() < 0.8 ? 'MIT' : rand() < 0.5 ? 'Apache-2.0' : 'ISC' });
    // At least one dependency (after the first few), sometimes many.
    const deps = i < 3 ? Math.min(i, 1) : Math.min(i, 1 + Math.floor(-Math.log(1 - rand()) * 1.6));
    const chosen = new Set<number>();
    for (let k = 0; k < deps * 3 && chosen.size < deps; k++) {
      const d = ends.length && rand() < 0.9 ? ends[Math.floor(rand() * ends.length)]! : Math.floor(rand() * i);
      if (d !== id) chosen.add(d);
    }
    for (const d of chosen) {
      g.rel('DEPENDS_ON', id, d);
      ends.push(d);
    }
    ends.push(id);
    t += Math.round(Math.round((DAY * 3650) / Math.max(count, 1)) * (0.5 + rand()));
    g.step(t, authors[Math.floor(rand() * authors.length)]!, `Publish ${name}`);
  }
  return g.build(options.history, { label: 'Package', key: 'name' });
}

const REGIONS = [
  { name: 'North America', lat: 40, lon: -95 },
  { name: 'South America', lat: -15, lon: -60 },
  { name: 'Europe', lat: 50, lon: 10 },
  { name: 'Africa', lat: 5, lon: 20 },
  { name: 'Asia', lat: 30, lon: 105 },
  { name: 'Oceania', lat: -25, lon: 140 },
];
const AIRLINES = ['Smalt Air', 'Kiln Airways', 'Cobalt Jet', 'Cerulean Pacific', 'Aureolin Atlantic', 'Glass Wings'];

/**
 * Airline routes: a few hub airports with flights everywhere in their region and to each other, and many small
 * airports with one or two routes to a nearby hub (ROUTE, with the airline and the distance). Hub and spoke: stars
 * joined at their centres. Grows a route network a few airports at a time from 2000.
 */
export function airline(airports = 1000, options: ShapeOptions = {}): GraphJSON {
  const rand = rng(options.seed ?? 7);
  const g = new Growth();
  const code = (i: number) => String.fromCharCode(65 + (Math.floor(i / 676) % 26), 65 + (Math.floor(i / 26) % 26), 65 + (i % 26));
  const hubCount = Math.min(airports, Math.max(REGIONS.length, Math.round(Math.sqrt(airports) * 0.8)));
  const pos: { lat: number; lon: number; region: number; hub: boolean }[] = [];
  const hubsByRegion: number[][] = REGIONS.map(() => []);
  const km = (a: number, b: number) => Math.round(Math.hypot(pos[a]!.lat - pos[b]!.lat, (pos[a]!.lon - pos[b]!.lon) * 0.8) * 111);
  const nearest = (id: number, from: number[], k: number) => {
    const best: { h: number; d: number }[] = [];
    for (const h of from) {
      const d = (pos[id]!.lat - pos[h]!.lat) ** 2 + ((pos[id]!.lon - pos[h]!.lon) * 0.8) ** 2;
      if (best.length < k || d < best[best.length - 1]!.d) {
        best.push({ h, d });
        best.sort((x, y) => x.d - y.d);
        if (best.length > k) best.pop();
      }
    }
    return best.map((x) => x.h);
  };
  let t = Date.UTC(2000, 0, 1);
  const step = (m: string) => {
    t += Math.round(Math.round((DAY * 9000) / Math.max(airports, 1)) * (0.5 + rand()));
    g.step(t, AIRLINES[Math.floor(rand() * AIRLINES.length)]!, m);
  };
  for (let i = 0; i < airports; i++) {
    const hub = i < hubCount;
    const region = hub ? i % REGIONS.length : Math.floor(rand() * REGIONS.length);
    const R = REGIONS[region]!;
    const spread = hub ? 14 : 22;
    pos.push({ lat: R.lat + (rand() - 0.5) * spread, lon: R.lon + (rand() - 0.5) * spread * 1.8, region, hub });
    const id = g.node(hub ? ['Airport', 'Hub'] : ['Airport'], { name: `${code(i)} ${hub ? 'International' : 'Regional'}`, code: code(i), region: R.name, hub, lat: Math.round(pos[i]!.lat * 100) / 100, lon: Math.round(pos[i]!.lon * 100) / 100 });
    if (hub) {
      // A new hub flies to the nearest hubs so far in its region (up to five), and to one or two hubs elsewhere.
      for (const h of nearest(id, hubsByRegion[region]!, 5)) g.rel('ROUTE', id, h, { airline: AIRLINES[region % AIRLINES.length]!, km: km(id, h) });
      const others = hubsByRegion.flatMap((hs, r) => (r === region ? [] : hs));
      for (let k = 0; k < Math.min(2, others.length); k++) {
        const h = others[Math.floor(rand() * others.length)]!;
        g.rel('ROUTE', id, h, { airline: AIRLINES[Math.floor(rand() * AIRLINES.length)]!, km: km(id, h) });
      }
      hubsByRegion[region]!.push(id);
      step(`Open the ${code(i)} hub`);
    } else {
      // A small airport flies to the nearest hub in its region, sometimes a second one.
      const near = nearest(id, hubsByRegion[region]!, 2);
      const routes = rand() < 0.35 ? 2 : 1;
      for (let k = 0; k < Math.min(routes, near.length); k++) g.rel('ROUTE', id, near[k]!, { airline: AIRLINES[region % AIRLINES.length]!, km: km(id, near[k]!) });
      step(`Start flights from ${code(i)}`);
    }
  }
  return g.build(options.history, { label: 'Airport', key: 'code' });
}

const OPERATORS = ['North', 'East', 'South', 'West', 'Central'];
const PLANTS = ['solar', 'wind', 'hydro', 'gas', 'nuclear'];

/**
 * A power grid: substations spread over a map, each linked to its neighbours by transmission lines (LINE, with the
 * voltage), and power plants feeding the nearest substation (FEEDS). A sparse mesh: every node has a few links, and
 * paths across it are long. Built outward from the centre of the map from 1965.
 */
export function powerGrid(substations = 1000, options: ShapeOptions = {}): GraphJSON {
  const rand = rng(options.seed ?? 7);
  const g = new Growth();
  const side = Math.max(2, Math.ceil(Math.sqrt(substations)));
  // Grid cells in order of distance from the centre, so the grid grows outward.
  const cells: [number, number][] = [];
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) cells.push([x, y]);
  const c = (side - 1) / 2;
  cells.sort((a, b) => Math.hypot(a[0] - c, a[1] - c) - Math.hypot(b[0] - c, b[1] - c) + (rand() - 0.5) * 0.8);
  const at = new Map<string, number>();
  let t = Date.UTC(1965, 0, 1);
  const operator = (x: number, y: number) => {
    const dx = x - c;
    const dy = y - c;
    if (Math.hypot(dx, dy) < side / 6) return 'Central';
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'East' : 'West') : dy > 0 ? 'South' : 'North';
  };
  let n = 0;
  for (const [x, y] of cells) {
    if (n >= substations) break;
    const op = operator(x, y);
    const id = g.node(['Substation'], { name: `${op} ${String(n + 1).padStart(4, '0')}`, operator: op, x: Math.round((x + (rand() - 0.5) * 0.6) * 10) / 10, y: Math.round((y + (rand() - 0.5) * 0.6) * 10) / 10, kV: rand() < 0.15 ? 400 : rand() < 0.5 ? 132 : 33 });
    at.set(`${x},${y}`, id);
    n++;
    // Lines to built neighbours: most of the four sides, now and then a diagonal.
    let linked = false;
    for (const [dx, dy, p] of [[-1, 0, 0.85], [1, 0, 0.85], [0, -1, 0.85], [0, 1, 0.85], [1, 1, 0.12], [-1, 1, 0.12]] as const) {
      const other = at.get(`${x + dx},${y + dy}`);
      if (other !== undefined && rand() < p) {
        g.rel('LINE', id, other, { kV: rand() < 0.2 ? 400 : 132, km: Math.round(8 + rand() * 30) });
        linked = true;
      }
    }
    // Never left on its own: a line to the nearest substation built so far.
    if (!linked && n > 1) {
      let best: number | undefined;
      for (let r = 1; best === undefined && r < side; r++) {
        for (let dx = -r; dx <= r && best === undefined; dx++) {
          for (const dy of Math.abs(dx) === r ? Array.from({ length: 2 * r + 1 }, (_, i) => i - r) : [-r, r]) {
            best = at.get(`${x + dx},${y + dy}`);
            if (best !== undefined) break;
          }
        }
      }
      g.rel('LINE', id, best!, { kV: 132, km: Math.round(8 + rand() * 30) });
    }
    if (rand() < 0.03) {
      const kind = PLANTS[Math.floor(rand() * PLANTS.length)]!;
      const plant = g.node(['Plant'], { name: `${kind[0]!.toUpperCase()}${kind.slice(1)} plant ${n}`, kind, operator: op, MW: Math.round((kind === 'nuclear' ? 1000 : kind === 'gas' ? 400 : 80) * (0.5 + rand())) });
      g.rel('FEEDS', plant, id);
    }
    t += Math.round(Math.round((DAY * 21000) / Math.max(substations, 1)) * (0.5 + rand()));
    g.step(t, `${op} grid`, `Commission substation ${op} ${String(n).padStart(4, '0')}`);
  }
  return g.build(options.history, { label: 'Substation', key: 'name' });
}

const VERBS = ['Fix', 'Add', 'Refactor', 'Update', 'Remove', 'Speed up', 'Document', 'Test', 'Rename', 'Simplify'];
const THINGS = ['login', 'parser', 'cache', 'search', 'checkout', 'the build', 'logging', 'retries', 'the API', 'settings', 'exports', 'the timeline'];

/**
 * A git history: commits pointing to their parents (PARENT). A long main line; feature and fix branches that fork
 * from it, run for a few commits and merge back (a merge commit has two parents); now and then one that's never
 * merged. Long chains that fork and rejoin. A commit at a time from 2021.
 */
export function gitHistory(commits = 1000, options: ShapeOptions = {}): GraphJSON {
  const rand = rng(options.seed ?? 7);
  const g = new Growth();
  const authors = ['ana', 'bo', 'chen', 'dara', 'eli', 'femi'];
  const hex = () => Math.floor(rand() * 0xfffffff).toString(16).padStart(7, '0');
  let t = Date.UTC(2021, 2, 1);
  const commit = (branch: string, kind: string, parents: number[], message: string, author: string) => {
    const hash = hex();
    const id = g.node(kind === 'merge' ? ['Commit', 'Merge'] : ['Commit'], { name: `${hash} ${message}`, hash, message, author, branch, kind });
    for (const p of parents) g.rel('PARENT', id, p);
    t += Math.round(Math.round((DAY * 1500) / Math.max(commits, 1)) * (0.3 + rand() * 1.4));
    g.step(t, author, message);
    return id;
  };
  let main = commit('main', 'main', [], 'Initial commit', 'ana');
  const open: { name: string; kind: string; head: number; left: number; author: string }[] = [];
  let branches = 0;
  while (g.size < commits) {
    const r = rand();
    if (r < 0.12 && open.length < 8) {
      const kind = rand() < 0.7 ? 'feature' : 'fix';
      const thing = THINGS[Math.floor(rand() * THINGS.length)]!.replace(/^the /, '').replace(/ /g, '-');
      branches++;
      open.push({ name: `${kind}/${thing}-${branches}`, kind, head: main, left: 2 + Math.floor(rand() * (kind === 'fix' ? 4 : 14)), author: authors[Math.floor(rand() * authors.length)]! });
    } else if (r < 0.32 || open.length === 0) {
      main = commit('main', 'main', [main], `${VERBS[Math.floor(rand() * VERBS.length)]} ${THINGS[Math.floor(rand() * THINGS.length)]}`, authors[Math.floor(rand() * authors.length)]!);
    } else {
      const i = Math.floor(rand() * open.length);
      const b = open[i]!;
      if (b.left > 0) {
        b.head = commit(b.name, b.kind, [b.head], `${VERBS[Math.floor(rand() * VERBS.length)]} ${THINGS[Math.floor(rand() * THINGS.length)]}`, b.author);
        b.left--;
      } else {
        open.splice(i, 1);
        // Most branches merge; a few are abandoned.
        if (rand() < 0.9) main = commit('main', 'merge', [main, b.head], `Merge ${b.name}`, b.author);
      }
    }
  }
  return g.build(options.history, { label: 'Commit', key: 'hash' });
}

const TIERS = [
  { label: 'Supplier', name: 'Raw materials', share: 0.06, words: ['Ironvale Mining', 'Copperline', 'Silica Sands', 'Northwood Timber', 'Cobalt Ridge', 'Polymer Works'] },
  { label: 'Manufacturer', name: 'Components', share: 0.14, words: ['Precision Parts', 'Circuit Co', 'Gearhouse', 'Fastener Bros', 'Glassworks', 'Moulding Ltd'] },
  { label: 'Factory', name: 'Assembly', share: 0.08, words: ['Assembly Plant'] },
  { label: 'Warehouse', name: 'Distribution', share: 0.1, words: ['Distribution Centre'] },
  { label: 'Store', name: 'Retail', share: 0.62, words: ['Store'] },
] as const;
const CITIES = ['Lisbon', 'Osaka', 'Accra', 'Quito', 'Tallinn', 'Perth', 'Montreal', 'Pune', 'Lyon', 'Austin', 'Seoul', 'Nairobi'];

/**
 * A supply chain: raw material suppliers feed component makers, who feed factories, which ship to distribution
 * centres, which stock stores (SUPPLIES, with the product and the lead time). Five tiers, so goods travel four hops,
 * most nodes are stores at the end. Built tier by tier from 2010.
 */
export function supplyChain(nodes = 1000, options: ShapeOptions = {}): GraphJSON {
  const rand = rng(options.seed ?? 7);
  const g = new Growth();
  const tiers: number[][] = TIERS.map(() => []);
  const byCity: number[][][] = TIERS.map(() => CITIES.map(() => []));
  let unused: number[] = [];
  let t = Date.UTC(2010, 0, 1);
  for (let k = 0; k < TIERS.length; k++) {
    const T = TIERS[k]!;
    const want = Math.max(k === 0 ? 2 : 1, Math.round(nodes * T.share));
    for (let i = 0; i < want; i++) {
      const region = Math.floor(rand() * CITIES.length);
      const word = T.words[i % T.words.length]!;
      const name = T.label === 'Store' ? `Store #${i + 1} ${CITIES[region]}` : T.words.length > 1 ? `${word} ${Math.floor(i / T.words.length) + 1}` : `${word} ${CITIES[region]} ${i + 1}`;
      const id = g.node([T.label], { name, tier: T.name, city: CITIES[region]! });
      tiers[k]!.push(id);
      byCity[k]![region]!.push(id);
      // Suppliers in the tier before: one to three, preferring the same city.
      if (k > 0) {
        const prev = tiers[k - 1]!;
        const local = byCity[k - 1]![region]!;
        const n = T.label === 'Store' ? 1 : 1 + Math.floor(rand() * 3);
        const chosen = new Set<number>();
        // A supplier no one buys from yet comes first, so every one has a customer.
        while (unused.length && chosen.size === 0) chosen.add(unused.shift()!);
        for (let j = 0; j < n * 3 && chosen.size < Math.min(n, prev.length); j++) {
          const pool = local.length && rand() < 0.7 ? local : prev;
          chosen.add(pool[Math.floor(rand() * pool.length)]!);
        }
        for (const s of chosen) g.rel('SUPPLIES', s, id, { product: ['steel', 'chips', 'glass', 'plastics', 'timber', 'copper'][Math.floor(rand() * 6)]!, leadDays: 1 + Math.floor(rand() * (k === 4 ? 3 : 30)) });
      }
      t += Math.round(Math.round((DAY * 5000) / Math.max(nodes, 1)) * (0.5 + rand()));
      g.step(t, 'Procurement', `Onboard ${name}`);
    }
    // Any left without a customer get one in this tier.
    const here = tiers[k]!;
    for (const s of k > 0 ? unused : []) g.rel('SUPPLIES', s, here[Math.floor(rand() * here.length)]!, { product: 'parts', leadDays: 1 + Math.floor(rand() * 30) });
    g.step(t + DAY, 'Procurement', `Sign contracts for ${TIERS[k - 1]?.name ?? ''}`);
    unused = [...here];
  }
  return g.build(options.history, { label: 'Store', key: 'name' });
}

const TEAMS = ['checkout', 'payments', 'search', 'catalog', 'accounts', 'shipping', 'reviews', 'recommendations', 'notifications', 'pricing', 'inventory', 'ads', 'messaging', 'analytics', 'identity', 'media'];
const ROLES = ['api', 'worker', 'scheduler', 'consumer', 'cache', 'indexer', 'exporter', 'webhooks', 'admin', 'sync'];

/**
 * Microservices: each team owns a gateway, a set of services that call each other a lot, and a database or two
 * (CALLS, USES). Teams call each other only now and then, through their gateways: tight clusters with few bridges.
 * Deployed a service at a time from 2019.
 */
export function microservices(services = 1000, options: ShapeOptions = {}): GraphJSON {
  const rand = rng(options.seed ?? 7);
  const g = new Growth();
  const teamCount = Math.max(3, Math.min(TEAMS.length * 4, Math.round(services / 25)));
  const teams = Array.from({ length: teamCount }, (_, i) => (i < TEAMS.length ? TEAMS[i]! : `${TEAMS[i % TEAMS.length]}-${Math.floor(i / TEAMS.length) + 1}`));
  const members: number[][] = teams.map(() => []);
  const gateways: number[] = [];
  let t = Date.UTC(2019, 0, 7);
  const deploy = (team: string, m: string) => {
    t += Math.round(Math.round((DAY * 2500) / Math.max(services, 1)) * (0.5 + rand()));
    g.step(t, `${team} team`, m);
  };
  // Every team starts with a gateway and a database.
  for (let i = 0; i < teams.length && g.size < services; i++) {
    const gw = g.node(['Service', 'Gateway'], { name: `${teams[i]}-gateway`, team: teams[i]!, language: 'go' });
    const db = g.node(['Database'], { name: `${teams[i]}-db`, team: teams[i]!, engine: rand() < 0.5 ? 'postgres' : 'document store' });
    g.rel('USES', gw, db);
    gateways.push(gw);
    members[i]!.push(gw);
    if (i > 0) g.rel('CALLS', gw, gateways[Math.floor(rand() * i)]!, { rpm: Math.round(rand() * 5000) });
    deploy(teams[i]!, `Deploy ${teams[i]}-gateway`);
  }
  let k = 0;
  while (g.size < services) {
    const i = Math.floor(rand() * teams.length);
    const team = teams[i]!;
    const role = ROLES[Math.floor(rand() * ROLES.length)]!;
    k++;
    const id = g.node(['Service'], { name: `${team}-${role}-${k}`, team, language: ['go', 'typescript', 'java', 'python', 'rust'][Math.floor(rand() * 5)]! });
    // Calls within the team: two to four; rarely a call to another team's gateway.
    const own = members[i]!;
    for (let c = 0; c < 2 + Math.floor(rand() * 3) && own.length; c++) g.rel('CALLS', id, own[Math.floor(rand() * own.length)]!, { rpm: Math.round(rand() * 2000) });
    if (rand() < 0.08) g.rel('CALLS', id, gateways[Math.floor(rand() * gateways.length)]!, { rpm: Math.round(rand() * 500) });
    if (!own.length) continue;
    if (rand() < 0.3) g.rel('USES', id, own[0]! + 1);
    own.push(id);
    deploy(team, `Deploy ${team}-${role}-${k}`);
  }
  return g.build(options.history, { label: 'Service', key: 'name' });
}
