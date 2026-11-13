// The browser tests: the playground, tech demo and runnable docs on the built site. The graph view and timeline are
// smaltkit's, tested there (its test/browser/).
import { execFileSync } from 'node:child_process';
const run = (file, ...args) => execFileSync(process.execPath, [file, ...args], { stdio: 'inherit' });
// --quick: smaller graphs and fewer steps, for a fast check while working; CI runs the full suite.
const argv = process.argv.slice(2);
const args = [...(argv.includes('--shots') ? ['--shots', argv[argv.indexOf('--shots') + 1]] : []), ...(argv.includes('--quick') ? ['--quick'] : [])];
run('test/browser/playground.mjs', ...args);
