// Browser test for the WebGPU graph renderer (src/render): bundles it with esbuild, serves a test
// page over http://localhost (WebGPU needs a secure context) and drives it with Playwright in
// Chromium with WebGPU enabled (SwiftShader when headless without a GPU).
//
//   node test/browser/render/run.mjs [--shots <dir>] [--headed] [--skip-10k]
//
// Fails on any GPU validation error, device loss, page error or console error.
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const shots = resolve(opt('--shots', process.env.RENDER_SHOTS ?? join(tmpdir(), 'smaltcy-render-shots')));

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>render test</title>
<style>
  html, body { margin: 0; background: #F5F6F8; }
  body.dark { background: #14171F; }
  canvas { display: block; width: 900px; height: 600px; margin: 20px; }
</style></head>
<body><canvas id="c"></canvas>
<script type="module">
  window.__errors = [];
  const origRequestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await origRequestDevice.apply(this, args);
    device.addEventListener('uncapturederror', (e) => window.__errors.push('GPU error: ' + e.error.message));
    device.lost.then((info) => { if (info.reason !== 'destroyed') window.__errors.push('device lost: ' + info.message); });
    window.__device = device;
    return device;
  };
  window.R = await import('./render.js');
  window.__ready = true;
</script></body></html>`;

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'smaltcy-render-'));
  await mkdir(shots, { recursive: true });
  await esbuild.build({
    entryPoints: [join(root, 'src/render/index.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile: join(dir, 'render.js'),
    logLevel: 'warning',
  });
  const bundle = await readFile(join(dir, 'render.js'));
  const server = http.createServer((req, res) => {
    if (req.url === '/render.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(bundle);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}/`;

  // --enable-unsafe-webgpu alone runs compute, but presenting a WebGPU canvas then loses the device
  // in headless Chromium without a GPU (the compositor cannot share SwiftShader GL images with
  // Dawn). Running both on Vulkan SwiftShader makes canvas presentation work.
  const browser = await chromium.launch({
    headless: !flag('--headed'),
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 940, height: 640 }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
    });
    await page.goto(url);
    await page.waitForFunction(() => window.__ready === true);

    const info = await page.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter();
      return { available: await window.R.isWebGpuAvailable(), arch: a?.info?.architecture ?? '', vendor: a?.info?.vendor ?? '' };
    });
    console.log(`WebGPU adapter: ${info.vendor} ${info.arch}`);
    check(info.available, 'isWebGpuAvailable() is true');

    // Helpers inside the page.
    await page.evaluate(() => {
      // Deterministic graph with communities: groups of nodes with dense in-group edges and a few
      // cross-group edges.
      window.makeGraph = (n, m, groups = 8, seed = 1) => {
        let s = seed >>> 0;
        const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
        const names = ['Person', 'Company', 'City', 'Product', 'Tag', 'Event', 'Repo', 'Topic'];
        const block = Math.ceil(n / groups);
        const nodes = [];
        for (let i = 0; i < n; i++) {
          const g = Math.floor(i / block) % names.length;
          nodes.push({ id: `n${i}`, label: `${names[g]} ${i}`, group: names[g], size: i % 97 === 0 ? 3 : 1 });
        }
        const edges = [];
        for (let k = 0; k < m; k++) {
          const a = Math.floor(rnd() * n);
          let b;
          if (rnd() < 0.95) {
            // Mostly within the community (a contiguous block of indices).
            const g = Math.floor(a / block);
            b = Math.min(n - 1, g * block + Math.floor(rnd() * block));
          } else b = Math.floor(rnd() * n);
          if (a !== b) edges.push({ source: a, target: b });
        }
        return { nodes, edges };
      };
      // Every node's projected position lies inside the canvas.
      window.framed = async (view, n) => {
        await view.sync();
        const c = document.getElementById('c').getBoundingClientRect();
        let inside = 0;
        for (let i = 0; i < n; i++) {
          const p = view.screenPosition(i);
          if (p && p.x >= 0 && p.y >= 0 && p.x <= c.width && p.y <= c.height) inside++;
        }
        return inside / n;
      };
      window.waitFrames = (k) => new Promise((r) => { const f = () => (k-- <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      window.settle = async (view, maxMs) => {
        const t0 = performance.now();
        let maxFps = 0;
        while (view.layout.running && performance.now() - t0 < maxMs) {
          await window.waitFrames(10);
          maxFps = Math.max(maxFps, view.stats().fps);
        }
        return { ms: performance.now() - t0, settled: !view.layout.running, stats: view.stats(), maxFps };
      };
    });

    // ---- 2k nodes, 2D -------------------------------------------------------------------------
    console.log('2D, 2,000 nodes / 4,000 edges');
    const r2 = await page.evaluate(async () => {
      const canvas = document.getElementById('c');
      const view = await window.R.createGraphView(canvas, { mode: '2d', theme: 'light' });
      window.view = view;
      const g = window.makeGraph(2000, 4000);
      window.graph = g;
      view.setGraph(g);
      const before = await view.positions();
      const run = await window.settle(view, 90000);
      const pos = await view.positions();
      const n = g.nodes.length;
      let finite = true, maxAbs = 0, moved = 0;
      for (let i = 0; i < pos.length; i++) {
        if (!Number.isFinite(pos[i])) finite = false;
        maxAbs = Math.max(maxAbs, Math.abs(pos[i]));
        moved += Math.abs(pos[i] - before[i]);
      }
      const d = (a, b) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
      let linked = 0;
      for (const e of g.edges) linked += d(e.source, e.target);
      linked /= g.edges.length;
      let random = 0;
      let s = 7;
      const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
      for (let k = 0; k < 4000; k++) random += d(Math.floor(rnd() * n), Math.floor(rnd() * n));
      random /= 4000;
      let zMax = 0;
      for (let i = 0; i < n; i++) zMax = Math.max(zMax, Math.abs(pos[i * 3 + 2]));
      return { run, finite, maxAbs, moved: moved / pos.length, linked, random, zMax, n: pos.length / 3 };
    });
    console.log(`  layout: ${r2.run.settled ? 'settled' : 'not settled'} after ${(r2.run.ms / 1000).toFixed(1)} s; ${r2.run.stats.layoutMsPerTick.toFixed(2)} ms/tick; max fps ${r2.run.maxFps}`);
    console.log(`  mean edge length ${r2.linked.toFixed(1)} vs random pair ${r2.random.toFixed(1)}; extent ${r2.maxAbs.toFixed(0)}`);
    check(r2.n === 2000, 'positions() returns xyz for every node');
    check(r2.finite, 'positions are finite');
    check(r2.maxAbs > 100 && r2.moved > 1, 'positions spread out and moved from the seed');
    check(r2.linked < r2.random * 0.5, 'connected nodes end closer than random pairs');
    check(r2.zMax === 0, 'z stays 0 in 2D');
    check(r2.run.settled, 'layout cools to rest and stops');

    const framed2d = await page.evaluate(async () => {
      window.view.fit();
      await window.waitFrames(30);
      return window.framed(window.view, 2000);
    });
    check(framed2d === 1, `fit() frames every node in 2D (${(framed2d * 100).toFixed(1)}%)`);
    await page.locator('canvas').screenshot({ path: join(shots, 'render-2d-light.png') });

    // Picking: GPU pick at a node's projected position, and hover through real mouse events.
    const pick = await page.evaluate(async () => {
      const view = window.view;
      await view.sync();
      const results = [];
      for (const i of [0, 97, 501, 1234, 1999]) {
        const p = view.screenPosition(i);
        const hit = await view.pick(p.x, p.y);
        let near = false;
        if (hit && hit.kind === 'node') {
          const q = view.screenPosition(hit.index);
          near = Math.hypot(q.x - p.x, q.y - p.y) < 12;
        }
        results.push({ i, p, hit, near });
      }
      const empty = await view.pick(2, 2);
      return { results, empty };
    });
    for (const r of pick.results) {
      check(r.hit?.kind === 'node' && (r.hit.index === r.i || r.near), `pick at node ${r.i} → ${JSON.stringify(r.hit)}`);
    }
    check(pick.empty === null || pick.empty.kind !== 'node', 'pick in an empty corner finds no node');

    const box = await page.locator('canvas').boundingBox();
    const target = pick.results[1];
    await page.evaluate(() => {
      window.__hover = [];
      window.view.onHover((h) => window.__hover.push(h));
      window.__clicks = [];
      window.view.onClick((h) => window.__clicks.push(h));
    });
    await page.mouse.move(box.x + target.p.x + 30, box.y + target.p.y + 30);
    await page.mouse.move(box.x + target.p.x, box.y + target.p.y, { steps: 3 });
    await page.waitForFunction(() => window.__hover.some((h) => h && h.kind === 'node'), null, { timeout: 10000 });
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => window.__clicks.length > 0, null, { timeout: 10000 });
    const hov = await page.evaluate(() => ({ hover: window.__hover.filter(Boolean).pop(), click: window.__clicks[0] }));
    check(hov.hover?.kind === 'node', `hover reports a node (${JSON.stringify(hov.hover)})`);
    check(hov.click?.kind === 'node', `click reports a node (${JSON.stringify(hov.click)})`);
    await page.locator('canvas').screenshot({ path: join(shots, 'render-2d-hover.png') });

    // Search + highlight, zoomed in.
    const found = await page.evaluate(async () => {
      const idx = window.view.search('city 6');
      window.view.focus(idx[0]);
      await window.waitFrames(40);
      return idx.length;
    });
    check(found > 0, `search("city 6") matches ${found} nodes`);
    await page.locator('canvas').screenshot({ path: join(shots, 'render-2d-search.png') });

    // Dark theme.
    await page.evaluate(async () => {
      window.view.search('');
      document.body.classList.add('dark');
      window.view.setTheme('dark');
      window.view.fit();
      await window.waitFrames(40);
    });
    await page.locator('canvas').screenshot({ path: join(shots, 'render-2d-dark.png') });

    // ---- 3D -----------------------------------------------------------------------------------
    console.log('3D, same graph');
    const r3 = await page.evaluate(async () => {
      const view = window.view;
      view.setMode('3d');
      await window.waitFrames(5);
      const run = await window.settle(view, 90000);
      view.fit();
      await window.waitFrames(40);
      const pos = await view.positions();
      let zMax = 0, finite = true;
      for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) finite = false;
      for (let i = 0; i < pos.length / 3; i++) zMax = Math.max(zMax, Math.abs(pos[i * 3 + 2]));
      await view.sync();
      const p = view.screenPosition(42);
      const hit = p ? await view.pick(p.x, p.y) : null;
      const framed = await window.framed(view, 2000);
      return { run, zMax, finite, hit, framed };
    });
    check(r3.framed === 1, `fit() frames every node in 3D (${(r3.framed * 100).toFixed(1)}%)`);
    console.log(`  layout: ${r3.run.settled ? 'settled' : 'not settled'} after ${(r3.run.ms / 1000).toFixed(1)} s; ${r3.run.stats.layoutMsPerTick.toFixed(2)} ms/tick`);
    check(r3.finite && r3.zMax > 10, `3D layout uses z (max |z| ${r3.zMax.toFixed(0)})`);
    check(r3.hit?.kind === 'node', `3D pick finds a node (${JSON.stringify(r3.hit)})`);
    await page.locator('canvas').screenshot({ path: join(shots, 'render-3d-dark.png') });
    await page.evaluate(async () => {
      document.body.classList.remove('dark');
      window.view.setTheme('light');
      await window.waitFrames(5);
    });
    await page.locator('canvas').screenshot({ path: join(shots, 'render-3d-light.png') });

    // Orbit with the mouse, then back to 2D.
    await page.mouse.move(box.x + 8, box.y + 8);
    await page.evaluate(() => window.waitFrames(5));
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 60, { steps: 8 });
    await page.mouse.up();
    await page.evaluate(() => window.waitFrames(5));
    await page.locator('canvas').screenshot({ path: join(shots, 'render-3d-orbit.png') });
    const back = await page.evaluate(async () => {
      window.view.setMode('2d');
      await window.waitFrames(5);
      await window.settle(window.view, 60000);
      const pos = await window.view.positions();
      let zMax = 0;
      for (let i = 0; i < pos.length / 3; i++) zMax = Math.max(zMax, Math.abs(pos[i * 3 + 2]));
      return zMax;
    });
    check(back === 0, 'back in 2D, z is flattened');

    // ---- small graph: labels and arrows -------------------------------------------------------
    await page.evaluate(async () => {
      const groups = ['Person', 'Company', 'City'];
      const nodes = [];
      for (let i = 0; i < 36; i++) nodes.push({ id: i, label: ['Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Ken', 'Dennis', 'Margaret', 'Linus', 'Guido', 'Brendan', 'Anders'][i % 12] + (i >= 12 ? ` ${Math.floor(i / 12)}` : ''), group: groups[i % 3], size: i === 0 ? 2.5 : 1 });
      const edges = [];
      for (let i = 1; i < 36; i++) edges.push({ source: i, target: Math.floor((i - 1) / 3) });
      edges.push({ source: 5, target: 9 }, { source: 20, target: 2 });
      window.view.setGraph({ nodes, edges });
      await window.settle(window.view, 60000);
      window.view.fit();
      await window.waitFrames(40);
    });
    await page.locator('canvas').screenshot({ path: join(shots, 'render-small-2d.png') });
    await page.evaluate(async () => {
      window.view.highlight([0, 1, 2]);
      await window.waitFrames(5);
    });
    await page.locator('canvas').screenshot({ path: join(shots, 'render-small-highlight.png') });
    // Incremental result: grow the graph keeping positions.
    const keep = await page.evaluate(async () => {
      const view = window.view;
      view.highlight(null);
      const p0 = await view.positions();
      const nodes = [];
      for (let i = 0; i < 36; i++) nodes.push({ id: i, label: `n${i}` });
      for (let i = 36; i < 48; i++) nodes.push({ id: i, label: `new ${i}` });
      const edges = [];
      for (let i = 1; i < 48; i++) edges.push({ source: i, target: Math.floor((i - 1) / 3) });
      view.setGraph({ nodes, edges }, { keepPositions: true });
      const p1 = await view.positions();
      let maxShift = 0;
      for (let i = 0; i < 36 * 3; i++) maxShift = Math.max(maxShift, Math.abs(p1[i] - p0[i]));
      await window.settle(view, 60000);
      return { maxShift, n: p1.length / 3 };
    });
    check(keep.n === 48 && keep.maxShift < 1e-3, `keepPositions keeps existing nodes in place (max shift ${keep.maxShift})`);
    const framedSmall = await page.evaluate(async () => {
      window.view.setMode('3d');
      await window.settle(window.view, 60000);
      window.view.fit();
      await window.waitFrames(40);
      return window.framed(window.view, 48);
    });
    check(framedSmall === 1, `small graph framed in 3D after a mode switch (${(framedSmall * 100).toFixed(1)}%)`);
    await page.locator('canvas').screenshot({ path: join(shots, 'render-small-3d.png') });

    // ---- 10k nodes / 30k edges ----------------------------------------------------------------
    if (!flag('--skip-10k')) {
      console.log('2D, 10,000 nodes / 30,000 edges (timed run, not to rest)');
      const big = await page.evaluate(async () => {
        const view = window.view;
        view.setMode('2d');
        view.setGraph(window.makeGraph(10000, 30000, 8, 3));
        const t0 = performance.now();
        await window.waitFrames(5);
        let maxFps = 0;
        // Layout cost and frame rate while the layout runs (SwiftShader is a CPU rasterizer, so
        // these are far below a hardware GPU).
        let msPerTick = 0;
        while (performance.now() - t0 < 20000) {
          await window.waitFrames(2);
          const st = view.stats();
          maxFps = Math.max(maxFps, st.fps);
          if (st.layoutMsPerTick > 0) msPerTick = st.layoutMsPerTick;
        }
        const running = view.layout.running;
        view.layout.stop();
        const pos = await view.positions();
        let finite = true;
        for (const v of pos) if (!Number.isFinite(v)) finite = false;
        view.fit();
        await window.waitFrames(30);
        return { stats: view.stats(), maxFps, finite, msPerTick, running };
      });
      console.log(`  ${big.msPerTick.toFixed(1)} ms/tick; ${big.maxFps} fps while laying out`);
      check(big.running && big.msPerTick > 0, '10k layout runs on the GPU');
      check(big.finite, '10k positions are finite');
      await page.locator('canvas').screenshot({ path: join(shots, 'render-10k-2d.png') });
    }

    // GpuUnavailableError when there is no WebGPU.
    const unavailable = await page.evaluate(async () => {
      const gpu = Object.getOwnPropertyDescriptor(Navigator.prototype, 'gpu');
      Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined });
      try {
        await window.R.createGraphView(document.createElement('canvas'));
        return 'resolved';
      } catch (e) {
        return e instanceof window.R.GpuUnavailableError ? 'GpuUnavailableError' : String(e);
      } finally {
        Object.defineProperty(Navigator.prototype, 'gpu', gpu);
      }
    });
    check(unavailable === 'GpuUnavailableError', 'createGraphView rejects with GpuUnavailableError without WebGPU');

    await page.evaluate(() => window.view.destroy());
    errors.push(...(await page.evaluate(() => window.__errors)));
  } finally {
    await browser.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
  check(errors.length === 0, `no GPU, page or console errors${errors.length ? ':\n    ' + errors.slice(0, 10).join('\n    ') : ''}`);
  console.log(`screenshots: ${shots}`);
  if (failures) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('all render checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
