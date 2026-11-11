# CLAUDE.md

smaltcy (repository `smalt-graph-db`, npm `@smaltworks/smaltcy`) is a graph database for the browser in TypeScript:
Cypher compiles to graph plans, an engine runs plans on pluggable stores, and a WebGPU renderer draws graphs. It is
part of the smalt family: smaltdb's CLAUDE.md has the family's shared working rules, and they apply here too.

## Brand: read smalt-brand first

Before changing the site, the README or how the product is described, read smalt-brand's `BRAND.md` and
`DECISIONS.md`. Copy the site theme (`docs/.vitepress/theme/{shiki.ts,smaltdb.css,smaltworks.ts,stage.ts}`) and the
badges unchanged from the family. smaltcy has no mark or product colour yet (ADR 0001, "Open"): don't invent one.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Installs dependencies |
| `npm run check` | Typecheck, then the tests (vitest). Before every commit |
| `npm run test:browser` | The renderer and the playground in headless Chromium with WebGPU (SwiftShader), about 5 minutes. What CI runs |
| `npm run test:quick` | `check`, then the browser tests with `--quick` (smaller graphs, fewer steps), about a minute. While working on `src/render/` or the playground |
| `npm run bench` | The stores on a generated network; compare with docs/research/benchmarks.md |
| `npm run docs:dev` / `docs:build` | The site with the playground |
| `npm run build` | `dist/` and type declarations |

Playwright is installed globally in the cloud containers; don't run `playwright install`.

## Layers and rules

- `src/engine`, `src/plan` and `src/store` never import `src/cypher` or `src/render` (`test/boundary.test.ts`).
- Plans say what, never how: no store names or traversal orders in the plan format. The match planner decides.
- A new store passes `test/store-conformance.test.ts`, the Cypher suites (`describe.each` over stores) and the
  differential test.
- Every Cypher block in `docs/` and every playground example runs in `test/docs-examples.test.ts`.
- A Cypher feature that isn't supported fails with an error, never a wrong answer; list it in
  `docs/reference/divergences.md`.
- No runtime dependencies. Ask the owner before adding any package, as the family's rules say.
- No fixed sleeps in tests. Probe tests (`test/zz-*.test.ts`) are scratch: never commit them.
- A significant decision gets an ADR in `docs/adr/`.
