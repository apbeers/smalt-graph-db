# API

## `@smaltworks/smaltcy`

| Export | What it is |
| --- | --- |
| `open({ store, history })` | A `Graph`: an in-memory `MemoryStore` unless you pass a store; with `history`, every version is kept |
| `Graph` | `run(cypher, params, { author, message })`, `query(…)`, `explain(cypher)`, `transaction(fn, { author, message })`, `load(json)`, `toJSON()`, `engine`, `store` |
| `Graph`, with history | `version`, `commits(from, to)`, `at(version or Date)`, `diff(from, to)`, `history` |
| `connect(worker)` | A `GraphClient` for a graph in a Web Worker ([guide](/guide/worker)) |
| `compile(cypher)` | The plan for a Cypher statement, without running it |
| `MemoryStore`, `CsrStore` | The [stores](./stores) |
| `SmaltcyError` | Every error: `code`, `message`, and `position` (line and column) for errors in the text |

A result:

```ts
interface CypherResult {
  columns: string[];
  rows: ResultValue[][];
  counts: { nodesCreated; nodesDeleted; relationshipsCreated; relationshipsDeleted; propertiesSet; labelsAdded; labelsRemoved };
  ms: number;          // time spent running the plan
  plan: GraphPlan;     // what ran
  explain?: ExplainLine[]; // for EXPLAIN
}
```

## Error codes

| Code | Meaning |
| --- | --- |
| `SMALTCY_SYNTAX` | The text doesn't parse |
| `SMALTCY_SEMANTIC` | The text parses but means nothing: an unknown variable, an aggregate in `WHERE` |
| `SMALTCY_PLAN` | A plan failed validation |
| `SMALTCY_TYPE` | A value had the wrong type when the query ran |
| `SMALTCY_CONSTRAINT` | A write would break the graph, such as deleting a node that still has relationships |
| `SMALTCY_PARAM` | A parameter is missing |
| `SMALTCY_UNSUPPORTED` | The store can't do this, such as a write on a read-only store |
| `SMALTCY_NOT_FOUND` | An unknown function, node or relationship |

## Other entry points

Each piece is its own entry point, and brings only what's beneath it: [Using the pieces](/guide/modules) shows each on
its own.

| Entry | Contents |
| --- | --- |
| `@smaltworks/smaltcy/engine` | The engine with no language: `GraphEngine`, plus the plan format, stores and function library re-exported |
| `@smaltworks/smaltcy/plan` | The plan format, its builders and validator |
| `@smaltworks/smaltcy/functions` | The function library, value comparisons, `registerFunction` and `registerAggregate` |
| `@smaltworks/smaltcy/store` | `GraphStore`, `MemoryStore` and `CsrStore` |
| `@smaltworks/smaltcy/history` | `HistoryStore`, and the types of commits, changes and diffs ([time travel](/guide/time-travel)) |
| `@smaltworks/smaltcy/cypher` | `compile`, `parse` and `bind`: Cypher to plans |
| `@smaltworks/smaltcy/render` | The GPU graph view and `resultsToGraph` ([guide](/guide/rendering)) |
| `@smaltworks/smaltcy/timeline` | `createTimeline`: a DOM timeline over a graph's commits ([time travel](/guide/time-travel)) |
| `@smaltworks/smaltcy/client` | `connect` and `GraphClient`, with no engine: for a page whose graph runs in a worker |
| `@smaltworks/smaltcy/datasets` | The sample graphs: `social`, `family`, `metro`, `network`, `ontology`, and the real-world shapes `orgChart`, `packages`, `airline`, `powerGrid`, `gitHistory`, `supplyChain`, `microservices` |
| `@smaltworks/smaltcy/worker` | The worker script |
| `@smaltworks/smaltcy/worker-runtime` | `createHandler`, to build a worker of your own |
