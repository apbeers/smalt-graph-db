// Browser test for the docs site's playground: builds the site, serves it, and drives the playground in Chromium
// with WebGPU. Fails on any page error, console error or GPU error, or if a query doesn't draw.
//
//   node test/browser/playground.mjs [--shots <dir>] [--quick]
//
// --quick skips the 5,000-person network and the dark-theme screenshot.
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
const QUICK = argv.includes('--quick');
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
const site = `http://localhost:${server.address().port}${BASE}`;
const url = `${site}playground`;

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
};

// Headless Chromium loses the WebGPU device when it presents to a canvas unless SwiftShader backs both GL and Vulkan
// (the same flags as test/browser/render/run.mjs).
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--enable-unsafe-swiftshader'],
});
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

  if (!QUICK) {
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

  }

  // Runnable examples in the docs: Run shows a table and draws the graph.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${site}guide/sample-data`);
  const examples = page.locator('.cy-run');
  check((await examples.count()) >= 10, `the sample-data page has runnable examples (${await examples.count()})`);
  const first = examples.first();
  await first.locator('[data-run="run"]').click();
  await first.locator('.cy-run-table').waitFor({ timeout: 30000 });
  await first.locator('.cy-run-graph-bar span:not(:empty)').waitFor({ timeout: 15000 });
  check((await first.locator('.cy-run-graph-bar span').textContent()).includes('nodes'), `an example draws its graph (${await first.locator('.cy-run-graph-bar span').textContent()})`);
  check((await first.locator('.cy-run-graph .cy-run-note').count()) === 0, 'the example\'s graph view started');
  await page.waitForTimeout(1500);
  await first.screenshot({ path: join(shots, 'example-social.png') });
  // An example on another dataset, edited.
  const metro = page.locator('.cy-run[data-dataset="metro"]').nth(1);
  await metro.scrollIntoViewIfNeeded();
  await metro.locator('[data-run="edit"]').click();
  await metro.locator('[data-run="run"]').click();
  await metro.locator('.cy-run-graph-bar span:not(:empty)').waitFor({ timeout: 30000 });
  check(/^\d+ rows? ·/.test(await metro.locator('.cy-run-status').textContent()), `a metro example runs (${await metro.locator('.cy-run-status').textContent()})`);
  await page.waitForTimeout(1500);
  await metro.screenshot({ path: join(shots, 'example-metro.png') });
  // Open in the playground: the example's query and dataset.
  const href = await metro.locator('[data-run="open"]').getAttribute('href');
  await page.goto(new URL(href, site).href);
  await page.waitForFunction(() => /row/.test(document.querySelector('.pg-status')?.textContent ?? ''), null, { timeout: 30000 });
  check((await page.inputValue('.pg-field select')) === 'metro' && (await page.inputValue('.pg-editor textarea')).includes('shortestPath'), 'Open in the playground brings the query and its dataset');

  // The tech demo.
  await page.goto(`${site}demo`);
  // 10,000 people by default; the full run also switches to 25,000.
  await page.waitForFunction(() => document.querySelector('.td-nums b')?.textContent === '10,008', null, { timeout: 60000 });
  check(true, 'the demo draws 10,000 people by default (10,008 nodes)');
  if (!QUICK) {
    await page.selectOption('.td-field select >> nth=0', '25000');
    await page.waitForFunction(() => document.querySelector('.td-nums b')?.textContent === '25,008', null, { timeout: 120000 });
    check(true, 'the demo switches to 25,000 people (25,008 nodes)');
  }
  await page.click('.td-chip:has-text("Two hops from Bo 1")');
  await page.waitForSelector('.td-highlight', { timeout: 30000 });
  check(/\d+ nodes? highlighted/.test(await page.textContent('.td-highlight')), `a query highlights its result (${await page.textContent('.td-highlight')})`);
  await page.click('.td-chip:has-text("Bo 1")');
  await page.waitForFunction(() => /match/.test(document.querySelector('.td-highlight')?.textContent ?? ''));
  check(/"Bo 1": \d+ match/.test(await page.textContent('.td-highlight')), `a search highlights matches (${await page.textContent('.td-highlight')})`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(shots, 'demo-2d.png') });
  await page.click('.td-seg button:has-text("3D")');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(shots, 'demo-3d.png') });

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
