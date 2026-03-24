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
  root: resolve(__dirname, 'src/ui-mode'),
  build: {
    outDir: resolve(__dirname, 'dist/ui-mode'),
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/ui-mode/index.html'),
    },
  },
})
