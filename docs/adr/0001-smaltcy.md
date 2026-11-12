# ADR 0001: smaltcy: a graph engine, Cypher on plans, pluggable stores and a GPU renderer

- **Status:** accepted (owner, 2026-11-11)
- **Date:** 2026-11-11
- **Background:** smaltdb's research notes [Graphs on the plan API](https://github.com/stenhoor/smaltdb/blob/main/docs/research/graph-on-plans.md)
  and [Pluggable storage engines](https://github.com/stenhoor/smaltdb/blob/main/docs/research/pluggable-engines.md),
  and smaltdb's ADRs 0014–0016 (a plan layer that every language targets) and 0028 (pluggable storage engines).

## Context

The owner asked for a graph database for the smalt family: an engine, a Cypher implementation that produces plans
the engine runs, a layer in between so several memory structures can run the same plans, and a site with the
documentation and a demo that draws graphs. The longer-term direction is a hybrid with smaltdb: relationships in the
graph, data in relational tables.

## Decisions

1. **Name:** smaltcy (owner's choice). Repository `smalt-graph-db`; npm package `@smaltworks/smaltcy`.
2. **Layers, as smaltdb has them:** a language (Cypher) makes plans; the engine runs plans and carries no language;
   stores hold the graph. The engine never imports Cypher (`test/modules.test.ts`).
3. **A graph plan of its own,** in the shape of smaltdb's: immutable, JSON, versioned (`planVersion` 1), validated,
   with expressions that read rows by slot and call functions by name. `match` holds a pattern, not a traversal: the
   engine plans it from the store's statistics. The operations follow the research note's G2 (keyed recursion and
   shortest paths) and G5 (`paths`), so a graph plan can later be lowered to smaltdb's relational plans.
4. **Stores behind one interface,** declaring capabilities, as ADR 0028 proposes for smaltdb's engines. Two to start:
   `MemoryStore` (mutable adjacency lists with indexes and an undo log) and `CsrStore` (read-only compressed sparse
   rows). Every store passes one conformance suite and a differential test.
5. **Cypher, a subset first:** the reading clauses, writes, variable-length and shortest paths, aggregates and
   `EXPLAIN` (owner: start with a subset and grow it). The parser is hand-written; there are no runtime
   dependencies.
6. **The renderer is GPU-only** (owner's decision): WebGPU for layout (compute shaders), drawing, labels and picking,
   in 2D and 3D. Where a browser has no WebGPU the view reports it and the rest of smaltcy works.
7. **The site** is VitePress with the family theme, like smaltdb.dev, on GitHub Pages: guide, references and a
   playground. Every Cypher example in the docs runs as a test (`test/docs-examples.test.ts`).

## Persistence

In memory first, with JSON import and export (owner agreed). Durable storage comes with the hybrid: graph data in
smaltdb's pager on OPFS, as a store, so commits, the write-ahead log and recovery stay smaltdb's.

## Open

- **Brand** (owner, 2026-11-11): tagline "Small. Alternative. Connected." and positioning "A graph database for the
  browser that speaks Cypher." The site uses a text wordmark and a placeholder icon until smalt-brand draws the mark
  and picks a product colour.
- **smaltworks.dev** (owner, 2026-11-11): the repository moves under `stenhoor` first; smaltcy is then added to the
  website (its status and product page) by a smalt-brand pull request.
- **The hybrid with smaltdb:** which store comes first (graph tables in smaltdb behind `GraphStore`, or lowering
  graph plans to relational plans), decided with smaltdb's ADR 0028.

## Consequences

- A new memory structure is a class that passes the conformance suite; plans and Cypher don't change.
- Another graph language (GQL, a TypeScript builder) can target the same plans.
- The renderer needs WebGPU; on browsers without it, the playground shows tables only.
