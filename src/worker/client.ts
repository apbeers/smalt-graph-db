/**
 * The client for a graph in a Web Worker: the same calls as `Graph`, as promises, so queries never block the page.
 */
import type { GraphJSON } from '../engine/io.js';
import { SmaltcyError, type ErrorCode } from '../errors.js';
import type { CypherResult } from '../index.js';
import type { DatasetLoaded, DatasetRequest, GraphStats, Overview, Request, Response } from './protocol.js';
import type { CommitInfo, GraphDiff } from '../store/interface.js';

type Body = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export class GraphClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();

  constructor(private readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<Response>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else {
        const { code, message, position } = e.data.error;
        p.reject(new SmaltcyError(code as ErrorCode, message, position as SmaltcyError['position']));
      }
    };
  }

  private send<T>(body: Body): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...body, id });
    });
  }

  /** Runs Cypher; with `options.dataset`, on that sample dataset as generated. */
  run(cypher: string, params?: Record<string, unknown>, options: { dataset?: DatasetRequest } = {}): Promise<CypherResult> {
    return this.send({ type: 'run', cypher, params, dataset: options.dataset });
  }
  /** Replaces the graph with a sample dataset, generated in the worker. */
  dataset(dataset: DatasetRequest): Promise<DatasetLoaded> {
    return this.send({ type: 'dataset', dataset });
  }
  load(data: GraphJSON, options: { replace?: boolean } = {}): Promise<void> {
    return this.send({ type: 'load', data, replace: options.replace });
  }
  dump(): Promise<GraphJSON> {
    return this.send({ type: 'dump' });
  }
  stats(): Promise<GraphStats> {
    return this.send({ type: 'stats' });
  }
  /**
   * The graph as flat arrays, ready to draw; `groupKey` adds each node's value of that property, `asOf` draws a past
   * version (the graph must keep history).
   */
  overview(limit?: number, options: { groupKey?: string; asOf?: number } = {}): Promise<Overview> {
    return this.send({ type: 'overview', limit, groupKey: options.groupKey, asOf: options.asOf });
  }

  /** The graph's commits in (from, to], oldest first: what a timeline shows. */
  commits(from?: number, to?: number): Promise<readonly CommitInfo[]> {
    return this.send({ type: 'commits', from, to });
  }

  /** What changed from one version to another, either way. */
  diff(from: number, to: number): Promise<GraphDiff> {
    return this.send({ type: 'diff', from, to });
  }
  close(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new SmaltcyError('SMALTCY_UNSUPPORTED', 'The graph was closed'));
    this.pending.clear();
  }
}

/** Connects to a graph in a worker made from smaltcy's worker script. */
export function connect(worker: Worker): GraphClient {
  return new GraphClient(worker);
}
