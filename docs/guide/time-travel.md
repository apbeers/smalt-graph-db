---
dataset: ontology
---

# Time travel

A graph can keep its history. Every committed write becomes a **version**, with its time, author and message, and any
version can be queried or drawn again. Drag a timeline and you see the graph change.

The examples on this page run on the sample **ontology**: a data platform's systems, datasets, flows, teams and
dashboards, changed 26 times over six months by four people. Press **Run** under any of them.

```cypher
UNWIND commits() AS c
RETURN c.version AS version, substring(c.at, 0, 10) AS day, c.author AS author, c.message AS message
```

## Keeping history

```ts
import { open } from '@smaltworks/smaltcy';

const db = open({ history: { author: 'ana' } });
db.run("CREATE (:Dataset {name: 'orders'})", {}, { message: 'Add orders' });               // version 1
db.run("MATCH (d:Dataset {name: 'orders'}) SET d.rows = 1200000", {}, { author: 'bo' });     // version 2
db.transaction((tx) => {
  tx.run("CREATE (:Flow {name: 'load_orders'})");
  tx.run("MATCH (f:Flow), (d:Dataset) CREATE (f)-[:READS]->(d)");
}, { message: 'Load orders' });                                                           // version 3: one transaction

db.version;    // 3
db.commits();  // [{ version: 1, time, author: 'ana', message: 'Add orders', counts, … }, …]
```

- **What counts as a version:** each committed write. That's one statement, or one `transaction()` call however many
  statements it runs. Reads, writes that change nothing, and failed transactions make no version.
- **Commits record** their time, author (the graph's default unless a write names one), message, a count of each
  kind of change, and the graph's size after them.
- **Version 0** is the graph before the first commit.

## Querying the past: `AT VERSION` and `AT TIME`

Put `AT VERSION n` or `AT TIME t` before a query to read the graph as it was. `t` is an ISO 8601 date and time or
milliseconds since 1970, and either can be a parameter. Everything else works as usual.

The platform after its first two weeks:

```cypher
AT VERSION 8
MATCH (n)-[r]->(m)
RETURN n, r, m
```

The same moment, by date:

```cypher
AT TIME '2026-05-16T12:00:00Z'
MATCH (f:Flow)
RETURN f.name AS flow, f.schedule AS schedule, f.status AS status
```

`ingest_orders` was deprecated in July and later removed. It's still there in the past:

```cypher
AT VERSION 18
MATCH (f:Flow {name: 'ingest_orders'})-[r]-(x)
RETURN f, r, x
```

```cypher
MATCH (f:Flow {name: 'ingest_orders'}) RETURN count(f) AS nowadays
```

A query on the past can't write: `AT VERSION 3 CREATE …` fails.

## Temporal functions

| Function | Returns |
| --- | --- |
| `version()` | The version the query reads: the latest, or the one `AT` names |
| `commits()` | Every commit up to that version, oldest first, as maps |
| `commit(v)` | One commit as a map, or `null` |
| `history(x)` | Every change to a node or relationship up to that version, with its commit |

A commit map has `version`, `time` (milliseconds), `at` (ISO 8601), `author`, `message`, `changes`, `nodes`,
`relationships` and a count of each kind of change. A `history()` entry adds `change` (`created`, `set`,
`label added`, `label removed`, `deleted`), plus `key`, `old` and `new` for a property, and `label` for a label.

Who changed what, by author:

```cypher
UNWIND commits() AS c
RETURN c.author AS author, count(*) AS commits, sum(c.changes) AS changes
ORDER BY commits DESC
```

Every change to the `orders` dataset:

```cypher
MATCH (d:Dataset {name: 'orders'})
UNWIND history(d) AS h
RETURN h.version AS version, substring(h.at, 0, 10) AS day, h.author AS author, h.change AS change, h.key AS key, h.old AS old, h.new AS new
```

When personal data was tagged, and on what:

```cypher
MATCH (d:PII)
UNWIND [h IN history(d) WHERE h.label = 'PII'] AS tagged
RETURN d.name AS dataset, tagged.version AS version, tagged.author AS author
ORDER BY version, dataset
```

What fed the churn dashboard when it was built, and what feeds it now:

```cypher
AT VERSION 22
MATCH (:Dashboard {name: 'Churn risk'})-[:SHOWS]->(d)-[:READS|WRITES*1..8]-(x:Dataset)
RETURN DISTINCT x.name AS upstream
ORDER BY upstream
```

## From TypeScript

```ts
import { open } from '@smaltworks/smaltcy';
import { ontology } from '@smaltworks/smaltcy/datasets';

const db = open({ history: true });
db.load(ontology()); // brings all 26 versions

const july = db.at(new Date('2026-07-01')); // a read-only graph: any query works on it
july.query('MATCH (f:Flow) RETURN f.name AS flow');

const diff = db.diff(18, 20); // what changed: nodes and relationships added, removed and changed
diff.nodesRemoved;            // the ids of ingest_orders and raw_orders
db.diff(20, 18);              // the other way: they come back

db.history!.changesOf('node', 0); // every change to node 0, with its commits
```

## The timeline

The [playground](/playground) and the [tech demo](/demo) show a timeline under the graph for any dataset with history.
Drag it, click a commit, or press Play: the drawing follows. New nodes and relationships fade in, deleted ones fade
out, and changed ones flash. Moving the timeline fetches only the difference between two versions (`diff`), so it
stays smooth on large graphs.

`@smaltworks/smaltcy/timeline` is that widget on its own: give it the commits, and it reports the version the reader
picks.

## Saving and forgetting

- **JSON:** `toJSON()` of a graph with history writes format version 2, with every commit. `load()` into an empty graph
  that keeps history brings every version back, with the same ids.
- **Forgetting:** history is kept in full. To drop old versions, `forget(v)` on the store makes version `v` the start:
  `(db.store as HistoryStore).forget(100)`.

## How it's kept

- **The change log:** every change is recorded with what's needed to apply it either way: a property's old and new
  value, and a deleted node's labels and properties.
- **Snapshots:** every 2,000 changes the whole graph is copied. Opening a version starts from the nearest snapshot,
  or from the present when that's nearer, and applies the changes in between.
- **No reused ids:** a node or relationship id is never given out again, so ids stay the same across every version.

The engine, plans and Cypher's other clauses don't change. A past version is just another read-only
[store](/reference/stores), and every query runs on it the same way.
