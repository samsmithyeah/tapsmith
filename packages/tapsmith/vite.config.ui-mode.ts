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
  server: {
    port: 5174,
    strictPort: true,
    cors: true,
    // The UI-mode dev shell (served by the tapsmith CLI on a different port via
    // --ui-dev-url) embeds this dev server's modules cross-origin. Without an
    // explicit origin, Vite emits root-relative asset URLs (e.g. /@fs/.../mark.png)
    // that the browser resolves against the CLI's origin → 404. Pinning the origin
    // makes Vite emit absolute URLs so imported assets load from this dev server.
    origin: 'http://localhost:5174',
  },
  build: {
    outDir: resolve(__dirname, 'dist/ui-mode'),
    emptyOutDir: false,
    // Inline all assets (e.g. the brand logo PNGs) as base64 so the output stays a single HTML file.
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(__dirname, 'src/ui-mode/index.html'),
    },
  },
})
