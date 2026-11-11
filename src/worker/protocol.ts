/** Messages between the client and the engine's Web Worker. Results are plain data (structured clone). */
import type { GraphJSON } from '../engine/io.js';
import type { CypherResult } from '../index.js';

export type Request =
  | { readonly id: number; readonly type: 'run'; readonly cypher: string; readonly params?: Record<string, unknown> }
  | { readonly id: number; readonly type: 'load'; readonly data: GraphJSON; readonly replace?: boolean }
  | { readonly id: number; readonly type: 'dump' }
  | { readonly id: number; readonly type: 'stats' }
  /** A compact view of the whole graph (or the first `limit` nodes), for drawing. */
  | { readonly id: number; readonly type: 'overview'; readonly limit?: number; readonly captionKeys?: readonly string[] };

export interface GraphStats {
  readonly nodes: number;
  readonly relationships: number;
  readonly labels: Record<string, number>;
  readonly types: Record<string, number>;
}

/** Nodes and relationships as parallel arrays, cheap to send and to hand to the renderer. */
export interface Overview {
  readonly ids: number[];
  readonly labels: string[];
  readonly captions: string[];
  /** Pairs of indexes into `ids`. */
  readonly edges: number[];
  readonly edgeTypes: string[];
  readonly truncated: boolean;
}

export type Response =
  | { readonly id: number; readonly ok: true; readonly result: CypherResult | GraphJSON | GraphStats | Overview | null }
  | { readonly id: number; readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly position?: unknown } };
