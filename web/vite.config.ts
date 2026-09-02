import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/mcp': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
  build: {
    sourcemap: false,
    target: 'es2022',
    manifest: 'asset-manifest.json',
    rollupOptions: {
      /*
       * jsPDF imports html2canvas for its `.html()` method, which renders a DOM
       * tree into a PDF. umm never calls it: the canvas is already a PNG by the
       * time jsPDF is loaded, and it only ever gets `addImage`.
       *
       * html2canvas is an optional dependency of jspdf, so whether it is on
       * disk depends on how the install ran — present in a developer's
       * node_modules, absent in the image built by `npm ci --ignore-scripts`.
       * That made the bundle build pass locally and fail in Docker, which is
       * the release path. Naming it external says out loud that this import is
       * never taken, instead of leaving the build to depend on which machine
       * it runs on.
       */
      external: ['html2canvas'],
    },
  },
});
