import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  // GitHub Pages demo build is served from /AgentLRay/; VITE_DEMO=1 marks it.
  base: process.env.VITE_DEMO === '1' ? '/AgentLRay/' : '/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      // Dev proxy to the running AgentLRay backend (server.js on :3800).
      // /api/watch is SSE — http-proxy streams it transparently.
      '/api': { target: 'http://localhost:3800', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
}));
