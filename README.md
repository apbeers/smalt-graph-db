<h1><code>sm<b>alt</b>cy</code></h1>

<a href="https://smaltworks.dev/stability"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/public/work-in-progress-on-dark.svg"><img alt="Work in progress. Come build with us." src="docs/public/work-in-progress.svg" height="56"></picture></a>

**Small. Alternative. Connected.** A graph database for the browser that speaks Cypher, written in TypeScript.

[Documentation](https://andrewbeers.me/smalt-graph-db/) · [Playground](https://andrewbeers.me/smalt-graph-db/playground) · [Tech demo](https://andrewbeers.me/smalt-graph-db/demo) · [smaltworks.dev](https://smaltworks.dev)

**smaltcy** keeps a graph of nodes and relationships in the page and answers Cypher queries on it. Cypher compiles
to **graph plans**, plain JSON that the engine validates and runs, and the engine runs the same plans on any
**store**: an in-memory adjacency store for writes, or a compact CSR store for reads. A WebGPU renderer draws
graphs in 2D and 3D, with the force layout in compute shaders.

> **Status: 0.1.0, work in progress.** A Cypher subset (reading clauses, writes, variable-length and shortest paths,
> aggregates, `EXPLAIN`), two stores, a Web Worker client, JSON import and export, and the GPU renderer. Graphs live
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

| Directory | Contents |
| --- | --- |
| `src/cypher/` | The Cypher language: lexer, parser, binder |
| `src/plan/` | The plan format, builders and validator |
| `src/engine/` | The match planner, operators, function library, EXPLAIN, JSON import and export |
| `src/store/` | The store interface, `MemoryStore` and `CsrStore` |
| `src/render/` | The WebGPU graph view |
| `src/worker/` | The Web Worker and its client |
| `src/datasets/` | Sample graphs |
| `docs/` | The site: guide, references and the playground |

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
