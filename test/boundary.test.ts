import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

/** The engine carries no language: nothing in the engine, plan or stores imports Cypher (docs/adr/0001-smaltcy.md). */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test.each(['src/engine', 'src/plan', 'src/store'])('%s imports no language', (dir) => {
  for (const f of files(dir)) {
    const src = readFileSync(f, 'utf8');
    expect(src, f).not.toMatch(/from '\.\.\/cypher\//);
    expect(src, f).not.toMatch(/from '\.\.\/render\//);
  }
});

test('stores import nothing from the engine but shared helpers', () => {
  for (const f of files('src/store')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '\.\.\/engine\//);
});
