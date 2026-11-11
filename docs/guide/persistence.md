# Saving and loading

A graph lives in memory. To keep it, save it as JSON and load it again:

```ts
import { open } from '@smaltworks/smaltcy';

const db = open();
// … build the graph …
const json = db.toJSON();
localStorage.setItem('graph', JSON.stringify(json));

const again = open();
again.load(JSON.parse(localStorage.getItem('graph')!));
```

The format is plain:

```json
{
  "format": "smaltcy-graph",
  "version": 1,
  "nodes": [{ "id": 0, "labels": ["Person"], "properties": { "name": "Ada" } }],
  "relationships": [{ "start": 0, "end": 1, "type": "KNOWS", "properties": {} }],
  "indexes": [{ "label": "Person", "key": "name" }]
}
```

Node `id`s in a file only connect its relationships; they can be strings. `load` runs in one transaction: a file
with a relationship to a missing node loads nothing.

Durable storage in the browser (OPFS, through smaltdb's pager) is planned: see [ADR 0001](/adr/0001-smaltcy#persistence).
