# Drawing graphs

`@smaltworks/smaltcy/render` draws a graph on a canvas with WebGPU. The force-directed layout runs in compute
shaders, and nodes, relationships, labels and picking are all drawn on the GPU, in 2D or 3D. It is the smalt family's
shared graph view, `smaltkit/graph`, re-exported: import it from either. With `theme: 'css'` it takes its colours from
the page's `--sk-*` custom properties (`--sk-surface`, `--sk-border`, `--sk-text`, `--sk-sel`, the group colours
`--sk-c0` to `--sk-c11`), the ones smaltkit's charts read.

```ts
import { createGraphView, GpuUnavailableError } from '@smaltworks/smaltcy/render';

const canvas = document.querySelector('canvas')!;
try {
  const view = await createGraphView(canvas, { mode: '2d', theme: 'light', labels: true });
  view.setGraph({
    nodes: [{ id: 'ada', label: 'Ada', group: 'Person' }, { id: 'alan', label: 'Alan', group: 'Person' }],
    edges: [{ source: 0, target: 1, label: 'KNOWS' }],
  });
  view.onClick((hit) => console.log(hit)); // { kind: 'node', index: 0 } or null
} catch (e) {
  if (e instanceof GpuUnavailableError) {
    // This browser has no WebGPU: show the results as a table instead.
  }
}
```

## The graph

- `nodes`: `id` (any string or number), `label` (the caption), `group` (colours the node; use the first label),
  `size` (relative, default 1).
- `edges`: `source` and `target` are **indexes into `nodes`**, with an optional `label` and `group`.
- `setGraph(graph, { keepPositions: true })` keeps the place of every node whose `id` was already drawn, so a
  graph can grow without jumping around.

## The view

| Call | Does |
| --- | --- |
| `setMode('2d' \| '3d')` | Switches between the flat and the 3D view, keeping the layout |
| `setTheme('light' \| 'dark')` | Kiln colours for the page's theme |
| `setLayoutMode('force' \| 'fixed')` | Force: nodes pull on their neighbours and push the rest away. Fixed: nodes locked in place, spread out in a cluster per group, highest-degree at the centre; nothing overlaps, and a node you drag stays where you drop it |
| `setSpread(factor)` | Moves every node closer together (below 1) or farther apart (above 1), from 0.2 to 5, eased; holds the camera so the nodes visibly move |
| `setLabels(on)` | Captions on or off (hovered and highlighted nodes always show theirs) |
| `search(text)` | Highlights nodes whose caption, id or group contains the text; returns their indexes |
| `highlight(indexes \| null)` | Highlights nodes and their relationships, and dims the rest |
| `focus(index)` | Moves the camera to a node |
| `fit()` | Frames the whole graph |
| `onHover(fn)`, `onClick(fn)` | Called with `{ kind: 'node' \| 'edge', index }` or `null`, from GPU picking |
| `layout.start()`, `layout.stop()`, `layout.reheat()` | Controls the force layout, which stops by itself once it settles |
| `pick(x, y)`, `screenPosition(index)` | The node or edge at a point, and where a node is, in CSS pixels |
| `stats()` | Nodes, edges, frames per second and layout time per tick |
| `destroy()` | Frees the GPU resources |

Moving around:

| | Mouse and keyboard | Touch |
| --- | --- | --- |
| Pan | 2D: drag the background. Both modes: Shift-drag, right- or middle-drag, or hold Space and drag | Two fingers (2D: one finger too) |
| Zoom | Scroll | Pinch with two fingers |
| Tilt and turn (3D) | Drag | One finger |
| Move a node | Drag it | Drag it |
| Keyboard | With the canvas focused: arrow keys pan (Shift: further), `+` and `-` zoom | |

Panning with a modifier or two fingers moves the camera even over a node.

## The layout

One compute pass per tick, one GPU thread per node: every node repels every other (in tiles of 256 in workgroup
memory; sampled above 20,480 nodes), relationships pull their ends together, and gravity holds the graph to the
centre. The layout cools and stops by itself, and the view draws only when something changes, so a settled graph
costs no GPU time.

In fixed mode the layout is computed on the CPU (about 25 ms for 100,000 nodes) and doesn't move: while a timeline
scrubs, nodes that stay keep their place and new ones take a free place in their group's cluster. `layoutMode` and
`spread` can also be set when the view is made: `createGraphView(canvas, { layoutMode: 'fixed', spread: 1.5 })`.

The `layoutTicks` option sets how many ticks the layout takes to cool (default 300). Fewer settle sooner and less
evenly: `createGraphView(canvas, { layoutTicks: 100 })`.

## From query results

The playground collects every node, relationship and path in a result and draws them. The same in a few lines:

```ts
const result = db.run("MATCH p = (:Person {name: 'Ada'})-[:KNOWS*1..2]->() RETURN p");
const nodes = new Map<number, { id: number; label: string; group: string }>();
const edges: { start: number; end: number; type: string }[] = [];
for (const [p] of result.rows) {
  for (const n of p.nodes) nodes.set(n.id, { id: n.id, label: String(n.properties.name), group: n.labels[0] });
  for (const r of p.relationships) edges.push({ start: r.start, end: r.end, type: r.type });
}
const order = [...nodes.keys()];
view.setGraph({
  nodes: [...nodes.values()],
  edges: edges.map((e) => ({ source: order.indexOf(e.start), target: order.indexOf(e.end), label: e.type })),
});
```

## Browsers

The view needs WebGPU. Where a browser doesn't offer it, `createGraphView` rejects with `GpuUnavailableError`, and
the rest of smaltcy works as before.
