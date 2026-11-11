# Getting started

smaltcy is a graph database that runs in the page. Every example in these docs runs where it stands: press **Run**
under one to see its result, drawn as a graph when it has nodes or relationships ([sample data](./sample-data)). You store nodes and relationships, each with labels or a type
and properties, and you query them with Cypher.

## Install

```sh
npm install @smaltworks/smaltcy
```

## A first graph

```ts
import { open } from '@smaltworks/smaltcy';

const db = open(); // an in-memory graph

db.run(`
  CREATE (ada:Person {name: 'Ada', born: 1815}),
         (alan:Person {name: 'Alan', born: 1912}),
         (ada)-[:KNOWS {since: 1833}]->(alan)
`);

const rows = db.query('MATCH (a:Person)-[k:KNOWS]->(b) RETURN a.name AS a, b.name AS b, k.since AS since');
// [{ a: 'Ada', b: 'Alan', since: 1833 }]
```

- `db.run(cypher, params)` returns a result: `columns`, `rows`, the write `counts` and the time it took.
- `db.query(cypher, params)` returns the rows as objects.
- Nodes come back as `{ kind: 'node', id, labels, properties }`, relationships as
  `{ kind: 'relationship', id, type, start, end, properties }` and paths as `{ kind: 'path', nodes, relationships }`.

## Parameters

Pass values with `$name`, never by building strings:

```cypher noplay
MATCH (p:Person) WHERE p.born > $year RETURN p.name
```

```ts
db.query('MATCH (p:Person) WHERE p.born > $year RETURN p.name', { year: 1900 });
```

## Indexes

Lookups by label and property scan the label until there's an index:

```cypher
CREATE INDEX FOR (p:Person) ON (p.name)
```

Put `EXPLAIN` before a query to see the plan the engine chose. With the index, the first step is a `NodeIndexSeek`:

```cypher
EXPLAIN MATCH (p:Person {name: 'Ada'})-[:KNOWS]->(f) RETURN f.name
```

## Transactions

Each statement that writes is atomic: if it fails, nothing it did stays. To make several statements one unit:

```ts
db.transaction((tx) => {
  tx.run("CREATE (:Account {id: 1, balance: 100})");
  tx.run("CREATE (:Account {id: 2, balance: 0})");
});
```

## Next

- The [playground](/playground) runs Cypher on sample graphs and draws the results.
- [Examples](./examples) shows common queries.
- The [Cypher reference](/reference/cypher) lists what smaltcy reads.
