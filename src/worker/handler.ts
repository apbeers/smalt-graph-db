/** The worker's request handling, kept apart from `self` so tests can run it in Node. */
import { open, type Graph } from '../index.js';
import { SmaltcyError } from '../errors.js';
import type { GraphStore } from '../store/interface.js';
import type { Overview, Request, Response } from './protocol.js';

/** Labels in order of preference for a node's caption. */
const CAPTION_KEYS = ['name', 'title', 'label', 'id', 'code'];

export function overview(store: GraphStore, limit = Infinity, keys: readonly string[] = CAPTION_KEYS): Overview {
  const ids: number[] = [];
  const labels: string[] = [];
  const captions: string[] = [];
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
  });
  const edges: number[] = [];
  const edgeTypes: string[] = [];
  store.scanRels(null, (r) => {
    const a = index.get(store.relStart(r));
    const b = index.get(store.relEnd(r));
    if (a !== undefined && b !== undefined) {
      edges.push(a, b);
      edgeTypes.push(store.relType(r));
    }
  });
  let total = 0;
  store.scanNodes(null, () => void total++);
  return { ids, labels, captions, edges, edgeTypes, truncated: total > ids.length };
}

export function createHandler(graph: Graph = open()): { handle(req: Request): Response; graph: Graph } {
  const state = { graph };
  return {
    get graph() {
      return state.graph;
    },
    handle(req: Request): Response {
      try {
        const g = state.graph;
        switch (req.type) {
          case 'run': return { id: req.id, ok: true, result: g.run(req.cypher, req.params ?? {}) };
          case 'load':
            if (req.replace) state.graph = open();
            state.graph.load(req.data);
            return { id: req.id, ok: true, result: null };
          case 'dump': return { id: req.id, ok: true, result: g.toJSON() };
          case 'stats': {
            const st = g.store.stats();
            return { id: req.id, ok: true, result: { nodes: st.nodes, relationships: st.rels, labels: Object.fromEntries(st.labels), types: Object.fromEntries(st.types) } };
          }
          case 'overview': return { id: req.id, ok: true, result: overview(g.store, req.limit, req.captionKeys) };
        }
      } catch (e) {
        const err = e instanceof SmaltcyError ? { code: e.code, message: e.message, position: e.position } : { code: 'SMALTCY_INTERNAL', message: String((e as Error)?.message ?? e) };
        return { id: req.id, ok: false, error: err };
      }
    },
  };
}
