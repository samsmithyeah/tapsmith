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
    // Inline assets (e.g. the brand logo PNGs) as base64 so the output stays a single HTML file.
    // 10MB is far above our brand assets while guarding against accidentally inlining huge files.
    assetsInlineLimit: 10_000_000,
    rollupOptions: {
      input: resolve(__dirname, 'src/trace-viewer/index.html'),
    },
  },
})
