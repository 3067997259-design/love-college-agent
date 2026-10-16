import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), documentWorker: resolve('src/main/documents/pdf-worker.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    plugins: [react()],
    // Keep small font subsets as files; renderer CSP intentionally does not allow data: fonts.
    build: { assetsInlineLimit: 0 },
    server: { host: '127.0.0.1', port: Number(process.env.LCA_RENDERER_PORT ?? 5173), strictPort: true },
  },
})
