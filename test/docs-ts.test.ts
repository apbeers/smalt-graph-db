import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

/**
 * The TypeScript examples in docs/guide/modules.md are type-checked against the package's entry points, so the guide
 * to using the pieces can't drift from the code. Each block is a module of its own.
 */
const PAGES = ['docs/guide/modules.md', 'docs/guide/time-travel.md'];

test('the modules guide type-checks', () => {
  const dir = resolve('.cache/docs-ts');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const page of PAGES) {
    const text = readFileSync(page, 'utf8');
    for (const [i, m] of [...text.matchAll(/```ts\n([\s\S]*?)```/g)].entries()) {
      const file = join(dir, `${page.replace(/[^a-z0-9]+/gi, '-')}-${i}.ts`);
      writeFileSync(file, `${m[1]}\nexport {};\n`);
      files.push(file);
    }
  }
  expect(files.length).toBeGreaterThanOrEqual(7);
  const root = resolve('.');
  const paths: Record<string, string[]> = { '@smaltworks/smaltcy': [`${root}/src/index.ts`] };
  for (const e of ['engine', 'plan', 'functions', 'store', 'history', 'cypher', 'render', 'timeline', 'client', 'datasets']) paths[`@smaltworks/smaltcy/${e}`] = [`${root}/src/${e}/index.ts`];
  paths['@smaltworks/smaltcy/worker-runtime'] = [`${root}/src/worker/runtime.ts`];
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: `${root}/tsconfig.json`,
      compilerOptions: { noEmit: true, paths, types: ['node'], typeRoots: [`${root}/node_modules/@types`] },
      include: files,
    }),
  );
  let out = '';
  try {
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? String(e);
  }
  expect(out).toBe('');
}, 60_000);
