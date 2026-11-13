# Using the pieces

smaltcy is made of pieces that work on their own: a language, a plan format, an engine, stores, a function library, a
renderer and a worker client. Each is its own entry point. Import only the one you need, and your bundle holds that
piece and what's beneath it, nothing more.

```
                     @smaltworks/smaltcy  (open(): Cypher + engine)
                       ╱               ╲
   /cypher  (Cypher → plans)        /engine  (runs plans)
          ╲                          ╱       ╲
           /plan  (the plan format)          /store  (memory structures)
                 │
           /functions  (the function library)

   /render   (the GPU graph view: depends on nothing else)
   /client   (talks to /worker from the page: carries no engine)
   /datasets (sample graphs as JSON)
```

| Entry point | Use it to | Brings with it |
| --- | --- | --- |
| `@smaltworks/smaltcy` | Query a graph with Cypher: `open()`, `Graph` | Cypher, the engine, the stores |
| `@smaltworks/smaltcy/cypher` | Turn Cypher into plans, without running them | the plan format, the function library |
| `@smaltworks/smaltcy/engine` | Run plans from any language or program, on any store | the plan format, the stores, the function library |
| `@smaltworks/smaltcy/plan` | Build, check and send plans: types, builders, `validatePlan` | the function library |
| `@smaltworks/smaltcy/store` | Use or write a memory structure: `GraphStore`, `MemoryStore`, `CsrStore` | nothing |
| `@smaltworks/smaltcy/history` | Keep every version of a graph: `HistoryStore`, past versions, diffs ([time travel](./time-travel)) | the stores |
| `@smaltworks/smaltcy/functions` | Add functions every language sees; compare values as Cypher does | nothing |
| `@smaltworks/smaltcy/render` | Draw any graph with WebGPU, in 2D or 3D | `smaltkit/graph` (re-exported) |
| `@smaltworks/smaltcy/timeline` | A timeline to move through a graph's versions ([time travel](./time-travel)) | `smaltkit/timeline` (re-exported) |
| `@smaltworks/smaltcy/client` | Query a graph that runs in a Web Worker | nothing (about 3 KB) |
| `@smaltworks/smaltcy/worker` | The worker script: the engine and Cypher, off the page's thread | |
| `@smaltworks/smaltcy/worker-runtime` | `createHandler`, for a worker of your own | the engine, Cypher, the sample data |
| `@smaltworks/smaltcy/datasets` | Sample graphs, for demos and tests | nothing |

`test/modules.test.ts` keeps it this way. It checks which parts of the source each part imports, and it bundles
every entry point on its own to check what each one really pulls in.

Every example on this page is type-checked by the tests.

## The renderer, with your own data

The renderer knows nothing about smaltcy's engine. It is the smalt family's shared graph view, `smaltkit/graph`
(re-exported here), so other apps, such as a BI report drawing data from a graph, use the same one. Give it nodes and
edges from anywhere:

```ts
import { createGraphView, GpuUnavailableError } from '@smaltworks/smaltcy/render';

const canvas = document.querySelector('canvas')!;
try {
  const view = await createGraphView(canvas, { mode: '3d', theme: 'dark' });
  const people = ['Ada', 'Alan', 'Grace'];
  view.setGraph({
    nodes: people.map((name) => ({ id: name, label: name, group: 'Person' })),
    edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }],
  });
  view.onClick((hit) => {
    if (hit?.kind === 'node') console.log(people[hit.index]);
  });
} catch (e) {
  if (!(e instanceof GpuUnavailableError)) throw e;
}
```

To draw query results, `resultsToGraph` collects every node, relationship and path in them. Its `nodes` are in drawing
order, so a click's `index` finds the node:

```ts
import { open } from '@smaltworks/smaltcy';
import { createGraphView, resultsToGraph } from '@smaltworks/smaltcy/render';

const db = open();
db.run("CREATE (:Person {name: 'Ada'})-[:KNOWS]->(:Person {name: 'Alan'})");

const view = await createGraphView(document.querySelector('canvas')!);
const { graph, nodes } = resultsToGraph(db.run('MATCH p = ()-[:KNOWS]->() RETURN p').rows);
view.setGraph(graph);
view.onClick((hit) => {
  if (hit?.kind === 'node') console.log(nodes[hit.index]!.properties);
});
```

## The engine, without Cypher

The engine runs plans, plain JSON. A program or another language can build them. Here is
`MATCH (p:Person) WHERE p.born > 1900 RETURN p.name AS name`, built by hand:

```ts
import { GraphEngine, MemoryStore, PLAN_VERSION, e, type QueryPlan } from '@smaltworks/smaltcy/engine';

const store = new MemoryStore();
store.createNode(['Person'], { name: 'Ada', born: 1815 });
store.createNode(['Person'], { name: 'Grace', born: 1906 });

const plan: QueryPlan = {
  kind: 'query',
  planVersion: PLAN_VERSION,
  slots: 2,
  slotNames: ['p', 'name'],
  root: {
    op: 'project',
    discard: false,
    items: [{ slot: 1, expr: e.prop(e.slot(0), 'name') }],
    input: {
      op: 'match',
      optional: false,
      input: { op: 'argument', slots: [] },
      pattern: { nodes: [{ slot: 0, labels: ['Person'] }], rels: [] },
      where: e.gt(e.prop(e.slot(0), 'born'), e.lit(1900)),
    },
  },
  columns: [{ name: 'name', slot: 1 }],
};

const engine = new GraphEngine(store);
console.log(engine.run(plan).rows); // [['Grace']]
console.log(engine.explainText(plan));
```

