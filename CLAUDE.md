# CLAUDE.md

smaltcy (repository `smalt-graph-db`, npm `@smaltworks/smaltcy`) is a graph database for the browser in TypeScript:
Cypher compiles to graph plans, an engine runs plans on pluggable stores, and a WebGPU graph view draws graphs. It is
part of the smalt family: smaltdb's CLAUDE.md has the family's shared working rules, and they apply here too.

## Brand: read smalt-brand first

Before changing the site, the README or how the product is described, read smalt-brand's `BRAND.md` and
`DECISIONS.md`. Copy the site theme (`docs/.vitepress/theme/{shiki.ts,smaltdb.css,smaltworks.ts,stage.ts}`) and the
badges unchanged from the family. smaltcy has no mark or product colour yet (ADR 0001, "Open"): don't invent one.

## Workflow

Early development (owner, 2026-11-12): no pull requests. When work is done and `npm run check` passes, commit and push
it straight to `main`. This replaces the family rule of one PR per task until the owner says otherwise.

The site (https://andrewbeers.me/smalt-graph-db/) deploys from `.github/workflows/docs.yml` only: the repository's
Settings → Pages → Source must stay **GitHub Actions**. With "Deploy from a branch", GitHub publishes the repository's
root on every push and replaces the site with a 404 (2026-11-12). A push that touches no docs or source doesn't
redeploy; run the Docs workflow by hand to republish.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Installs dependencies |
| `npm run check` | Typecheck, then the tests (vitest). Before every commit |
| `npm run test:browser` | The playground, tech demo and runnable docs in headless Chromium with WebGPU (SwiftShader), a few minutes. What CI runs |
| `npm run test:quick` | `check`, then the browser tests with `--quick` (smaller graphs, fewer steps), about a minute. While working on the playground or the demo |
| `npm run bench` | The stores on a generated network; compare with docs/research/benchmarks.md |
| `npm run docs:dev` / `docs:build` | The site with the playground |
| `npm run build` | `dist/` and type declarations |

Playwright is installed globally in the cloud containers; don't run `playwright install`.

## Layers and rules

- **Modular:** each part of `src/` is a package entry point meant to be reused on its own (`docs/guide/modules.md`).
  `test/modules.test.ts` holds the table of which layer may import which, and bundles every entry point on its own
  to check what it pulls in. A new dependency between layers changes that table on purpose, never by accident. The
  client carries no engine; Cypher never imports the engine.
- **Drawing lives in smaltkit** (ADR 0003): the GPU graph view and the timeline are `smaltkit/graph` and
  `smaltkit/timeline` (stenhoor/smaltkit), so smaltbi and the other apps draw graphs with the same code. `/render` and
  `/timeline` here only re-export them. Change them in smaltkit (its own PR, its tests and browser tests), then move the
  pin in `package.json` here.
- A new entry point goes in `package.json` `exports`, `scripts/build.mjs`, the `tsconfig.json` and `vitest.config.ts`
  aliases, the table in `docs/guide/modules.md` and the README. The TypeScript examples in that guide are type-checked
  (`test/docs-ts.test.ts`).
- Plans say what, never how: no store names or traversal orders in the plan format. The match planner decides.
- A new store passes `test/store-conformance.test.ts`, the Cypher suites (`describe.each` over stores) and the
  differential test.
- Every ```` ```cypher ```` block in `docs/` is runnable on the site (`docs/.vitepress/theme/runnable.ts`) on a sample
  dataset: the fence's `dataset=…`, else the page's front matter `dataset:`, else `social`; `noplay` keeps one plain.
  `test/docs-examples.test.ts` runs each on that dataset and requires rows, and runs every playground example.
- A Cypher feature that isn't supported fails with an error, never a wrong answer; list it in
  `docs/reference/divergences.md`.
- No runtime dependencies but smaltkit, the family's shared kit, pinned to a commit. Ask the owner before adding any
  other package, as the family's rules say.
- No fixed sleeps in tests. Probe tests (`test/zz-*.test.ts`) are scratch: never commit them.
- A significant decision gets an ADR in `docs/adr/`.
