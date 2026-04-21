import { defineConfig } from 'vite'
import prefresh from '@prefresh/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [prefresh(), viteSingleFile()],
  esbuild: {
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    jsxInject: `import { h, Fragment } from 'preact'`,
  },
  root: resolve(__dirname, 'src/trace-viewer'),
  build: {
    outDir: resolve(__dirname, 'dist/trace-viewer'),
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/trace-viewer/index.html'),
    },
  },
})
