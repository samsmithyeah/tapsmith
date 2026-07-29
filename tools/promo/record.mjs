// Record a choreographed interaction with the trace viewer via CDP screencast.
import puppeteer from 'puppeteer-core';
import * as fs from 'node:fs';

const OUT = 'rec-frames';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=2'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4820/?trace=/demo.zip', { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 2500));

// Synthetic cursor that follows real mouse events + click pulse.
await page.evaluate(() => {
  const c = document.createElement('div');
  c.id = '__cursor';
  c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;pointer-events:none;z-index:2147483647;transition:transform 0.06s linear;will-change:transform;';
  c.innerHTML = `<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5.5 3.2v16.2l4.1-4.0 2.3 5.4 2.7-1.2-2.3-5.3 5.6-0.6z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(c);
  let x = 800, y = 500;
  c.style.transform = `translate(${x}px, ${y}px)`;
  document.addEventListener('mousemove', (e) => {
    x = e.clientX; y = e.clientY;
    c.style.transform = `translate(${x}px, ${y}px)`;
  }, true);
  document.addEventListener('mousedown', () => {
    const p = document.createElement('div');
    p.style.cssText = `position:fixed;left:${x - 18}px;top:${y - 18}px;width:36px;height:36px;border-radius:50%;background:rgba(232,145,75,0.35);border:2px solid rgba(232,145,75,0.7);pointer-events:none;z-index:2147483646;animation:__pulse 0.45s ease-out forwards;`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 500);
  }, true);
  const st = document.createElement('style');
  st.textContent = '@keyframes __pulse { from { transform: scale(0.4); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }';
  document.head.appendChild(st);
});

// Screencast
const cdp = await page.createCDPSession();
let n = 0;
const meta = [];
cdp.on('Page.screencastFrame', async (f) => {
  const idx = n++;
  fs.writeFileSync(`${OUT}/f${String(idx).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'));
  meta.push({ idx, t: f.metadata.timestamp });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* ended */ }
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mouse = page.mouse;
let cur = { x: 800, y: 500 };
async function glide(x, y, ms = 550) {
  const steps = Math.max(12, Math.round(ms / 16));
  await mouse.move(cur.x, cur.y);
  // ease-in-out interpolation
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await mouse.move(cur.x + (x - cur.x) * e, cur.y + (y - cur.y) * e);
    await sleep(ms / steps);
  }
  cur = { x, y };
}
async function click() { await mouse.down(); await sleep(90); await mouse.up(); }

// ── Choreography (~19s) ──
await sleep(1400);                       // settle on loaded viewer
await glide(140, 337, 650); await click(); await sleep(1500);   // toBeVisible row
await glide(140, 406, 500); await click(); await sleep(1600);   // doubleTap row
await glide(140, 450, 500); await click(); await sleep(1900);   // failing toContainText
await glide(1554, 195, 700); await click(); await sleep(2400);  // Errors tab
await glide(52, 98, 700); await click(); await sleep(1100);     // film frame 2
await glide(82, 98, 350); await click(); await sleep(1100);     // film frame 3
await glide(112, 98, 350); await click(); await sleep(1600);    // film frame 4 (failed)
await glide(932, 240, 600); await click(); await sleep(1300);   // Before tab
await glide(985, 240, 350); await click(); await sleep(1800);   // After tab
await glide(700, 620, 800); await sleep(1200);                  // drift off, settle

await cdp.send('Page.stopScreencast');
await sleep(300);
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta));
console.log('frames:', n);
await browser.close();
