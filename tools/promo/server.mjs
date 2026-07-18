// Minimal clone of tapsmith's show-trace server (no browser auto-open).
// Serves the bundled viewer at /, fflate at /vendor/fflate.js, and any trace
// from the e2e report dir at /t/<filename>.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const VIEWER = path.join(ROOT, 'e2e/node_modules/tapsmith/dist/trace-viewer/index.html');
const FFLATE = path.join(ROOT, 'e2e/node_modules/tapsmith/node_modules/fflate/esm/browser.js');
const TRACES = path.join(ROOT, 'e2e/tapsmith-report');

const viewerHtml = fs.readFileSync(VIEWER, 'utf-8');

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(viewerHtml);
    return;
  }
  if (url.pathname === '/vendor/fflate.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    fs.createReadStream(FFLATE).pipe(res);
    return;
  }
  if (url.pathname === '/demo.zip') {
    const file = new URL('./demo-trace.zip', import.meta.url).pathname;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': fs.statSync(file).size,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (url.pathname.startsWith('/t/')) {
    const name = path.basename(url.pathname);
    const file = path.join(TRACES, name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('no trace'); return; }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': fs.statSync(file).size,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(4820, '127.0.0.1', () => console.log('trace server on 4820'));