[Plans](/reference/plans) describes every operation.

## Cypher, without running it

`compile` turns Cypher into a plan. Keep it, send it to a worker or a server, or run it on any engine later:

```ts
import { compile } from '@smaltworks/smaltcy/cypher';
import { GraphEngine, CsrStore, MemoryStore, type GraphPlan } from '@smaltworks/smaltcy/engine';

const { plan } = compile("MATCH (a:Person)-[:KNOWS]->(b) RETURN a.name, b.name");
const wire = JSON.stringify(plan);

// Elsewhere: the same plan, on two different stores.
const received = JSON.parse(wire) as GraphPlan;
const store = new MemoryStore();
new GraphEngine(store).run(received);
new GraphEngine(CsrStore.from(store)).run(received);
```

## A store of your own

A store is any class that implements `GraphStore`. The engine plans every query from the store's statistics and
capabilities, so plans and Cypher don't change. Wrap a store to log what the engine asks of it:

```ts
import { GraphEngine, MemoryStore, type GraphStore, type AdjacentFn } from '@smaltworks/smaltcy/engine';

class CountingStore extends MemoryStore {
  override readonly name = 'counting';
  expansions = 0;
  override expand(...args: Parameters<GraphStore['expand']>): void {
    this.expansions++;
    super.expand(...args);
  }
}

const store = new CountingStore();
const engine = new GraphEngine(store);
const noop: AdjacentFn = () => {};
store.expand(0, 'out', null, noop);
console.log(store.expansions, engine.store.name);
```

A store that isn't built on `MemoryStore` implements the whole interface: statistics, scans, property lookups, labels
and properties, `expand`, and, if it writes, the writes and `begin` / `commit` / `rollback`. [Stores](/reference/stores)
lists them. Then run `test/store-conformance.test.ts` and the Cypher suites on it.

## Functions of your own

A function you register is callable from every plan and every language. In Cypher it's case-insensitive:

```ts
import { registerFunction, registerAggregate } from '@smaltworks/smaltcy/functions';
import { open } from '@smaltworks/smaltcy';

registerFunction('initials', {
  arity: [1, 1],
  fn: ([name]) => (typeof name === 'string' ? name.split(/\s+/).map((w) => w[0]).join('') : null),
});

registerAggregate('longest', {
  arity: [1, 1],
  init: () => ({ best: null as string | null }),
  step: (state, [v]) => {
    const s = state as { best: string | null };
    if (typeof v === 'string' && (s.best === null || v.length > s.best.length)) s.best = v;
    return s;
  },
  final: (state) => (state as { best: string | null }).best,
});

const db = open();
db.run("CREATE (:Person {name: 'Grace Hopper'}), (:Person {name: 'Ada Lovelace'})");
db.query('MATCH (p:Person) RETURN initials(p.name) AS i, longest(p.name) AS l');
```

## Off the page's thread

The engine and Cypher can run in a Web Worker. The page imports only the client, which carries no engine:

```ts
import { connect } from '@smaltworks/smaltcy/client';

const db = connect(new Worker(new URL('@smaltworks/smaltcy/worker', import.meta.url), { type: 'module' }));
await db.dataset({ name: 'social' }); // a sample graph, generated in the worker
const result = await db.run('MATCH (p:Person) RETURN count(p) AS people');
console.log(result.rows);
```

To put your own functions or store in the worker, write a worker of your own around `createHandler`, the same message
handling `@smaltworks/smaltcy/worker` uses, and connect to it the same way:

```ts
// my-worker.ts
import { open, CsrStore } from '@smaltworks/smaltcy';
import { createHandler } from '@smaltworks/smaltcy/worker-runtime';
import { registerFunction } from '@smaltworks/smaltcy/functions';
import { social } from '@smaltworks/smaltcy/datasets';

registerFunction('shout', { arity: [1, 1], fn: ([v]) => (typeof v === 'string' ? v.toUpperCase() : null) });

const graph = open();
graph.load(social());
const handler = createHandler(open({ store: CsrStore.from(graph.store) }));
self.onmessage = (e: MessageEvent) => self.postMessage(handler.handle(e.data));
```

## Sample data

```ts
import { network, metro } from '@smaltworks/smaltcy/datasets';
import { open, CsrStore } from '@smaltworks/smaltcy';

const db = open();
db.load(network(10_000)); // 10,000 people, about 30,000 relationships
const readOnly = open({ store: CsrStore.from(db.store) });
readOnly.query('MATCH (p:Person) RETURN count(p) AS n');
console.log(metro().nodes.length);
```
