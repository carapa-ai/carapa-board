import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';

const uiRoot = path.resolve(import.meta.dirname);
// Worktrees may symlink node_modules to a checkout outside the project root;
// allow its real path so `?inline` asset imports (e.g. the scoped highlight.js
// themes in src/lib/hljs-themes.ts) pass Vite's fs check.
const nodeModulesRealPath = fs.realpathSync(path.join(uiRoot, 'node_modules'));

export default defineConfig({
  server: {
    fs: {
      allow: [uiRoot, nodeModulesRealPath],
    },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    include: ['src/**/*.vitest.{ts,tsx}'],
    restoreMocks: true,
    setupFiles: ['src/test/setup.ts'],
  },
});
