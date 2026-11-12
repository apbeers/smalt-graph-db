import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@smaltworks\/smaltcy$/, replacement: src('index.ts') },
      { find: /^@smaltworks\/smaltcy\/worker-runtime$/, replacement: src('worker/runtime.ts') },
      { find: /^@smaltworks\/smaltcy\/(engine|plan|cypher|render|datasets|functions|store|history|timeline|client)$/, replacement: src('$1/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    // The tests share no state between files (each builds its own graphs), so one worker runs them all: about three
    // times faster than a fresh worker per file.
    isolate: false,
  },
});
