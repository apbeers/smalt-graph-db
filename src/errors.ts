/** Errors carry a stable code, as smaltdb's do. */
export type ErrorCode =
  | 'SMALTCY_SYNTAX' // the language could not parse the text
  | 'SMALTCY_SEMANTIC' // the text parsed but means nothing (unknown variable, aggregate in WHERE, …)
  | 'SMALTCY_PLAN' // a plan failed validation
  | 'SMALTCY_TYPE' // a value had the wrong type at run time
  | 'SMALTCY_CONSTRAINT' // a write would break the graph (deleting a node that still has relationships)
  | 'SMALTCY_PARAM' // a parameter was missing
  | 'SMALTCY_UNSUPPORTED' // a store or the engine can't do this (a write on a read-only store)
  | 'SMALTCY_NOT_FOUND'; // an unknown function or object

export class SmaltcyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Where in the source text the error is, when a language reported it. */
    readonly position?: { readonly offset: number; readonly line: number; readonly column: number },
  ) {
    super(message);
    this.name = 'SmaltcyError';
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new SmaltcyError(code, message);
}
