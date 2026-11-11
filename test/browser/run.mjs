// The browser tests: the renderer on its own, then the playground on the built site.
import { execFileSync } from 'node:child_process';
const run = (file, ...args) => execFileSync(process.execPath, [file, ...args], { stdio: 'inherit' });
// --quick: smaller graphs and fewer steps, for a fast check while working; CI runs the full suite.
const argv = process.argv.slice(2);
const args = [...(argv.includes('--shots') ? ['--shots', argv[argv.indexOf('--shots') + 1]] : []), ...(argv.includes('--quick') ? ['--quick'] : [])];
run('test/browser/render/run.mjs', ...args);
run('test/browser/playground.mjs', ...args);
