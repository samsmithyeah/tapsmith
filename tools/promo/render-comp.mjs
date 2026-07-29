// Render comp.html frame-by-frame. Usage:
//   node render-comp.mjs probe          -> a few QC stills at dsf=1
//   node render-comp.mjs full [dsf]     -> all frames at 30fps (default dsf=2)
import puppeteer from 'puppeteer-core';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const MODE = process.argv[2] || 'probe';
const DSF = Number(process.argv[3] || (MODE === 'probe' ? 1 : 2));
const FPS = 30, DUR = 102.5;
const ROOT = path.dirname(new URL(import.meta.url).pathname);

// static server with naive range support (Chrome video seeking)
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  const stat = fs.statSync(p);
  const type = p.endsWith('.html') ? 'text/html' : p.endsWith('.mp4') ? 'video/mp4'
    : p.endsWith('.png') ? 'image/png' : p.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
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
await new Promise(r => server.listen(4860, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: DSF });
await page.goto('http://127.0.0.1:4860/comp.html', { waitUntil: 'networkidle0' });
await page.evaluate(() => window.compReady);
console.log('comp loaded');

if (MODE === 'probe') {
  for (const t of [2.5, 8.5, 17.5, 22.5, 30, 45, 55, 66.5, 76, 79]) {
    await page.evaluate((t) => window.seekComp(t), t);
    await new Promise(r => setTimeout(r, 120));
    await page.screenshot({ path: `probe-${String(t).replace('.', '_')}.jpg`, quality: 90, type: 'jpeg' });
    console.log('probe', t);
  }
} else {
  const from = Number(process.argv[4] ?? 0);
  const to = Number(process.argv[5] ?? Math.round(DUR * FPS));
  if (from === 0 && to === Math.round(DUR * FPS)) {
    fs.rmSync('comp-frames', { recursive: true, force: true });
    fs.mkdirSync('comp-frames');
  }
  const total = Math.round(DUR * FPS);
  const t0 = Date.now();
  for (let i = from; i < Math.min(to, total); i++) {
    await page.evaluate((t) => window.seekComp(t), i / FPS);
    await new Promise(r => setTimeout(r, 8));
    await page.screenshot({ path: `comp-frames/f${String(i).padStart(5, '0')}.jpg`, quality: 92, type: 'jpeg' });
    if (i % 300 === 0) console.log(`frame ${i}/${total} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  console.log('rendered', total, 'frames in', Math.round((Date.now() - t0) / 1000), 's');
}
await browser.close();
server.close();
process.exit(0);
