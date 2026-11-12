/** Messages between the client and the engine's Web Worker. Results are plain data (structured clone). */
import type { GraphJSON } from '../engine/io.js';
import type { CypherResult } from '../index.js';
import type { CommitInfo, GraphDiff } from '../store/interface.js';

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
  | {
      readonly id: number;
      readonly type: 'overview';
      readonly limit?: number;
      readonly captionKeys?: readonly string[];
      readonly groupKey?: string;
      /** The graph as it was at this version (needs history). */
      readonly asOf?: number;
    }
  /** The graph's commits in (from, to]: the timeline. */
  | { readonly id: number; readonly type: 'commits'; readonly from?: number; readonly to?: number }
  /** What changed from one version to another: what a drawing applies as the timeline moves. */
  | { readonly id: number; readonly type: 'diff'; readonly from: number; readonly to: number };

/** A sample dataset from `@smaltworks/smaltcy/datasets`, by name. */
export interface DatasetRequest {
  readonly name:
    | 'social'
    | 'family'
    | 'metro'
    | 'network'
    | 'ontology'
    | 'org-chart'
    | 'packages'
    | 'airline'
    | 'power-grid'
    | 'git-history'
    | 'supply-chain'
    | 'microservices';
  /** For the generated graphs (`network` and the real-world shapes): the number of nodes (default 2,000 people, else 1,000). */
  readonly size?: number;
  /** The store to keep it in: `memory` (default, writable) or `csr` (read-only, compact). */
  readonly store?: 'memory' | 'csr';
  /**
   * Keep history. The network and the real-world shapes then come with their growth (a commit per step) and the ontology with its six months
   * of changes; other datasets start as one commit. Kept in memory (`store` is ignored).
   */
  readonly history?: boolean;
}

/** What loading a dataset did. */
export interface DatasetLoaded {
  readonly nodes: number;
  readonly relationships: number;
  /** Time to generate and load it, in milliseconds; 0 when the worker already held it. */
  readonly ms: number;
  readonly reused: boolean;
  /** With history: the latest version. */
  readonly version?: number;
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
  /** Each edge's relationship id, for matching it to later diffs. */
  readonly relIds: number[];
  readonly truncated: boolean;
  /** Time the worker spent building it, in milliseconds. */
  readonly ms: number;
}

export type Response =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: CypherResult | GraphJSON | GraphStats | Overview | DatasetLoaded | readonly CommitInfo[] | GraphDiff | null;
    }
  | { readonly id: number; readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly position?: unknown } };
