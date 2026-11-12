# Where smaltcy differs

smaltcy's Cypher follows openCypher where it reads a feature. These are the known differences.

## Numbers

Numbers are JavaScript doubles. Whether a value is an integer or a float is known from how it was written:

- A literal with a point or an exponent is a float: `7.0 / 2` is `3.5`, `7 / 2` is `3`.
- `toFloat()`, `avg()`, `sqrt()` and the other float functions give floats, and arithmetic with a float stays one.
- A whole-number value read from a property acts as an integer, even if it was stored as `2.0`: `n.x / 2` with
  `n.x = 5.0` is `2`. Use `toFloat(n.x) / 2` to divide as floats.
- Integers are exact up to 2⁵³.

## Not yet supported

- `CALL` procedures and subqueries, `FOREACH`, `LOAD CSV`, `USE` and multiple graphs.
- Temporal and spatial types (`date()`, `point()`).
- Label expressions such as `(n:A|B)` and `(n:!A)`.
- Quantified path patterns (`((a)-->(b)){1,3}`) and path modes from GQL.
- Constraints (`CREATE CONSTRAINT`).
- `shortestPath` with a `WHERE` that filters the path: the condition is checked after the shortest paths are found,
  not during the search.

## Extensions

- `AT VERSION n` and `AT TIME t` before a query, and the functions `version()`, `commits()`, `commit()` and
  `history()`, read a graph's history ([time travel](/guide/time-travel)). They aren't openCypher.

## Other differences

- Ids are the store's integers. CsrStore numbers nodes again when it's built.
- `EXPLAIN` shows smaltcy's own plan steps.
