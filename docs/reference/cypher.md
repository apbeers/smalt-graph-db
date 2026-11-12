# Cypher

smaltcy reads a subset of openCypher: the clauses and expressions most queries use. Anything outside it fails with
`SMALTCY_SYNTAX` or `SMALTCY_SEMANTIC`, never with a wrong answer. The subset will grow; [where it
differs](./divergences) lists the known differences.

## Clauses

| Clause | Notes |
| --- | --- |
| `MATCH pattern [WHERE …]` | Several comma-separated parts; relationships are distinct within one `MATCH` |
| `OPTIONAL MATCH pattern [WHERE …]` | Rows with no match keep going, with the new variables `null` |
| `WITH [DISTINCT] items [ORDER BY …] [SKIP n] [LIMIT n] [WHERE …]` | Starts a new scope; expressions need `AS` |
| `RETURN [DISTINCT] items \| * [ORDER BY …] [SKIP n] [LIMIT n]` | Ends a reading query |
| `UNWIND list AS x` | One row per element |
| `CREATE pattern` | Relationships need one type and a direction |
| `MERGE pattern [ON CREATE SET …] [ON MATCH SET …]` | Matches the whole pattern or creates it |
| `SET n.key = v`, `n = map`, `n += map`, `n:Label` | `null` removes a property |
| `REMOVE n.key`, `n:Label` | |
| `DELETE x`, `DETACH DELETE x` | Nodes, relationships, paths and lists of them |
| `… UNION [ALL] …` | Every part returns the same columns |
| `CREATE INDEX [name] [IF NOT EXISTS] FOR (n:Label) ON (n.key)` | Also `CREATE INDEX ON :Label(key)` |
| `DROP INDEX ON :Label(key)` | |
| `EXPLAIN …` | The plan, not the rows |
| `AT VERSION n …`, `AT TIME t …` | Read the graph as it was, for a graph that keeps history ([time travel](/guide/time-travel)). `n` and `t` are values or parameters; `t` is ISO 8601 text or milliseconds. smaltcy's own: not openCypher |

## Patterns

```cypher
MATCH (a:Person {name: 'Ada'})-[k:KNOWS]->(b)-[:LIVES_IN]->(c:City)
RETURN a, k, b
```

- Nodes: `(var:Label:Other {key: value})`; every part is optional, `()` is any node.
- Relationships: `-[var:TYPE|OTHER {key: value}]->`, `<-[…]-`, or `-[…]-` for either direction. `-->` and `--` are
  short forms.
- Variable length: `-[:KNOWS*]->` (one or more), `*2` (exactly two), `*1..3`, `*..3`, `*2..`. The variable holds the
  list of relationships.
- Named paths: `p = (a)-[*]->(b)`.
- Shortest paths: `shortestPath((a)-[:KNOWS*]-(b))` and `allShortestPaths(…)`, between nodes bound elsewhere in the
  pattern.
- Properties in a pattern may be a map or a parameter: `(p:Person $props)`.

## Expressions

| Kind | Forms |
| --- | --- |
| Literals | `1`, `-2.5`, `1e3`, `0x1F`, `'text'`, `"text"`, `true`, `null`, `[1, 2]`, `{key: value}` |
| Parameters | `$name` |
| Properties | `n.name`, `map.key`, `n['name']` |
| Arithmetic | `+ - * / % ^`; `+` also joins strings and lists |
| Comparison | `= <> < <= > >=`, chained: `1 < x < 5` |
| Logic | `AND OR XOR NOT`, three-valued with `null` |
| Strings | `STARTS WITH`, `ENDS WITH`, `CONTAINS`, `=~` (a regular expression over the whole string) |
| Lists | `IN`, `list[i]`, `list[-1]`, `list[1..3]`, `[x IN list WHERE … \| …]`, `any/all/none/single(x IN list WHERE …)` |
| Nulls | `IS NULL`, `IS NOT NULL`, `coalesce(…)` |
| Labels | `n:Label` as a condition |
| Patterns | `(a)-[:KNOWS]->()` as a condition, `EXISTS { MATCH … WHERE … }`, `[(a)-->(b) \| b.name]` |
| Conditionals | `CASE WHEN … THEN … ELSE … END`, `CASE x WHEN 1 THEN … END` |

## Aggregates

`count(x)`, `count(*)`, `sum`, `avg`, `min`, `max`, `collect`, `stDev`, `stDevP`, each with `DISTINCT`. Items
without an aggregate group the rows:

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c:City)
RETURN c.name AS city, count(*) AS people, collect(p.name) AS names
```

The [functions](./functions) page lists the scalar functions.
