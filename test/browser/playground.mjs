// Browser test for the docs site's playground: builds the site, serves it, and drives the playground in Chromium
// with WebGPU. Fails on any page error, console error or GPU error, or if a query doesn't draw.
//
//   node test/browser/playground.mjs [--shots <dir>]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const shots = resolve(argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : join(tmpdir(), 'smaltcy-playground-shots'));
const BASE = '/smalt-graph-db/';
mkdirSync(shots, { recursive: true });

execFileSync(join(root, 'node_modules/.bin/vitepress'), ['build', 'docs'], { cwd: root, stdio: 'inherit' });
const dist = join(root, 'docs/.vitepress/dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(BASE)) return res.writeHead(404).end();
  p = join(dist, p.slice(BASE.length));
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p) && existsSync(p + '.html')) p += '.html';
  if (!existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}${BASE}playground`;

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('.pg-status')?.textContent?.includes('loaded'), null, { timeout: 60000 });
  const stats = async () => (await page.textContent('.pg-stats')) ?? '';
  await page.waitForFunction(() => /^\d+ nodes/.test(document.querySelector('.pg-stats')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
  check(/^22 nodes · 39 edges/.test(await stats()), `the social graph is drawn (${await stats()})`);
  check(!(await page.$('.pg-gpu')), 'WebGPU started');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(shots, 'playground-overview.png') });

  // A query that returns a path draws only the path.
  await page.click('.pg-chip:has-text("Shortest path")');
  await page.waitForFunction(() => document.querySelector('.pg-status')?.textContent?.includes('row'), null, { timeout: 10000 });
  await page.waitForTimeout(800);
  check(/^\d nodes · \d edges/.test(await stats()), `the shortest path is drawn (${await stats()})`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, 'playground-path.png') });

  // The plan tab shows the steps.
  await page.click('.pg-tabs button:has-text("Plan")');
  check(((await page.textContent('.pg-plan')) ?? '').includes('ShortestPath'), 'the plan shows ShortestPath');

  // 3D.
  await page.click('.pg-chip:has-text("Who knows whom")');
  await page.waitForTimeout(800);
  await page.click('.pg-seg button:has-text("3D")');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(shots, 'playground-3d.png') });

  // A syntax error is reported, not thrown.
  await page.fill('.pg-editor textarea', 'MATCH (n RETURN n');
  await page.click('.pg-primary');
  await page.waitForSelector('.pg-status.err');
  check(((await page.textContent('.pg-status')) ?? '').includes('line 1'), 'syntax errors show their position');

  // The larger network.
  await page.click('.pg-seg button:has-text("2D")');
  await page.selectOption('.pg-field select', 'network');
  await page.waitForFunction(() => document.querySelector('.pg-status')?.textContent?.includes('5,0'), null, { timeout: 60000 });
  await page.waitForTimeout(4000);
  check(/^5,\d{3} nodes/.test(await stats()), `the 5,000-person network is drawn (${await stats()})`);
  await page.screenshot({ path: join(shots, 'playground-network.png') });

  // Dark theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, 'playground-dark.png') });

  check(errors.length === 0, `no console or page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log(`screenshots in ${shots}`);
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
