import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  // API_TARGET lets the dev server show a deployed engine's data (read-only) instead of a local one.
  server: { proxy: { '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:8787', changeOrigin: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
