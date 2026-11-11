# Plans

The engine runs **graph plans**, not Cypher. A plan is plain data: a tree of operations whose expressions read the
current row by **slot** number. Cypher is one way to make plans (`compile()` shows them); a program or another
language can build them directly.

```ts
import { GraphEngine, MemoryStore, PLAN_VERSION, e, type QueryPlan } from '@smaltworks/smaltcy/engine';

// MATCH (x:P {name: 'a'})-[:R*2]->(y) RETURN y.name AS name
const plan: QueryPlan = {
  kind: 'query',
  planVersion: PLAN_VERSION,
  slots: 4,
  slotNames: ['x', 'r', 'y', 'name'],
  root: {
    op: 'project',
    discard: false,
    items: [{ slot: 3, expr: e.prop(e.slot(2), 'name') }],
    input: {
      op: 'match',
      optional: false,
      input: { op: 'argument', slots: [] },
      pattern: {
        nodes: [{ slot: 0, labels: ['P'], props: e.map({ name: e.lit('a') }) }, { slot: 2, labels: [] }],
        rels: [{ slot: 1, from: 0, to: 1, dir: 'out', types: ['R'], min: 2, max: 2 }],
      },
    },
  },
  columns: [{ name: 'name', slot: 3 }],
};

const engine = new GraphEngine(new MemoryStore());
engine.run(plan).rows;
```

## Rows and slots

A row is an array of `slots` values. Each operation passes rows on with more slots bound, fewer rows, or new rows.
The leaf of a plan is `argument`: one row, carrying the slots it lists from the row it's run from (none at the top).

## Operations

| Operation | Does |
| --- | --- |
| `argument` | One row |
| `match` | Every way a pattern matches, per input row; `optional` keeps rows with no match |
| `filter` | Rows where `pred` is true |
| `project` | Computes slots; `discard` clears every other slot (a new scope) |
| `aggregate` | One row per group of `keys`, with aggregate calls |
| `distinct` | Drops repeated rows, compared on the given slots |
| `sort` | Stable sort by keys |
| `limit` | `skip` and `count` |
| `unwind` | One row per list element |
| `eager` | Reads all its input before passing any on, so later writes can't change what was read |
| `union` | The rows of each input, written to the same slots |
| `create`, `merge`, `set`, `remove`, `delete` | Writes |

## Patterns

A `match` describes **what** to find, never **how**: its pattern lists nodes (a slot, labels, properties) and
relationships (a slot, the indexes of their two nodes, a direction, types, and `min` / `max` hops for variable-length
ones). The engine's planner chooses where to start (a node already bound, an index seek, a label scan) and the order
to expand in from the store's statistics, and puts each condition at the first step where all it reads is bound.
`EXPLAIN` shows the choice.

## Expressions

| Kind | Form |
| --- | --- |
| `lit`, `param`, `slot` | A constant, a parameter, a slot of the row |
| `prop` | A property of a node, relationship or map |
| `call` | A function from the engine's library, by name: `eq`, `add`, `toUpper` … |
| `and`, `or`, `xor`, `not`, `isNull` | Three-valued logic |
| `list`, `map`, `index`, `slice`, `case`, `hasLabels` | |
| `listComp`, `quantifier` | Over a list, with the element in a slot |
| `exists`, `collectSub` | A nested plan run from the current row |

## Validation

`engine.run` validates a plan first: its version, slot numbers, that every expression reads only slots bound where
it is, that pattern indexes point into their pattern, and that every function exists with the right number of
arguments. A mistake in a plan fails with `SMALTCY_PLAN`, not a wrong answer.

Plans are versioned with `planVersion` (now `1`) and stay JSON: a plan can be stored, sent to a worker or written by
hand.
