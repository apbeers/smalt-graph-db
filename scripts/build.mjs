// Builds dist/: one ES module per entry point, the worker script, and type declarations.
//   node scripts/build.mjs           the package
//   node scripts/build.mjs --minify  minified, for publishing
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const minify = process.argv.includes('--minify');
rmSync('dist', { recursive: true, force: true });

const entries = {
  smaltcy: 'src/index.ts',
  engine: 'src/engine/index.ts',
  plan: 'src/plan/index.ts',
  cypher: 'src/cypher/index.ts',
  functions: 'src/functions/index.ts',
  store: 'src/store/index.ts',
  history: 'src/history/index.ts',
  client: 'src/client/index.ts',
  'worker-runtime': 'src/worker/runtime.ts',
  render: 'src/render/index.ts',
  timeline: 'src/timeline/index.ts',
  datasets: 'src/datasets/index.ts',
  'smaltcy-worker': 'src/worker/worker.ts',
};

await esbuild.build({
  entryPoints: entries,
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  minify,
  sourcemap: true,
  logLevel: 'warning',
  // The shared kit is a dependency: the app's bundler or import map resolves it, once for every package using it.
  external: ['smaltkit', 'smaltkit/*'],
});

execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' });
console.log(`built dist/ (${Object.keys(entries).length} entry points${minify ? ', minified' : ''})`);
