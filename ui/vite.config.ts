import path from 'path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import { defineConfig } from 'vite';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      autoCodeSplitting: true,
      // Exclude test files from the generated route tree
      routeFileIgnorePattern: '\\.([vt]est|vitest|spec)\\.',
    }),
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: { '@': path.resolve(uiRoot, './src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
      '/health': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
      '/artifacts': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
