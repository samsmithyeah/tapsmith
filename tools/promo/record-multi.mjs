// Record the multi-device scene: UI mode running the two-user chat test from
// e2e/tests/multi-device/ on two simulators at once (PILOT-310). The mirror's
// "All" view tiles both members live; afterwards an action is selected so the
// trace shows one screenshot pane per device. Frames land in multi-frames/.
//
// Server: tapsmith test --ui --ui-port 4830 -c tapsmith.config.ios-multi.mjs
import puppeteer from 'puppeteer-core';
import * as fs from 'node:fs';

const OUT = 'multi-frames';
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
await page.evaluate(() => { localStorage.setItem('tapsmith-mcp-panel', 'false'); });
await page.reload({ waitUntil: 'networkidle2' });
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

// The Source tab heads its panel with the file's absolute path. Rewrite it to
// the neutral path used everywhere else in the video, live, as the panel
// re-renders (same scrub as demo-trace.zip; nothing else in the UI changes).
await page.evaluate(() => {
  const REAL = '/Users/samsmithredbadger/projects/tapsmith', NEUTRAL = '/Users/dev/acme-mobile';
  const scrub = () => {
    for (const el of document.querySelectorAll('.source-filename')) {
      if (el.textContent && el.textContent.includes(REAL)) el.textContent = el.textContent.split(REAL).join(NEUTRAL);
    }
  };
  new MutationObserver(scrub).observe(document.body, { childList: true, subtree: true, characterData: true });
  scrub();
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

const TEST = 'alice messages bob';

// Off camera: filter the tree to the chat suite and reveal the test row.
const search = await rectOf('.te-search');
await glide(search.x, search.y, 500); await click();
for (const ch of 'chatting') { await page.keyboard.type(ch); await sleep(50); }
await sleep(1200);
const fileRow = await rectOf('.te-name', 'two-devices.test.ts');
if (fileRow && !(await rectOf('.te-name', 'Two users chatting'))) { await glide(fileRow.x, fileRow.y, 500); await click(); await sleep(800); }
const suiteRow = await rectOf('.te-name', 'Two users chatting');
if (suiteRow && !(await rectOf('.te-name', TEST))) { await glide(suiteRow.x, suiteRow.y, 450); await click(); await sleep(800); }
const row = await rectOf('.te-name', TEST);
if (!row) { console.error('test row not found'); await page.screenshot({ path: 'multi-debug.png' }); process.exit(1); }
// Make sure the mirror shows every member (the "All" tab).
const allTab = await rectOf('.worker-tab', 'All');
if (allTab) { await glide(allTab.x, allTab.y, 400); await click(); await sleep(600); }
// Show the test's source in the detail panel while the run streams (the tab
// choice persists, so it stays on Source as actions arrive).
const srcTab = await rectOf('.detail-tab', 'Source');
if (srcTab) { await glide(srcTab.x, srcTab.y, 500); await click(); await sleep(700); }

await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });
await sleep(700);
mark('start');

// 1. Hover the test, click its run button
await glide(row.x, row.y, 700);
await sleep(500);
const runBtn = await page.evaluate((TEST) => {
  for (const el of document.querySelectorAll('.te-node')) {
    if ((el.textContent || '').includes(TEST)) {
      const b = el.querySelector('.te-run-btn');
      if (b) { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
  }
  return null;
}, TEST);
if (!runBtn) { console.error('run btn not found'); await page.screenshot({ path: 'multi-debug.png' }); process.exit(1); }
await glide(runBtn.x, runBtn.y, 400); await click();
mark('runClicked');

// 2. Park the cursor between the two mirrors while both devices act
await glide(1180, 560, 900);
try {
  await page.waitForFunction((TEST) => {
    const el = document.querySelector('.te-node.passed, .te-node .passed');
    if (el && (el.textContent || '').includes(TEST)) return true;
    return /1 passed|1 failed/.test(document.body.textContent || '');
  }, { timeout: 180000, polling: 500 }, TEST);
} catch { console.error('run did not finish in time'); }
mark('passed');
await sleep(1800);

// 3. Select the assertion that bob saw alice's message: the trace shows one
//    screenshot pane per device, the acting one outlined.
const act = await rectOf('.action-item', 'Hi Bob');
if (act) { await glide(act.x, act.y, 800); await click(); await sleep(2200); }
mark('actionSelected');

// 4. Network tab: both devices' traffic, filter pill per device
const netTab = await rectOf('.detail-tab', 'Network');
if (netTab) { await glide(netTab.x, netTab.y, 600); await click(); await sleep(2000); }
mark('networkTab');
await glide(900, 700, 700);
await sleep(1200);
mark('end');

await cdp.send('Page.stopScreencast');
await sleep(300);
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({ frames: meta, marks }));
console.log('frames:', n, 'marks:', JSON.stringify(marks));
await browser.close();
process.exit(0);
