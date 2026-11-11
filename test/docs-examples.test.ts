import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EXAMPLES, type DatasetKey } from '../docs/.vitepress/theme/components/examples.js';
import { family, metro, network, social } from '../src/datasets/index.js';
import { open } from '../src/index.js';

/** Every ```cypher block in the docs runs against the sample social graph, on a fresh copy each. */
function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f.startsWith('.') || f === 'node_modules') return [];
    return statSync(p).isDirectory() ? markdown(p) : p.endsWith('.md') ? [p] : [];
  });
}

const blocks: [string, string][] = [];
for (const file of markdown('docs')) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/```cypher\n([\s\S]*?)```/g)) blocks.push([`${file}: ${m[1]!.split('\n')[0]}`, m[1]!]);
}

describe('docs examples', () => {
  test('there are examples', () => expect(blocks.length).toBeGreaterThan(20));
  test.each(blocks)('%s', (_where, cypher) => {
    const g = open();
    g.load(social());
    expect(() => g.run(cypher, { year: 1900 })).not.toThrow();
  });
});

describe('playground examples', () => {
  const data: Record<DatasetKey, () => ReturnType<typeof social>> = { social, family, metro, network: () => network(800), big: () => network(800) };
  const cases = (Object.keys(EXAMPLES) as DatasetKey[]).flatMap((k) => EXAMPLES[k].map((ex) => [k, ex.title, ex.query] as const));
  test.each(cases)('%s: %s', (k, _title, query) => {
    const g = open();
    g.load(data[k]());
    const r = g.run(query);
    // Every example shows something.
    expect(r.rows.length, query).toBeGreaterThan(0);
  });
});
