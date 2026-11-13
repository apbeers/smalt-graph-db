import * as esbuild from 'esbuild';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, normalize } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * smaltcy is built from pieces meant to be used on their own (docs/guide/modules.md). This file keeps them apart:
 * - LAYERS says which directories of src/ each directory may import from (type-only imports have their own list);
 * - ENTRIES bundles each package entry point on its own and checks what it really pulls in.
 * The one package src/ imports is the family's shared kit: render and timeline re-export its graph view and timeline
 * (PACKAGES).
 */

const LAYERS: Record<string, { runtime: string[]; types?: string[] }> = {
  values: { runtime: [] },
  errors: { runtime: [] },
  functions: { runtime: ['values', 'errors'] },
  plan: { runtime: ['functions', 'values', 'errors'] },
  store: { runtime: ['values', 'errors'], types: ['plan'] },
  engine: { runtime: ['plan', 'functions', 'store', 'values', 'errors'] },
  history: { runtime: ['store', 'values', 'errors'], types: ['plan'] },
  cypher: { runtime: ['plan', 'functions', 'values', 'errors'] },
  render: { runtime: [] },
  timeline: { runtime: [] },
  datasets: { runtime: [], types: ['engine', 'store', 'values'] },
  worker: { runtime: ['index', 'datasets', 'store', 'engine', 'errors', 'values'], types: ['plan'] },
  client: { runtime: ['worker', 'errors', 'values'], types: ['store'] },
  index: { runtime: ['cypher', 'engine', 'store', 'history', 'plan', 'worker', 'errors', 'values'] },
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Packages each layer may import (by name, not path), and none other may. */
const PACKAGES: Record<string, string[]> = { render: ['smaltkit/graph'], timeline: ['smaltkit/timeline'] };

/**
 * The top directory of src/ a file is in ('index', 'values' and 'errors' for the files at the top); for the shared
 * kit, its module ('smaltkit/graph').
 */
const layerOf = (file: string) => {
  const kit = /node_modules\/smaltkit\/dist\/([a-z-]+)/.exec(file);
  if (kit) return `smaltkit/${kit[1]}`;
  const rel = relative('src', file);
  const top = rel.split('/')[0]!;
  return top.endsWith('.ts') ? top.replace(/\.d?\.?ts$/, '').replace(/\.ts$/, '') : top;
};

describe('each layer imports only what it may', () => {
  test.each(Object.keys(LAYERS))('%s', (layer) => {
    const own = files('src').filter((f) => layerOf(f) === layer);
    expect(own.length, `src has no ${layer}`).toBeGreaterThan(0);
    const { runtime, types = [] } = LAYERS[layer]!;
    for (const f of own) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+'(\.[^']+)'/gm)) {
        const target = layerOf(normalize(join(dirname(f), m[3]!)).replace(/\.js$/, '.ts'));
        if (target === layer) continue;
        const allowed = m[2] ? [...runtime, ...types] : runtime;
        expect(allowed, `${f} imports ${m[3]} (${target})`).toContain(target);
      }
      for (const m of src.matchAll(/^(?:import|export)\s[^;]*?from\s+'([^.'][^']*)'/gm)) {
        expect(PACKAGES[layer] ?? [], `${f} imports the package ${m[1]}`).toContain(m[1]);
      }
    }
  });
});

/** What each entry point may bundle: the src/ directories its code comes from. */
const ENTRIES: Record<string, { file: string; allow: string[] }> = {
  '@smaltworks/smaltcy/functions': { file: 'src/functions/index.ts', allow: ['functions', 'values', 'errors'] },
  '@smaltworks/smaltcy/plan': { file: 'src/plan/index.ts', allow: ['plan', 'functions', 'values', 'errors'] },
  '@smaltworks/smaltcy/store': { file: 'src/store/index.ts', allow: ['store', 'values', 'errors'] },
  '@smaltworks/smaltcy/history': { file: 'src/history/index.ts', allow: ['history', 'store', 'values', 'errors'] },
  '@smaltworks/smaltcy/engine': { file: 'src/engine/index.ts', allow: ['engine', 'plan', 'functions', 'store', 'values', 'errors'] },
  '@smaltworks/smaltcy/cypher': { file: 'src/cypher/index.ts', allow: ['cypher', 'plan', 'functions', 'values', 'errors'] },
  '@smaltworks/smaltcy/render': { file: 'src/render/index.ts', allow: ['render', 'smaltkit/graph'] },
  '@smaltworks/smaltcy/timeline': { file: 'src/timeline/index.ts', allow: ['timeline', 'smaltkit/timeline'] },
  '@smaltworks/smaltcy/client': { file: 'src/client/index.ts', allow: ['client', 'worker', 'errors', 'values'] },
  '@smaltworks/smaltcy/datasets': { file: 'src/datasets/index.ts', allow: ['datasets'] },
  '@smaltworks/smaltcy/worker-runtime': { file: 'src/worker/runtime.ts', allow: ['worker', 'index', 'cypher', 'engine', 'plan', 'functions', 'store', 'history', 'datasets', 'values', 'errors'] },
  '@smaltworks/smaltcy': { file: 'src/index.ts', allow: ['index', 'cypher', 'engine', 'plan', 'functions', 'store', 'history', 'worker', 'values', 'errors'] },
};

describe('each entry point bundles only its layers', () => {
  test.each(Object.entries(ENTRIES))('%s', async (_name, { file, allow }) => {
    const r = await esbuild.build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'browser', metafile: true, logLevel: 'silent' });
    const used = new Set(Object.keys(r.metafile.inputs).map((f) => layerOf(f)));
    for (const layer of used) expect(allow, `${file} bundles ${layer}`).toContain(layer);
  });

  test('the worker client carries no engine, language or renderer', async () => {
    const r = await esbuild.build({ entryPoints: ['src/client/index.ts'], bundle: true, write: false, format: 'esm', metafile: true, logLevel: 'silent' });
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.filter((f) => /src\/(engine|cypher|render|store|plan|functions)\/|smaltkit/.test(f))).toEqual([]);
    // About 3 KB: what a page needs to talk to the worker.
    expect(r.outputFiles[0]!.contents.length).toBeLessThan(8000);
  });
});
