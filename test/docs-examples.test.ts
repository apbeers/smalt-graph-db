import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EXAMPLES, type DatasetKey } from '../docs/.vitepress/theme/components/examples.js';
import { airline, family, gitHistory, metro, microservices, network, ontology, orgChart, packages, powerGrid, social, supplyChain } from '../src/datasets/index.js';
import { open } from '../src/index.js';
import { WITH_HISTORY, datasetOf, type DatasetName } from '../docs/.vitepress/theme/runnable.js';

/**
 * Every ```cypher block in the docs runs on the dataset the site runs it on (its fence's `dataset=`, else the page's
 * front matter, else `social`; theme/runnable.ts), on a fresh copy each, and must give rows or write something.
 * Blocks marked `noplay` run on `social` with the parameters below.
 */
function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f.startsWith('.') || f === 'node_modules') return [];
    return statSync(p).isDirectory() ? markdown(p) : p.endsWith('.md') ? [p] : [];
  });
}

const blocks: [string, string, DatasetName | null][] = [];
for (const file of markdown('docs')) {
  const text = readFileSync(file, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const frontmatter = { dataset: /^dataset:\s*(\S+)/m.exec(fm)?.[1] };
  for (const m of text.matchAll(/```cypher([^\n]*)\n([\s\S]*?)```/g)) {
    blocks.push([`${file}: ${m[2]!.split('\n')[0]}`, m[2]!, datasetOf(`cypher${m[1]}`, frontmatter)]);
  }
}

// The sizes theme/runnable.ts loads.
const DATA: Record<DatasetName, () => ReturnType<typeof social>> = {
  social,
  family,
  metro,
  network: () => network(2000),
  ontology,
  'org-chart': () => orgChart(300),
  packages: () => packages(300),
  airline: () => airline(300),
  'power-grid': () => powerGrid(300),
  'git-history': () => gitHistory(300),
  'supply-chain': () => supplyChain(300),
  microservices: () => microservices(300),
};

describe('docs examples', () => {
  test('there are examples', () => expect(blocks.length).toBeGreaterThan(20));
  test.each(blocks)('%s', (_where, cypher, dataset) => {
    const g = open({ history: !!dataset && WITH_HISTORY.has(dataset) });
    g.load(DATA[dataset ?? 'social']());
    const r = g.run(cypher, dataset ? {} : { year: 1900 });
    // A runnable example shows something: rows, a plan or what it wrote.
    if (dataset && !/^\s*(CREATE|DROP) INDEX/i.test(cypher)) expect(r.rows.length + Object.values(r.counts).reduce((a, b) => a + b, 0), cypher).toBeGreaterThan(0);
  });
});

describe('playground examples', () => {
  // As the playground loads them: every dataset keeps its history; the networks with their growth.
  const data: Record<DatasetKey, () => ReturnType<typeof social>> = {
    social, family, metro, ontology,
    network: () => network(800, 42, { history: true }),
    big: () => network(800, 42, { history: true }),
  };
  const cases = (Object.keys(EXAMPLES) as DatasetKey[]).flatMap((k) => EXAMPLES[k].map((ex) => [k, ex.title, ex.query] as const));
  test.each(cases)('%s: %s', (k, _title, query) => {
    const g = open({ history: true });
    g.load(data[k]());
    const r = g.run(query);
    // Every example shows something.
    expect(r.rows.length, query).toBeGreaterThan(0);
  });
});
