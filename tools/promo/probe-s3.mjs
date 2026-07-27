// Quick S3 QC: render specific timeline moments to stills.
import puppeteer from 'puppeteer-core';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.mp4') ? 'video/mp4'
    : p.endsWith('.js') ? 'application/javascript' : p.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
  const stat = fs.statSync(p);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${stat.size}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(p, { start: a, end: b }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(p).pipe(res);
  }
});
await new Promise(r => server.listen(4863, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  timeout: 120000,
  args: ['--no-first-run', '--hide-scrollbars', '--user-data-dir=/tmp/promo-chrome-profile2'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4863/comp.html', { waitUntil: 'networkidle0' });
await page.evaluate(() => window.compReady);
for (const t of process.argv.slice(2).map(Number)) {
  await page.evaluate((t) => window.seekComp(t), t);
  await new Promise(r => setTimeout(r, 150));
  await page.screenshot({ path: `s3probe-${String(t).replace('.', '_')}.jpg`, quality: 92, type: 'jpeg' });
  console.log('probe', t);
}
await browser.close();
server.close();
process.exit(0);
