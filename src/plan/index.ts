/** The graph plan format: what a language builds and the engine runs (`@smaltworks/smaltcy/plan`). */
export * from './ops.js';
export { e, forEachChild, slotsRead, type Expr } from './expr.js';
export { validatePlan } from './validate.js';
