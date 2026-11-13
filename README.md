<h1><code>sm<b>alt</b>cy</code></h1>

<a href="https://smaltworks.dev/stability"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/public/work-in-progress-on-dark.svg"><img alt="Work in progress. Come build with us." src="docs/public/work-in-progress.svg" height="56"></picture></a>

**Small. Alternative. Connected.** A graph database for the browser that speaks Cypher, written in TypeScript.

[Documentation](https://andrewbeers.me/smalt-graph-db/) · [Playground](https://andrewbeers.me/smalt-graph-db/playground) · [Tech demo](https://andrewbeers.me/smalt-graph-db/demo) · [smaltworks.dev](https://smaltworks.dev)

**smaltcy** keeps a graph of nodes and relationships in the page and answers Cypher queries on it. Cypher compiles
to **graph plans**, plain JSON that the engine validates and runs, and the engine runs the same plans on any
**store**: an in-memory adjacency store for writes, or a compact CSR store for reads. A WebGPU renderer draws
graphs in 2D and 3D, with the force layout in compute shaders.

> **Status: 0.1.0, work in progress.** A Cypher subset (reading clauses, writes, variable-length and shortest paths,
> aggregates, `EXPLAIN`), two stores, graph history with time travel (`AT VERSION`, `AT TIME`), a Web Worker client, JSON
> import and export, and the GPU renderer. Graphs live
> in memory; durable storage comes with smaltdb ([ADR 0001](docs/adr/0001-smaltcy.md)).

## Install

```sh
npm install @smaltworks/smaltcy
```

```ts
import { open } from '@smaltworks/smaltcy';

const db = open();
db.run(`
  CREATE (ada:Person {name: 'Ada'})-[:KNOWS {since: 1833}]->(alan:Person {name: 'Alan'}),
         (alan)-[:KNOWS {since: 1936}]->(:Person {name: 'Grace'})
`);

db.query(`
  MATCH p = shortestPath((a:Person {name: 'Ada'})-[:KNOWS*]-(b:Person {name: 'Grace'}))
  RETURN [n IN nodes(p) | n.name] AS chain
`); // [{ chain: ['Ada', 'Alan', 'Grace'] }]

console.log(db.explain("MATCH (a:Person {name: 'Ada'})-[:KNOWS]->(b) RETURN b.name"));
```

## How it fits together

```
Cypher ─→ parser → binder ─→ graph plan (JSON) ─→ engine: match planner + operators ─→ store
                                                                                  ├─ MemoryStore
                                                                                  └─ CsrStore
results ─→ GPU renderer (WebGPU: compute layout, 2D and 3D)
```

## Using the pieces

Each part is its own entry point, made to be used on its own: import one, and your bundle holds it and what's beneath
it, nothing more. [Using the pieces](docs/guide/modules.md) has a working example of each; `test/modules.test.ts`
keeps the boundaries.

| Entry point (`@smaltworks/smaltcy…`) | Source | Use it to | Depends on |
| --- | --- | --- | --- |
| `.` | `src/index.ts` | Query with Cypher: `open()` | everything below but the renderer |
| `/cypher` | `src/cypher/` | Turn Cypher into plans (lexer, parser, binder) | plan, functions |
| `/engine` | `src/engine/` | Run plans: match planner, operators, EXPLAIN, JSON import and export | plan, store, functions |
| `/plan` | `src/plan/` | Build, check and send plans | functions |
| `/store` | `src/store/` | Use or write a memory structure | — |
| `/history` | `src/history/` | Keep every version: time travel, diffs | store |
| `/functions` | `src/functions/` | The function library; add your own | — |
| `/render` | `smaltkit/graph` | Draw any graph with WebGPU, 2D and 3D | smaltkit |
| `/timeline` | `smaltkit/timeline` | A timeline over a graph's versions | smaltkit |
| `/client` | `src/client/` | Talk to a graph in a Web Worker (about 3 KB) | — |
| `/worker` | `src/worker/worker.ts` | The worker script | the engine and Cypher |
| `/worker-runtime` | `src/worker/runtime.ts` | `createHandler`, for a worker of your own | the engine and Cypher |
| `/datasets` | `src/datasets/` | Sample graphs | — |

The site (`docs/`) is built from the same pieces: the playground, the runnable examples and the tech demo use the
client, the worker and the renderer, as any app would.

## Development

Requires Node 20+.

```sh
npm ci
npm run check          # typecheck + tests
npm run bench          # the stores on a 20,000-person network
npm run docs:dev       # the site, with the playground
npm run test:quick     # check + quick browser tests (about a minute)
npm run test:browser   # the full browser tests: renderer and playground (about 5 minutes)
```

## Documentation

- [Getting started](docs/guide/getting-started.md), [examples](docs/guide/examples.md) and [drawing graphs](docs/guide/rendering.md)
- [Cypher](docs/reference/cypher.md), [functions](docs/reference/functions.md) and [where it differs](docs/reference/divergences.md)
- [Plans](docs/reference/plans.md), [stores](docs/reference/stores.md) and [architecture](docs/architecture.md)
- [Decisions](docs/adr/README.md) and [benchmarks](docs/research/benchmarks.md)

<a href="https://smaltworks.dev"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/public/a-smaltworks-project-on-dark.svg"><img alt="A smaltworks project" src="docs/public/a-smaltworks-project.svg" height="28"></picture></a>

MIT License
