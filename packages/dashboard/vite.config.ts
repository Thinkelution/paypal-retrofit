import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.RETROFIT_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/fernhill': { target, changeOrigin: true },
      '/mock-paypal': { target, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
