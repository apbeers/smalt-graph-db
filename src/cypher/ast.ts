/** Cypher's syntax tree, as the parser builds it. Every node keeps its place in the source text. */

export interface Span {
  readonly start: number;
  readonly end: number;
}

export type Expr = Span &
  (
    | { readonly t: 'lit'; readonly v: null | boolean | number | string; readonly float?: boolean }
    | { readonly t: 'param'; readonly name: string }
    | { readonly t: 'var'; readonly name: string }
    | { readonly t: 'prop'; readonly of: Expr; readonly key: string }
    | { readonly t: 'labels'; readonly of: Expr; readonly labels: readonly string[] }
    | { readonly t: 'call'; readonly name: string; readonly args: readonly Expr[]; readonly distinct: boolean; readonly star: boolean }
    | { readonly t: 'binary'; readonly op: string; readonly a: Expr; readonly b: Expr }
    | { readonly t: 'unary'; readonly op: 'not' | 'neg' | 'pos'; readonly a: Expr }
    | { readonly t: 'compare'; readonly ops: readonly string[]; readonly args: readonly Expr[] }
    | { readonly t: 'isNull'; readonly a: Expr; readonly negated: boolean }
    | { readonly t: 'list'; readonly items: readonly Expr[] }
    | { readonly t: 'map'; readonly entries: readonly (readonly [string, Expr])[] }
    | { readonly t: 'index'; readonly of: Expr; readonly index: Expr }
    | { readonly t: 'slice'; readonly of: Expr; readonly from?: Expr; readonly to?: Expr }
    | { readonly t: 'case'; readonly operand?: Expr; readonly whens: readonly (readonly [Expr, Expr])[]; readonly else?: Expr }
    | { readonly t: 'listComp'; readonly name: string; readonly list: Expr; readonly where?: Expr; readonly map?: Expr }
    | { readonly t: 'quantifier'; readonly q: 'any' | 'all' | 'none' | 'single'; readonly name: string; readonly list: Expr; readonly where: Expr }
    /** A pattern used as a predicate, or `EXISTS { … }`. */
    | { readonly t: 'exists'; readonly pattern: readonly PatternPart[]; readonly where?: Expr }
    | { readonly t: 'patternComp'; readonly pattern: PatternPart; readonly where?: Expr; readonly map: Expr }
  );

export interface NodePattern extends Span {
  readonly name?: string;
  readonly labels: readonly string[];
  readonly props?: Expr;
}

export interface RelPattern extends Span {
  readonly name?: string;
  readonly dir: 'out' | 'in' | 'both';
  readonly types: readonly string[];
  readonly props?: Expr;
  /** Present for variable-length relationships. */
  readonly hops?: { readonly min?: number; readonly max?: number };
}

export interface PatternPart extends Span {
  readonly path?: string;
  readonly shortest?: 'one' | 'all';
  readonly nodes: readonly NodePattern[];
  /** `rels[i]` joins `nodes[i]` and `nodes[i + 1]`. */
  readonly rels: readonly RelPattern[];
}

export interface ReturnItem {
  readonly expr: Expr;
  readonly alias?: string;
  /** The item's text, its column name when it has no alias. */
  readonly text: string;
}

export interface Projection {
  readonly distinct: boolean;
  readonly star: boolean;
  readonly items: readonly ReturnItem[];
  readonly order: readonly { readonly expr: Expr; readonly desc: boolean }[];
  readonly skip?: Expr;
  readonly limit?: Expr;
}

export type SetItem =
  | { readonly t: 'prop'; readonly target: Expr; readonly key: string; readonly value: Expr }
  | { readonly t: 'props'; readonly name: string; readonly value: Expr; readonly merge: boolean }
  | { readonly t: 'labels'; readonly name: string; readonly labels: readonly string[] };

export type RemoveItem =
  | { readonly t: 'prop'; readonly target: Expr; readonly key: string }
  | { readonly t: 'labels'; readonly name: string; readonly labels: readonly string[] };

export type Clause = Span &
  (
    | { readonly t: 'match'; readonly optional: boolean; readonly pattern: readonly PatternPart[]; readonly where?: Expr }
    | { readonly t: 'unwind'; readonly list: Expr; readonly name: string }
    | { readonly t: 'with'; readonly proj: Projection; readonly where?: Expr }
    | { readonly t: 'return'; readonly proj: Projection }
    | { readonly t: 'create'; readonly pattern: readonly PatternPart[] }
    | { readonly t: 'merge'; readonly part: PatternPart; readonly onCreate: readonly SetItem[]; readonly onMatch: readonly SetItem[] }
    | { readonly t: 'set'; readonly items: readonly SetItem[] }
    | { readonly t: 'remove'; readonly items: readonly RemoveItem[] }
    | { readonly t: 'delete'; readonly detach: boolean; readonly exprs: readonly Expr[] }
  );

export type Statement =
  | {
      readonly t: 'query';
      readonly parts: readonly (readonly Clause[])[];
      readonly unionAll: readonly boolean[];
      readonly explain: boolean;
      /** `AT VERSION n` or `AT TIME t` before the query: read the graph as it was (smaltcy's extension). */
      readonly asOf?: { readonly version: Expr } | { readonly time: Expr };
    }
  | { readonly t: 'createIndex' | 'dropIndex'; readonly label: string; readonly key: string; readonly explain: boolean };
