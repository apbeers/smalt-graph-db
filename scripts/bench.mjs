// Bundles bench/run.ts with esbuild and runs it in Node.
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';

await esbuild.build({ entryPoints: ['bench/run.ts'], outfile: '.cache/bench.mjs', bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'warning' });
execFileSync(process.execPath, ['.cache/bench.mjs'], { stdio: 'inherit' });
