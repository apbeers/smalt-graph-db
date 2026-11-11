/** Messages between the client and the engine's Web Worker. Results are plain data (structured clone). */
import type { GraphJSON } from '../engine/io.js';
import type { CypherResult } from '../index.js';

export type Request =
  /**
   * Runs Cypher. With `dataset`, on that sample dataset as generated: the worker loads it first unless it holds it
   * already, unchanged since it was loaded.
   */
  | { readonly id: number; readonly type: 'run'; readonly cypher: string; readonly params?: Record<string, unknown>; readonly dataset?: DatasetRequest }
  /** Replaces the graph with a sample dataset, generated in the worker (unless it holds it already, unchanged). */
  | { readonly id: number; readonly type: 'dataset'; readonly dataset: DatasetRequest }
  | { readonly id: number; readonly type: 'load'; readonly data: GraphJSON; readonly replace?: boolean }
  | { readonly id: number; readonly type: 'dump' }
  | { readonly id: number; readonly type: 'stats' }
  /** A compact view of the whole graph (or the first `limit` nodes), for drawing. */
  | { readonly id: number; readonly type: 'overview'; readonly limit?: number; readonly captionKeys?: readonly string[]; readonly groupKey?: string };

/** A sample dataset from `@smaltworks/smaltcy/datasets`, by name. */
export interface DatasetRequest {
  readonly name: 'social' | 'family' | 'metro' | 'network';
  /** For `network`: the number of people (default 2,000). */
  readonly size?: number;
  /** The store to keep it in: `memory` (default, writable) or `csr` (read-only, compact). */
  readonly store?: 'memory' | 'csr';
}

/** What loading a dataset did. */
export interface DatasetLoaded {
  readonly nodes: number;
  readonly relationships: number;
  /** Time to generate and load it, in milliseconds; 0 when the worker already held it. */
  readonly ms: number;
  readonly reused: boolean;
}

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
  /** With `groupKey`: each node's value of that property, as text ('' when missing). */
  readonly groups?: string[];
  /** Pairs of indexes into `ids`. */
  readonly edges: number[];
  readonly edgeTypes: string[];
  readonly truncated: boolean;
  /** Time the worker spent building it, in milliseconds. */
  readonly ms: number;
}

export type Response =
  | { readonly id: number; readonly ok: true; readonly result: CypherResult | GraphJSON | GraphStats | Overview | DatasetLoaded | null }
  | { readonly id: number; readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly position?: unknown } };
