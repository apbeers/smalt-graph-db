/**
 * The function library (`@smaltworks/smaltcy/functions`): the operators and functions plans call by name, the value
 * comparisons they share, and `registerFunction` / `registerAggregate` to add your own.
 */
export {
  scalarFunctions,
  aggregateFunctions,
  registerFunction,
  registerAggregate,
  distinctAggregate,
  stringOf,
  toPropertyValue,
  type ScalarDef,
  type ScalarFn,
  type AggregateDef,
  type FnContext,
  type GraphReader,
  type HistoryLike,
  type CommitLike,
  commitMap,
} from './library.js';
export { equals, compare, orderCompare, groupKey, rowKey } from './compare.js';
