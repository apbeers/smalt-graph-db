import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@smaltworks\/smaltcy$/, replacement: src('index.ts') },
      { find: /^@smaltworks\/smaltcy\/(engine|plan|cypher|render|datasets)$/, replacement: src('$1/index.ts') },
    ],
  },
  test: { include: ['test/**/*.test.ts'] },
});
