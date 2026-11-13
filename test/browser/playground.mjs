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
const { chromium, devices } = require('playwright');
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

  // History: the ontology's timeline moves the drawing, and a past version can be queried.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('.pg-status')?.textContent?.includes('loaded'), null, { timeout: 60000 });
  await page.selectOption('.pg-field select', 'ontology');
  await page.waitForFunction(() => /26 versions/.test(document.querySelector('.pg-status')?.textContent ?? ''), null, { timeout: 60000 });
  const slider = page.locator('.pg-timeline [role="slider"]');
  // The status says 26 versions as soon as the dataset loads; the timeline follows once its commits arrive.
  const atLatest = await page.waitForFunction(() => document.querySelector('.pg-timeline [role="slider"]')?.getAttribute('aria-valuenow') === '26', null, { timeout: 10000 }).then(() => true, () => false);
  check(atLatest, `the ontology's timeline is at its latest version (${await slider.getAttribute('aria-valuenow')})`);
  const drawn = async () => Number(/^(\d+) nodes/.exec((await page.textContent('.pg-stats')) ?? '')?.[1] ?? -1);
  const waitDrawn = (n) => page.waitForFunction((n) => (document.querySelector('.pg-stats')?.textContent ?? '').startsWith(`${n} nodes`), n, { timeout: 15000 }).then(() => true, () => false);
  check(await waitDrawn(31), `the latest version is drawn (${await drawn()} nodes)`);
  await slider.focus();
  await page.keyboard.press('Home');
  check(await waitDrawn(0), `Home goes to version 0, the empty graph (${await drawn()} nodes)`);
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  check(await waitDrawn(16), `eight steps on, version 8 is drawn (${await drawn()} nodes)`);
  check(/version 8 of 26/i.test((await page.textContent('.pg-past')) ?? ''), 'the page says which version is shown');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(shots, 'playground-timeline.png') });
  await page.fill('.pg-editor textarea', 'MATCH (n) RETURN count(n) AS n');
  await page.click('.pg-past button');
  check((await page.inputValue('.pg-editor textarea')).startsWith('AT VERSION 8'), 'Query this version puts AT VERSION before the query');
  await page.click('.pg-primary');
  await page.waitForFunction(() => /row/.test(document.querySelector('.pg-status')?.textContent ?? ''), null, { timeout: 15000 });
  check(((await page.textContent('.pg-table tbody')) ?? '').includes('16'), 'the query reads version 8');
  await page.keyboard.press('End');
  await slider.focus();
  await page.keyboard.press('End');
  check(await waitDrawn(31), 'End goes back to the latest version');
  // A write adds a version to the timeline.
  await page.fill('.pg-editor textarea', "CREATE (:Team {name: 'Reliability'})");
  await page.click('.pg-primary');
  await page.waitForFunction(() => document.querySelector('.pg-timeline [role="slider"]')?.getAttribute('aria-valuenow') === '27', null, { timeout: 15000 }).catch(() => {});
  check((await slider.getAttribute('aria-valuenow')) === '27', 'a write adds version 27 and the timeline follows it');
  check(await waitDrawn(32), 'the new node is drawn');

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
  // Quick mode opens the demo at 1,000 people (the software GPU draws 10,000 at about a frame a second); the full run
  // checks the default of 10,000 too.
  const DEMO = QUICK ? { url: `${site}demo?people=1000`, nodes: '1,008', versions: '1001', label: '1,000 people (from the link)' } : { url: `${site}demo`, nodes: '10,008', versions: '10001', label: '10,000 people by default' };
  await page.goto(DEMO.url);
  // 10,000 people by default; the full run also switches to 25,000.
  const drew = await page.waitForFunction((n) => document.querySelector('.td-nums b')?.textContent === n, DEMO.nodes, { timeout: 60000 }).then(() => true, () => false);
  check(drew, `the demo draws ${DEMO.label} (${DEMO.nodes} nodes)`);
  // The demo's timeline: the network as it grew.
  const demoSlider = page.locator('.td-tl [role="slider"]');
  check((await demoSlider.getAttribute('aria-valuenow')) === DEMO.versions, `the demo's timeline has the network's growth (${await demoSlider.getAttribute('aria-valuenow')} versions)`);
  await demoSlider.focus();
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(2000);
  const fewer = Number((await page.textContent('.td-nums b'))?.replace(/,/g, ''));
  check(/Version \d[\d,]* of [\d,]+/.test((await page.textContent('.td-tl-note')) ?? ''), `stepping back shows an earlier version (${await page.textContent('.td-tl-note')})`);
  await page.screenshot({ path: join(shots, 'demo-timeline.png') });
  await demoSlider.focus();
  await page.keyboard.press('End');
  await page.waitForTimeout(1000);
  void fewer;
  await page.click('.td-chip:has-text("Two hops from Bo 1")');
  await page.waitForSelector('.td-highlight', { timeout: 30000 });
  check(/\d+ nodes? highlighted/.test(await page.textContent('.td-highlight')), `a query highlights its result (${await page.textContent('.td-highlight')})`);
  await page.click('.td-chip:has-text("Bo 1")');
  await page.waitForFunction(() => /match/.test(document.querySelector('.td-highlight')?.textContent ?? ''));
  check(/"Bo 1": \d+ match/.test(await page.textContent('.td-highlight')), `a search highlights matches (${await page.textContent('.td-highlight')})`);
  if (!QUICK) {
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(shots, 'demo-2d.png') });
  }
  await page.click('.td-seg button:has-text("3D")');
  await page.waitForTimeout(QUICK ? 800 : 3000);
  if (!QUICK) await page.screenshot({ path: join(shots, 'demo-3d.png') });

  if (!QUICK) {
    // A big network loads and draws (no screenshot: the software GPU is slow to lay out 25,000 nodes).
    await page.selectOption('.td-field select >> nth=1', '25000');
    const big = await page.waitForFunction(() => document.querySelector('.td-nums b')?.textContent === '25,008', null, { timeout: 120000 }).then(() => true, () => false);
    check(big, 'the demo switches to 25,000 people (25,008 nodes)');
  }

  // A small network: captions on, and a click shows a node's details.
  await page.click('.td-seg button:has-text("2D")');
  await page.selectOption('.td-field select >> nth=1', '50');
  await page.waitForFunction(() => document.querySelector('.td-nums b')?.textContent === '58', null, { timeout: 60000 });
  check(await page.isChecked('.td-check input'), 'a small network shows its captions');
  await page.waitForTimeout(4000); // the layout settles
  // Click outwards from the centre until a click lands on a node.
  const box = await page.locator('.td-canvas').boundingBox();
  let shown = false;
  for (let ring = 0; ring < 8 && !shown; ring++) {
    for (let k = 0; k < Math.max(1, ring * 6) && !shown; k++) {
      const a = (k / Math.max(1, ring * 6)) * 2 * Math.PI;
      await page.mouse.click(box.x + box.width / 2 + Math.cos(a) * ring * 18, box.y + box.height / 2 + Math.sin(a) * ring * 18);
      shown = await page.waitForSelector('.td-details', { timeout: 400 }).then(() => true, () => false);
    }
  }
  const title = shown ? await page.textContent('.td-details h4') : '';
  check(shown && /\d+ connections?/.test((await page.textContent('.td-details')) ?? ''), `clicking a node shows its details (${title})`);
  await page.screenshot({ path: join(shots, 'demo-small.png') });

  // Fixed layout and the spread slider.
  await page.click('.lc-seg button:has-text("Fixed")');
  check((await page.getAttribute('.lc-seg button:has-text("Fixed")', 'aria-pressed')) === 'true', 'the demo switches to the fixed layout');
  await page.locator('.lc-spread input').fill('100');
  check((await page.textContent('.lc-spread output')) === '5.0×', `the spread slider goes to 5× (${await page.textContent('.lc-spread output')})`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(shots, 'demo-fixed-spread.png') });
  await page.locator('.lc-spread input').fill('0');
  await page.click('.lc-seg button:has-text("Force")');

  // The other datasets, each with the shape of a real system: at 50 nodes each loads, draws, and its first query
  // highlights something.
  const SHAPES = { 'org-chart': '50', packages: '50', airline: '50', 'power-grid': '52', 'git-history': '50', 'supply-chain': '50', microservices: '50' };
  for (const [name, nodes] of Object.entries(SHAPES)) {
    await page.selectOption('.td-field select >> nth=0', name);
    const loaded = await page.waitForFunction((n) => document.querySelector('.td-nums b')?.textContent === n && !document.querySelector('.td-primary')?.disabled, nodes, { timeout: 30000 }).then(() => true, () => false);
    await page.click('.td-chips >> nth=1 >> .td-chip >> nth=0');
    const lit = await page.waitForFunction(() => /^[1-9][\d,]* nodes? highlighted/.test(document.querySelector('.td-highlight')?.textContent ?? ''), null, { timeout: 15000 }).then(() => true, () => false);
    check(loaded && lit && page.url().includes(`dataset=${name}`), `the demo's ${name} dataset loads (${nodes} nodes) and its first query highlights (${await page.textContent('.td-highlight').catch(() => '')})`);
    if (!QUICK) await page.screenshot({ path: join(shots, `demo-${name}.png`) });
  }

  // On a phone, playing the demo's timeline must not move the page: its readout changes length every step, and a
  // grid column that grows with its content made the whole page shake.
  {
    // The desktop page is still laying out 10,000 nodes on the software GPU: close it so the phone page gets frames.
    await page.close();
    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    const pp = await phone.newPage();
    pp.on('pageerror', (e) => errors.push(e.message));
    await pp.goto(DEMO.url);
    await pp.waitForFunction((n) => document.querySelector('.td-nums b')?.textContent === n, DEMO.nodes, { timeout: 90000 });
    await pp.locator('.td-tl').scrollIntoViewIfNeeded();
    await pp.locator('.td-tl [role="slider"]').focus();
    await pp.keyboard.press('Home');
    await pp.waitForTimeout(500);
    const layout = () => pp.evaluate(() => {
      const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)]; };
      return JSON.stringify({ wide: document.documentElement.scrollWidth > document.documentElement.clientWidth, view: box('.td-view'), tl: box('.td-tl'), side: box('.td-side') });
    });
    const seen = new Set([await layout()]);
    await pp.locator('.td-tl button[aria-label^="Play"]').click();
    // Sample the layout until the timeline has played at least 8 versions (or 30 s pass).
    const t0 = Date.now();
    let v = '0';
    while (Number(v) < 8 && Date.now() - t0 < 30000) {
      seen.add(await layout());
      v = (await pp.locator('.td-tl [role="slider"]').getAttribute('aria-valuenow')) ?? '0';
    }
    check(Number(v) >= 8 && seen.size === 1 && !JSON.parse([...seen][0]).wide, `on a phone, playing the timeline (to version ${v}) doesn't move the page (${seen.size} layout${seen.size === 1 ? '' : 's'})`);
    await phone.close();
  }

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
