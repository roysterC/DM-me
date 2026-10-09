import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    // Keep the browser's Host header so the server's same-origin check passes in dev.
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: false } },
  },
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
