// Static server for the built UI mode SPA.
//
// The Vite build (`vite-plugin-singlefile`, assetsInlineLimit 10MB) emits one
// self-contained `index.html` with every asset inlined, so there is exactly one
// thing to serve. The SPA must be served over HTTP rather than opened as a
// file:// URL because `use-websocket.ts` derives its socket URL from
// `location.host` — under file:// that yields `ws://`, which never connects.
//
// The WebSocket itself is never served here: specs intercept it with
// `page.routeWebSocket()`, so no socket ever reaches this process.
import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const PORT = Number(process.env.PORT ?? 5175)
const HERE = path.dirname(fileURLToPath(import.meta.url))

// Reached by relative path rather than a `tapsmith/...` package import: that
// package's `exports` map only exposes `.`, and widening it to serve a
// test-only need would change the published package's public surface.
const SPA = path.join(HERE, "..", "packages", "tapsmith", "dist", "ui-mode", "index.html")

if (!fs.existsSync(SPA)) {
  console.error(
    `[web-tests] UI mode bundle not found at ${SPA}\n` +
      `Run \`npm run build\` in packages/tapsmith first.`,
  )
  process.exit(1)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === "/" || url.pathname === "/index.html") {
    // Read per-request so a rebuild is picked up without restarting the server.
    const html = fs.readFileSync(SPA)
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.byteLength,
      // The SPA persists pane sizes and the selected test; a cached document
      // would make reload-behaviour specs test the wrong bytes.
      "Cache-Control": "no-store",
    })
    res.end(html)
    return
  }
  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("Not found")
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[web-tests] UI mode SPA on http://127.0.0.1:${PORT}/`)
})
