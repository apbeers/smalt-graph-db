/** The worker's request handling, kept apart from `self` so tests can run it in Node. */
import { CsrStore, open, type Graph } from '../index.js';
import { airline, family, gitHistory, metro, microservices, network, ontology, orgChart, packages, powerGrid, social, supplyChain } from '../datasets/index.js';
import { SmaltcyError } from '../errors.js';
import type { GraphStore } from '../store/interface.js';
import type { DatasetLoaded, DatasetRequest, Overview, Request, Response } from './protocol.js';

const keyOf = (d: DatasetRequest) => `${d.name}:${d.size ?? ''}:${d.history ? 'history' : (d.store ?? 'memory')}`;

function generate(d: DatasetRequest) {
  switch (d.name) {
    case 'social': return social();
    case 'family': return family();
    case 'metro': return metro();
    case 'network': return network(d.size ?? 2000, undefined, { history: d.history });
    case 'ontology': return ontology();
    case 'org-chart': return orgChart(d.size, { history: d.history });
    case 'packages': return packages(d.size, { history: d.history });
    case 'airline': return airline(d.size, { history: d.history });
    case 'power-grid': return powerGrid(d.size, { history: d.history });
    case 'git-history': return gitHistory(d.size, { history: d.history });
    case 'supply-chain': return supplyChain(d.size, { history: d.history });
    case 'microservices': return microservices(d.size, { history: d.history });
  }
  throw new SmaltcyError('SMALTCY_NOT_FOUND', `No sample dataset ${String((d as { name: unknown }).name)}`);
}

/** Labels in order of preference for a node's caption. */
const CAPTION_KEYS = ['name', 'title', 'label', 'id', 'code'];

export function overview(store: GraphStore, limit = Infinity, keys: readonly string[] = CAPTION_KEYS, groupKey?: string): Overview {
  const t0 = performance.now();
  const ids: number[] = [];
  const labels: string[] = [];
  const captions: string[] = [];
  const groups: string[] | undefined = groupKey ? [] : undefined;
  const index = new Map<number, number>();
  store.scanNodes(null, (id) => {
    if (ids.length >= limit) return false;
    index.set(id, ids.length);
    ids.push(id);
    labels.push(store.labels(id)[0] ?? '');
    let cap = '';
    for (const k of keys) {
      const v = store.nodeProperty(id, k);
      if (v !== undefined && v !== null) {
        cap = String(v);
        break;
      }
    }
    captions.push(cap);
    if (groups) {
      const g = store.nodeProperty(id, groupKey!);
      groups.push(g === undefined || g === null ? '' : String(g));
    }
  });
  const edges: number[] = [];
  const edgeTypes: string[] = [];
  const relIds: number[] = [];
  store.scanRels(null, (r) => {
    const a = index.get(store.relStart(r));
    const b = index.get(store.relEnd(r));
    if (a !== undefined && b !== undefined) {
      edges.push(a, b);
      edgeTypes.push(store.relType(r));
      relIds.push(r);
    }
  });
  let total = 0;
  store.scanNodes(null, () => void total++);
  return { ids, labels, captions, ...(groups ? { groups } : {}), edges, edgeTypes, relIds, truncated: total > ids.length, ms: performance.now() - t0 };
}

export function createHandler(graph: Graph = open()): { handle(req: Request): Response; graph: Graph } {
  // The sample dataset the graph holds, unchanged since it was loaded; null once a write changes it.
  const state: { graph: Graph; dataset: string | null } = { graph, dataset: null };
  const useDataset = (d: DatasetRequest): DatasetLoaded => {
    const key = keyOf(d);
    const st0 = () => state.graph.store.stats();
    if (state.dataset === key) return { nodes: st0().nodes, relationships: st0().rels, ms: 0, reused: true, ...(state.graph.version !== undefined ? { version: state.graph.version } : {}) };
    const t0 = performance.now();
    const g = open({ history: !!d.history });
    g.load(generate(d), { author: 'sample data', message: `Load the ${d.name} dataset` });
    state.graph = d.store === 'csr' && !d.history ? open({ store: CsrStore.from(g.store) }) : g;
    state.dataset = key;
    const st = st0();
    return { nodes: st.nodes, relationships: st.rels, ms: performance.now() - t0, reused: false, ...(g.version !== undefined ? { version: g.version } : {}) };
  };
  return {
    get graph() {
      return state.graph;
    },
    handle(req: Request): Response {
      try {
        const g = state.graph;
        switch (req.type) {
          case 'run': {
            if (req.dataset) useDataset(req.dataset);
            const r = state.graph.run(req.cypher, req.params ?? {});
            if (Object.values(r.counts).some((n) => n > 0)) state.dataset = null;
            return { id: req.id, ok: true, result: r };
          }
          case 'dataset': return { id: req.id, ok: true, result: useDataset(req.dataset) };
          case 'load':
            state.dataset = null;
            if (req.replace) state.graph = open();
            state.graph.load(req.data);
            return { id: req.id, ok: true, result: null };
          case 'dump': return { id: req.id, ok: true, result: g.toJSON() };
          case 'stats': {
            const st = g.store.stats();
            return { id: req.id, ok: true, result: { nodes: st.nodes, relationships: st.rels, labels: Object.fromEntries(st.labels), types: Object.fromEntries(st.types) } };
          }
          case 'overview': {
            const store = req.asOf === undefined ? g.store : g.at(req.asOf).store;
            return { id: req.id, ok: true, result: overview(store, req.limit, req.captionKeys, req.groupKey) };
          }
          case 'commits': return { id: req.id, ok: true, result: g.commits(req.from, req.to) };
          case 'diff': return { id: req.id, ok: true, result: g.diff(req.from, req.to) };
        }
      } catch (e) {
        const err = e instanceof SmaltcyError ? { code: e.code, message: e.message, position: e.position } : { code: 'SMALTCY_INTERNAL', message: String((e as Error)?.message ?? e) };
        return { id: req.id, ok: false, error: err };
      }
    },
  };
}
