/**
 * Values smaltcy computes with and returns. Numbers are JavaScript doubles: an integer is a number with no fraction
 * (see docs/reference/cypher/divergences.md). Nodes, relationships and paths inside the engine are references by id
 * (`NodeRef`, `RelRef`, `PathRef`); results turn them into `Node`, `Relationship` and `Path` objects with their data.
 */

/** A node, by id, as the engine carries it between operations. */
export class NodeRef {
  constructor(readonly id: number) {}
}

/** A relationship, by id. */
export class RelRef {
  constructor(readonly id: number) {}
}

/** A path: `nodes.length === rels.length + 1`. */
export class PathRef {
  constructor(
    readonly nodes: readonly number[],
    readonly rels: readonly number[],
  ) {}
}

export type Value =
  | null
  | boolean
  | number
  | string
  | readonly Value[]
  | { readonly [key: string]: Value }
  | NodeRef
  | RelRef
  | PathRef;

/** A node in a result. */
export interface Node {
  readonly kind: 'node';
  readonly id: number;
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, ResultValue>>;
}

/** A relationship in a result: `start` and `end` are node ids. */
export interface Relationship {
  readonly kind: 'relationship';
  readonly id: number;
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly properties: Readonly<Record<string, ResultValue>>;
}

/** A path in a result. */
export interface Path {
  readonly kind: 'path';
  readonly nodes: readonly Node[];
  readonly relationships: readonly Relationship[];
}

export type ResultValue =
  | null
  | boolean
  | number
  | string
  | readonly ResultValue[]
  | { readonly [key: string]: ResultValue }
  | Node
  | Relationship
  | Path;

/** Property values a store can hold: no nodes, relationships, paths or maps (lists of these are fine). */
export type PropertyValue = null | boolean | number | string | readonly PropertyValue[];

export function isMap(v: unknown): v is { readonly [key: string]: Value } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof NodeRef) && !(v instanceof RelRef) && !(v instanceof PathRef);
}

/** The name of a value's type, for error messages and `valueType()`. */
export function typeName(v: Value): string {
  if (v === null) return 'NULL';
  switch (typeof v) {
    case 'boolean': return 'BOOLEAN';
    case 'number': return Number.isInteger(v) ? 'INTEGER' : 'FLOAT';
    case 'string': return 'STRING';
  }
  if (Array.isArray(v)) return 'LIST';
  if (v instanceof NodeRef) return 'NODE';
  if (v instanceof RelRef) return 'RELATIONSHIP';
  if (v instanceof PathRef) return 'PATH';
  return 'MAP';
}
