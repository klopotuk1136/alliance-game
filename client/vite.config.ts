import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// `npm run dev:client` serves the client with hot reload on :5173 and forwards
// API/WebSocket traffic to a server running on :8080.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('../dist/client', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://localhost:8080',
      '/flags': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
