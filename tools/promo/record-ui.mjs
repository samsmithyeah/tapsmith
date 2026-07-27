// Record UI mode: filter tests, run one live on the simulator, explore results.
import puppeteer from 'puppeteer-core';
import * as fs from 'node:fs';

const OUT = 'ui-frames';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  timeout: 120000,
  args: ['--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=2',
         '--user-data-dir=/tmp/promo-chrome-profile', '--no-default-browser-check'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4830/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 3000));

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
const marks = {};
const mark = (k) => { marks[k] = Date.now() / 1000; console.log('mark', k); };

async function glide(x, y, ms = 550) {
  const steps = Math.max(10, Math.round(ms / 22));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await mouse.move(cur.x + (x - cur.x) * e, cur.y + (y - cur.y) * e);
    await sleep(Math.max(8, ms / steps - 6));
  }
  cur = { x, y };
}
async function click() { await mouse.down(); await sleep(90); await mouse.up(); }

// Find an element's center by class + optional text
async function rectOf(sel, text) {
  return page.evaluate((sel, text) => {
    for (const el of document.querySelectorAll(sel)) {
      if (text && !(el.textContent || '').includes(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.x, top: r.y };
    }
    return null;
  }, sel, text);
}

mark('start');
await sleep(1500);

// 1. Filter tests
const search = await rectOf('.te-search');
await glide(search.x, search.y, 600); await click();
mark('typing');
for (const ch of 'network mocking') { await page.keyboard.type(ch); await sleep(55); }
await sleep(1200);

// 2. Expand file node, then suite, to reveal the test
const fileRow = await rectOf('.te-name', 'network-mocking.test.ts');
if (fileRow) { await glide(fileRow.x, fileRow.y, 650); await click(); await sleep(900); }
let suiteRow = await rectOf('.te-name', 'Network mocking');
if (suiteRow && !(await rectOf('.te-name', 'mock a JSON response'))) {
  await glide(suiteRow.x, suiteRow.y, 450); await click(); await sleep(900);
}
// Find the target test row, hover, click its run button
const row = await rectOf('.te-name', 'mock a JSON response');
if (!row) { console.error('test row not found'); process.exit(1); }
await glide(row.x, row.y, 700);
await sleep(600);
const runBtn = await page.evaluate(() => {
  for (const el of document.querySelectorAll('.te-node')) {
    if ((el.textContent || '').includes('mock a JSON response')) {
      const b = el.querySelector('.te-run-btn');
      if (b) { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
  }
  return null;
});
if (!runBtn) { console.error('run btn not found'); await page.screenshot({ path: 'ui-debug.png' }); process.exit(1); }
await glide(runBtn.x, runBtn.y, 400); await click();
mark('runClicked');

// 3. Wait for the test to finish (green). Park cursor near the mirror while it runs.
await glide(1150, 420, 900);
try {
  await page.waitForFunction(() => {
    const el = document.querySelector('.te-node.passed, .te-node .passed');
    if (el && (el.textContent || '').includes('mock a JSON response')) return true;
    return /1 passed/.test(document.body.textContent || '');
  }, { timeout: 120000, polling: 500 });
} catch { console.error('run did not pass in time'); }
mark('passed');
await sleep(1800);

// 4. Click the toBeVisible action in the actions list
const act = await rectOf('.action-item', 'toBeVisible');
if (act) { await glide(act.x, act.y, 700); await click(); await sleep(1500); }
mark('actionSelected');

// 5. Network tab → row → RESPONSE
const netTab = await rectOf('.detail-tab', 'Network');
if (netTab) { await glide(netTab.x, netTab.y, 600); await click(); await sleep(1400); }
mark('networkTab');
const netRow = await rectOf('.net-row', 'posts');
if (netRow) { await glide(netRow.x, netRow.y, 550); await click(); await sleep(1300); }
const respTab = await rectOf('.detail-tab, .net-detail-tab, [class*=tab]', 'RESPONSE');
if (respTab) { await glide(respTab.x, respTab.y, 450); await click(); await sleep(2000); }
mark('response');
await glide(900, 700, 700);
await sleep(1200);
mark('end');

await cdp.send('Page.stopScreencast');
await sleep(300);
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ frames: meta, marks }));
console.log('frames:', n, 'marks:', JSON.stringify(marks));
await browser.close();
