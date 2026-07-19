import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

const DEFAULT_FRONTEND_PORT = 5173;
const DEFAULT_BACKEND_PORT = 3000;

const parsePort = (value, fallback) => {
  const port = Number.parseInt(value ?? '', 10);
  return Number.isFinite(port) ? port : fallback;
};

const devPort = parsePort(process.env.FRONTEND_PORT, DEFAULT_FRONTEND_PORT);
const apiPort = parsePort(process.env.BACKEND_PORT ?? process.env.PORT ?? process.env.API_PORT, DEFAULT_BACKEND_PORT);

export default defineConfig({
  root: resolve(__dirname),
  plugins: [vue()],
  css: {
    postcss: resolve(__dirname, 'postcss.config.cjs')
  },
  base: './',
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: Boolean(process.env.FRONTEND_PORT),
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL?.replace(/\/api\/?$/, '') ?? `http://localhost:${apiPort}`,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true
  }
});
