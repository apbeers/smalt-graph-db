# In a Web Worker

Queries on large graphs take time. Run the graph in a Web Worker and the page stays responsive: the client has the
same calls as `open()`, as promises.

```ts
import { connect } from '@smaltworks/smaltcy';

const worker = new Worker(new URL('@smaltworks/smaltcy/worker', import.meta.url), { type: 'module' });
const db = connect(worker);

await db.load(myGraphJson);
const result = await db.run('MATCH (n) RETURN count(n) AS n');
```

| Call | Returns |
| --- | --- |
| `run(cypher, params)` | The result, as `Graph.run` returns it |
| `load(json, { replace })` | Adds a graph from JSON; with `replace`, starts from an empty graph |
| `dump()` | The whole graph as JSON |
| `stats()` | Counts of nodes and relationships, by label and type |
| `overview(limit)` | The graph as flat arrays (ids, labels, captions, edges), ready to draw |
| `close()` | Ends the worker |

Errors arrive as `SmaltcyError`s with the same `code` and `position` they have in the worker.
