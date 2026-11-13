# Architecture

smaltcy has four layers. Each talks to the next through one interface, so each can change, or be swapped, without
the others.

```
Cypher text ─→ lexer → parser → syntax tree → binder ─┐   language   src/cypher/
Plans built by programs or other languages ──────────┤
                                                      ▼
                       Graph plan: JSON, versioned, validated        src/plan/
                                                      ▼
            Engine: match planner (statistics, capabilities),        src/engine/
            operators that push rows, the function library
                                                      ▼
             Store interface ──┬─ MemoryStore (adjacency lists)     src/store/
                               └─ CsrStore (compressed sparse rows)

Results ─→ GPU renderer: WebGPU compute layout, 2D and 3D drawing    smaltkit/graph
```

Beneath the plan format is the function library (`src/functions/`): every operator and function a plan calls by
name. The plan validator checks names against it, the engine calls it and Cypher's binder maps its syntax onto it.

## Modules and their boundaries

Each layer is a package entry point of its own, so it can be reused anywhere: [Using the pieces](/guide/modules) shows
each on its own. The rules:

| Layer | May import |
| --- | --- |
| `functions` | values and errors |
| `plan` | functions |
| `store` | values (the plan's types only) |
| `engine` | plan, store, functions |
| `history` | store (a history is a store that wraps another) |
| `cypher` | plan, functions; never the engine |
| `render` | nothing: it draws any graph, and reads results by their shape (`resultsToGraph`) |
| `timeline` | nothing: it shows commits and reports a version |
| `client` | the worker protocol: never the engine, a language or the renderer |
| `worker` | the engine and Cypher, behind a message protocol |

`test/modules.test.ts` checks the imports of every file against this table, and bundles every entry point on its
own to check what it pulls in.

## Language: Cypher

A hand-written recursive-descent parser makes a syntax tree with source positions. The binder resolves variables to
slots, checks scopes (`WITH` starts a new one), maps operators and functions onto the engine's library, and lays
clauses out as plan operations. It doesn't choose how to run a pattern.

The engine never imports the language: `test/modules.test.ts` keeps it that way.

## Plans

The [plan format](/reference/plans) is the contract. Plans say what to compute, never how the graph is stored:
`match` holds a pattern, not a traversal order.

## Engine

- **The match planner** turns each pattern into steps (start by id, index seek, label scan; expand; expand into a
  bound node; variable-length expansion; shortest path; filters), from the store's statistics: label and type counts
  and average degree.
- **Operators push rows:** each operation compiles to a function that takes a row and pushes its result rows to the
  next. A sink can stop the flow, which is how `LIMIT` and `EXISTS` end a traversal early. Rows are reused while they
  stream; only operations that keep rows (`sort`, `aggregate`, `eager`) copy them.
- **Expressions** compile once per plan into closures.
- **Writes** run in a transaction: a statement that fails leaves nothing behind.

## Stores

See [Stores](/reference/stores). Stores know nothing about plans: they answer scans, lookups and expansions.

## Rendering

The renderer takes a graph of nodes and edges, not query results, so it can draw any graph. The layout runs in
WebGPU compute shaders; drawing, labels and picking are on the GPU too.

## Where this is going

The plan was designed so that a graph plan can be lowered to smaltdb's relational plans: nodes and relationships
kept as rows, patterns as joins, variable-length paths as recursion. Then smaltdb's storage (B-trees on OPFS, with
its write-ahead log) becomes one more store, and graph and relational data can live together. See
[ADR 0001](/adr/0001-smaltcy).
