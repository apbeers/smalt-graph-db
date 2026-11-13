# ADR 0003: Drawing lives in smaltkit

Date: 2026-11-13. Status: accepted.

## Context

smaltcy's GPU graph view (`src/render`) and its version timeline (`src/timeline`) were written here, and were already
kept apart from the rest: neither imported anything else from smaltcy. smaltbi will have visuals that draw data from the
graph database, and the smalt apps share their browser code through smaltkit (smaltbi ADR 0005): its charts, maps and
tables are there. A graph view that only smaltcy can import would be copied, and the copies would drift.

## Decision

- The graph view is `smaltkit/graph` and the timeline is `smaltkit/timeline`, in stenhoor/smaltkit, with their unit
  tests and browser tests (stenhoor/smaltkit#31).
- smaltcy depends on smaltkit, pinned to a commit (`github:stenhoor/smaltkit#<commit>`) until smaltkit is on npm. It is
  smaltcy's only runtime dependency.
- `@smaltworks/smaltcy/render` and `@smaltworks/smaltcy/timeline` stay, as re-exports, so code that imports them keeps
  working, and a page using smaltcy gets the drawing from one package. `dist/` leaves smaltkit external: an app's
  bundler resolves it once, for every package that uses it.
- Changes to the drawing go to smaltkit first (its own PR and tests), then the pin moves here.
- In smaltkit the view gained `theme: 'css'`, which takes its colours from the `--sk-*` properties the charts read, so
  a report's theme recolours its graphs. smaltcy's site keeps `'light'` and `'dark'`.

## Consequences

- `test/modules.test.ts` allows `render` and `timeline` to import their smaltkit module and nothing else, and no other
  layer to import smaltkit.
- smaltcy's CI runs the site's browser suite (playground, demo, runnable docs); the graph view's and timeline's own
  browser suites run in smaltkit's CI.
- Installing smaltcy fetches and builds smaltkit from GitHub until it is published.
