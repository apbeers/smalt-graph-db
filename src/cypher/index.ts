/**
 * Cypher for smaltcy (`@smaltworks/smaltcy/cypher`): text to graph plans. The engine never sees Cypher.
 */
import type { GraphPlan } from '../plan/ops.js';
import { bind } from './binder.js';
import { parse } from './parser.js';

export interface CompiledCypher {
  readonly plan: GraphPlan;
  /** The text started with EXPLAIN. */
  readonly explain: boolean;
}

/** Parses and binds one Cypher statement. */
export function compile(text: string): CompiledCypher {
  const st = parse(text);
  return { plan: bind(st), explain: st.explain };
}

export { parse } from './parser.js';
export { bind } from './binder.js';
export type * as ast from './ast.js';
