# Functions

Function names are case-insensitive. A `null` argument gives `null` unless the function says otherwise.

## Graph

| Function | Returns |
| --- | --- |
| `id(x)` | The id of a node or relationship |
| `elementId(x)` | The id as a string (`n4`, `r7`) |
| `labels(n)` | A node's labels |
| `type(r)` | A relationship's type |
| `properties(x)` | A node's or relationship's properties as a map |
| `keys(x)` | Property keys |
| `startNode(r)`, `endNode(r)` | A relationship's ends |
| `nodes(p)`, `relationships(p)` | A path's parts |
| `length(p)` | A path's number of relationships |
| `degree(n [, dir [, type]])` | The number of relationships at a node; `dir` is `'out'`, `'in'` or `'both'` |

## Lists

`size`, `head`, `last`, `tail`, `reverse`, `range(start, end [, step])`, `isEmpty`, `coalesce`.

## Strings

`toUpper`, `toLower`, `trim`, `ltrim`, `rtrim`, `substring(s, start [, length])`, `left`, `right`,
`replace(s, find, with)`, `split(s, delimiter)`, `reverse`, `size`.

## Conversion

`toString`, `toInteger`, `toFloat`, `toBoolean`: text that doesn't convert gives `null`. `valueType(x)` names a value's
type.

## Maths

`abs`, `ceil`, `floor`, `round(x [, digits])`, `sqrt`, `sign`, `exp`, `log`, `log10`, `sin`, `cos`, `tan`, `asin`,
`acos`, `atan`, `atan2`, `pi()`, `e()`, `rand()`.

## History

For a graph that keeps history ([time travel](/guide/time-travel)); `null` otherwise.

| Function | Returns |
| --- | --- |
| `version()` | The version the query reads |
| `commits()` | Every commit up to that version, as maps: `version`, `time`, `at`, `author`, `message`, `changes`, counts |
| `commit(v)` | One commit, or `null` |
| `history(x)` | Every change to a node or relationship up to that version: its commit, plus `change`, `key`, `old`, `new`, `label` |

## Other

`timestamp()`: milliseconds since 1970.

```cypher
RETURN toUpper('ada') AS name, size([1, 2, 3]) AS n, round(2.567, 2) AS r, range(0, 10, 5) AS steps
```
