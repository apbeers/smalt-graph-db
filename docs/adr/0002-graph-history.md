# ADR 0002: Graph history: versions, time travel and temporal Cypher

- **Status:** accepted (owner, 2026-11-12)
- **Date:** 2026-11-12

## Context

smaltcy will hold the ontology of the whole platform: its systems, data, flows and how they connect. The owner wants
to see that graph at any point in its past, and to drag a timeline and watch it change.

## Decisions

1. **Every committed write is a version** (owner). One statement, or one `transaction()`, however many changes it
   makes. Reads, no-op writes and rollbacks make none. Version 0 is the graph before the first commit.
2. **Commits carry time, author and message** (owner: include the author). The author defaults to the graph's.
3. **Keep everything by default** (owner). `forget(v)` drops older versions when asked.
4. **History is a store.** `HistoryStore` (`src/history/`) wraps a writable store and records each change in a form
   that applies either way, with a snapshot of the whole graph every 2,000 changes. A past version opens as a
   read-only store, so the engine, the plan format and the other clauses of Cypher are unchanged. Ids are never
   reused, so they're stable across versions.
5. **Temporal querying is in Cypher in this round** (owner):
   - `AT VERSION n` and `AT TIME t` before a query, carried in the plan as `asOf` (a literal or a parameter; such a
     plan can't write);
   - the functions `version()`, `commits()`, `commit(v)` and `history(x)`.

   These are smaltcy's extensions, listed with the divergences.
6. **Diffs drive the timeline.** `diff(a, b)` gives the net changes between two versions either way. The drawing
   applies them with animated transitions, so scrubbing never reloads the graph.
7. **The timeline is its own module** (`@smaltworks/smaltcy/timeline`): a DOM widget that knows commits and reports a
   version, and imports nothing else. Its default spacing is one step per commit (owner), with time spacing as an
   option.

## Consequences

- **Memory:** history grows with every change: a change is a small object, and snapshots are copies of the graph. A
  long-lived graph will want `forget()` or, later, durable storage.
- **Storage later:** durable history belongs in smaltdb's storage. A change log maps closely onto its write-ahead log.
- **Later queries:** "when did this change" across all of history works through `history(x)` today. An index of when
  each element was valid would make such queries fast at scale, and would allow joining versions in one query.
