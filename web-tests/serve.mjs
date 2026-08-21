// Static server for the two built web apps.
//
// Both Vite builds (`vite-plugin-singlefile`, assetsInlineLimit 10MB) emit one
// self-contained `index.html` with every asset inlined, so there is exactly one
// file to serve per app:
//
//   /               UI mode SPA
//   /trace-viewer/  standalone trace viewer
//
// Neither app's data comes from here. UI mode's WebSocket is intercepted with
// `page.routeWebSocket()`, and the viewer's trace fetch with `page.route()`, so
// the payloads stay in the test process.
//
// Serving over HTTP rather than opening `file://` matters for UI mode:
// `use-websocket.ts` derives its socket URL from `location.host`, which is empty
// under file://.
import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const PORT = Number(process.env.PORT ?? 5175)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(HERE, "..", "packages", "tapsmith", "dist")

const APPS = {
  "/": path.join(DIST, "ui-mode", "index.html"),
  "/trace-viewer/": path.join(DIST, "trace-viewer", "index.html"),
}

const missing = Object.values(APPS).filter((p) => !fs.existsSync(p))
if (missing.length > 0) {
  console.error(
    `[web-tests] Built app not found:\n  ${missing.join("\n  ")}\n` +
      `Run \`npm run build\` in packages/tapsmith first.`,
  )
  process.exit(1)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const pathname = url.pathname.replace(/index\.html$/, "")
  const file = APPS[pathname]

  if (file) {
    // Read per-request so a rebuild is picked up without a restart.
    const html = fs.readFileSync(file)
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.byteLength,
      // Both apps persist state; a cached document would make reload specs
      // test the wrong bytes.
      "Cache-Control": "no-store",
    })
    res.end(html)
    return
  }

  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("Not found")
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[web-tests] UI mode        http://127.0.0.1:${PORT}/`)
  console.log(`[web-tests] Trace viewer   http://127.0.0.1:${PORT}/trace-viewer/`)
})
