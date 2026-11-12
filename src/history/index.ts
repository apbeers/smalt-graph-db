/**
 * Graph history (`@smaltworks/smaltcy/history`): a store that keeps every version of the graph, opens any of them as a
 * read-only store, and says what changed between two. Use it through `open({ history: true })`, or wrap a store
 * yourself.
 */
export { HistoryStore, apply, invert, snapshotOf, type CommitDetails, type HistoryOptions } from './history-store.js';
export type { Change, ChangeCounts, Commit, CommitInfo, EntityChange, GraphDiff, GraphSnapshot, HistoryJSON, HistoryReader } from '../store/interface.js';
