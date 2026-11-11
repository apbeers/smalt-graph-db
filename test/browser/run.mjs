// The browser tests: the renderer on its own, then the playground on the built site.
import { execFileSync } from 'node:child_process';
const run = (file, ...args) => execFileSync(process.execPath, [file, ...args], { stdio: 'inherit' });
const shots = process.argv.includes('--shots') ? ['--shots', process.argv[process.argv.indexOf('--shots') + 1]] : [];
run('test/browser/render/run.mjs', ...shots);
run('test/browser/playground.mjs', ...shots);
