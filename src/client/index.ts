/**
 * The client for a graph in a Web Worker (`@smaltworks/smaltcy/client`), on its own: it carries no engine and no
 * language, so the page stays small while the worker (`@smaltworks/smaltcy/worker`) runs them.
 */
export { connect, GraphClient } from '../worker/client.js';
export type { DatasetLoaded, DatasetRequest, GraphStats, Overview, Request, Response } from '../worker/protocol.js';
export type { CommitInfo, GraphDiff } from '../store/interface.js';
export { SmaltcyError, type ErrorCode } from '../errors.js';
export type { Node, Relationship, Path, ResultValue } from '../values.js';
