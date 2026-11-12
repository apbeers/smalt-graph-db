/**
 * For a worker of your own (`@smaltworks/smaltcy/worker-runtime`): `createHandler` answers the messages the client
 * sends, as `@smaltworks/smaltcy/worker` does, around a graph you give it (your store, after registering your
 * functions).
 */
export { createHandler, overview } from './handler.js';
export type { DatasetLoaded, DatasetRequest, GraphStats, Overview, Request, Response } from './protocol.js';
