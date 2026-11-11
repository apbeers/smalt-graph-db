# Stores

A **store** keeps the graph in memory, in a structure of its own. Every store runs the same plans: the engine reads
what a store can do (its capabilities) and its statistics, and plans each query for it.

| Store | Structure | Writes | Property lookups |
| --- | --- | --- | --- |
| `MemoryStore` | Maps, with each node's outgoing and incoming relationship ids in lists | Yes, with transactions (an undo log) | Indexes you create with `CREATE INDEX` |
| `CsrStore` | Compressed sparse rows: each node's relationships next to each other in typed arrays; properties by key | No: built from another store | Every (label, key) pair, indexed the first time a query looks it up |

```ts
import { open, CsrStore } from '@smaltworks/smaltcy';

const db = open();             // MemoryStore
db.load(bigGraph);
const fast = open({ store: CsrStore.from(db.store) }); // read-only, compact
fast.query('MATCH (a)-[:KNOWS*1..3]-(b) RETURN count(*)');
```

Build a `CsrStore` when a graph is loaded once and read many times. [Benchmarks](/research/benchmarks) compare the
two.

## Writing a store

A store implements `GraphStore` from `@smaltworks/smaltcy/engine`:

- **Statistics:** node and relationship counts, by label and type. The planner uses them to choose where to start and
  which way to expand.
- **Reads:** scan nodes (by label), look nodes up by property (or return `null` to make the engine scan), labels and
  properties, relationship ends and types, and `expand(node, direction, types, fn)`, which calls `fn` with each
  relationship and the node at its other end.
- **Capabilities:** whether it writes, and how it answers property lookups (`'declared'`, `'all'` or `'none'`).
- **Writes and transactions** (`begin`, `commit`, `rollback`) when it writes.

Every store must pass `test/store-conformance.test.ts`, the Cypher suites and the differential test, which runs the
same queries on random graphs in every store and compares the rows.
