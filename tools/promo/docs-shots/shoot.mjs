// Docs/website screenshot capture. Reuses tools/promo's puppeteer-core.
//
//   node docs-shots/shoot.mjs ui-mode      http://127.0.0.1:4830   out.png
//   node docs-shots/shoot.mjs pick-locator http://127.0.0.1:4830   out.png
//   node docs-shots/shoot.mjs trace-viewer 'http://127.0.0.1:4820/?trace=/t/x.zip' out.png
//   node docs-shots/shoot.mjs html-report  file:///.../index.html  out.png
//
// Viewport 1512x828 @2x -> 3024x1656 PNGs, matching docs/images/*.png.
// UI-mode shots expect the dual-platform server (e2e/tapsmith.config.mjs) and
// drive it for real: they run the network-mocking test on both platforms.
import puppeteer from 'puppeteer-core';

const [shot, url, out] = process.argv.slice(2);
if (!shot || !url || !out) { console.error('usage: shoot.mjs <ui-mode|pick-locator|trace-viewer|html-report> <url> <out.png>'); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', timeout: 120000, protocolTimeout: 600000,
  args: ['--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=2',
         '--user-data-dir=/tmp/docs-shots-chrome', '--no-default-browser-check'],
});
process.on('unhandledRejection', async (err) => { console.error(err); try { await browser.close(); } catch {} process.exit(1); });
const page = await browser.newPage();
await page.setViewport({ width: 1512, height: 828, deviceScaleFactor: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rectOf(sel, text) {
  return page.evaluate((sel, text) => {
    for (const el of document.querySelectorAll(sel)) {
      if (text && !(el.textContent || '').toLowerCase().includes(text.toLowerCase())) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.x, top: r.y };
    }
    return null;
  }, sel, text);
}
async function clickEl(sel, text, settle = 700) {
  const r = await rectOf(sel, text);
  if (!r) throw new Error(`not found: ${sel} ${text ?? ''}`);
  await page.mouse.click(r.x, r.y);
  await sleep(settle);
  return r;
}
async function clickExact(sel, text, settle = 700) {
  const r = await page.evaluate((sel, text) => {
    for (const el of document.querySelectorAll(sel)) {
      if ((el.textContent || '').trim().toLowerCase() !== text.toLowerCase()) continue;
      const b = el.getBoundingClientRect();
      if (b.width < 4) continue;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  }, sel, text);
  if (!r) throw new Error(`not found (exact): ${sel} ${text}`);
  await page.mouse.click(r.x, r.y);
  await sleep(settle);
}
async function openUi() {
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.evaluate(() => { localStorage.setItem('tapsmith-mcp-panel', 'false'); });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(2500);
}
// UI mode prepares the device for the next run right after a run finishes; that
// puts the app back on the home screen, which the pick shot does not want.
async function setPrepareBetweenRuns(on) {
  const chips = await page.$$('.rc-device-actionable');
  for (const chip of chips) {
    await chip.click({ button: 'right' });
    await sleep(350);
    const state = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.rc-context-item')].find((b) => (b.textContent || '').includes('Prepare device between runs'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { checked: el.getAttribute('aria-checked') === 'true', x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (state && state.checked !== on) await page.mouse.click(state.x, state.y); else await page.keyboard.press('Escape');
    await sleep(300);
  }
}
const TEST = 'mock a JSON response';
async function runNetworkMockingEverywhere() {
  await clickEl('.te-search');
  await page.keyboard.type('network mocking');
  await sleep(1200);
  // expand every file/suite node until each project's target test row is visible
  for (let i = 0; i < 6; i++) {
    const clicked = await page.evaluate((TEST) => {
      const names = [...document.querySelectorAll('.te-name')];
      const target = names.find((n) => (n.textContent || '').includes('network-mocking.test.ts') || (n.textContent || '').trim() === 'Network mocking');
      const rows = names.filter((n) => (n.textContent || '').includes(TEST));
      if (rows.length >= 2) return false;
      if (!target) return false;
      // click the first collapsed one
      for (const n of names) {
        const txt = (n.textContent || '');
        if (!(txt.includes('network-mocking.test.ts') || txt.trim() === 'Network mocking')) continue;
        const node = n.closest('.te-node');
        const chev = node && node.querySelector('.te-chevron');
        const expanded = node && node.getAttribute('aria-expanded') === 'true';
        if (!expanded) { (chev || n).click(); return true; }
      }
      return false;
    }, TEST);
    await sleep(600);
    if (!clicked) break;
  }
  // click the run button of every visible target test row
  // FORCE_RUN=1 re-runs green rows too (the pick shot needs the app left on the
  // API Calls screen by a fresh run, with prepare-between-runs off)
  const btns = await page.evaluate((TEST, force) => {
    const out = [];
    for (const el of document.querySelectorAll('.te-node')) {
      if (!(el.textContent || '').includes(TEST)) continue;
      if (!force && (/\bpassed\b/.test(el.className) || el.querySelector('.passed'))) continue;   // already green
      const b = el.querySelector('.te-run-btn');
      if (b) { const r = b.getBoundingClientRect(); out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); }
    }
    return out;
  }, TEST, process.env.FORCE_RUN === '1');
  console.log('run buttons:', btns.length);
  if (!btns.length) return;
  for (const b of btns) {
    const row = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return !!el; }, b);
    if (!row) continue;
    await page.mouse.move(b.x, b.y); await sleep(200);
    await page.mouse.click(b.x, b.y); await sleep(800);
  }
  await waitForRuns();
  // a run that died on an infrastructure error (loaded machine, agent timeout)
  // leaves its row neither passed nor failed; re-run anything not green, twice
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = await page.evaluate((TEST) => {
      const out = [];
      for (const el of document.querySelectorAll('.te-node')) {
        if (!(el.textContent || '').includes(TEST)) continue;
        if (/\bpassed\b/.test(el.className) || el.querySelector('.passed')) continue;
        const b = el.querySelector('.te-run-btn');
        if (b) { const r = b.getBoundingClientRect(); out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); }
      }
      return out;
    }, TEST);
    if (!pending.length) break;
    console.log('re-running rows not green:', pending.length);
    for (const b of pending) { await page.mouse.move(b.x, b.y); await sleep(200); await page.mouse.click(b.x, b.y); await sleep(800); }
    await waitForRuns();
  }
  await sleep(1500);
}
// wait for the run to start (elapsed timer in the rail) and then finish (timer gone)
async function waitForRuns() {
  try { await page.waitForSelector('.rc-elapsed', { timeout: 15000 }); } catch { console.log('no run started?'); }
  await page.waitForFunction(() => !document.querySelector('.rc-elapsed'), { timeout: 300000, polling: 1000 });
  await sleep(1000);
  const txt = await page.evaluate(() => [...document.querySelectorAll('.rc-count')].map((e) => e.textContent).join(' '));
  console.log('runs finished:', txt);
}

if (shot === 'ui-mode') {
  await openUi();
  await setPrepareBetweenRuns(false);   // left off: the pick shot that follows relies on it
  await runNetworkMockingEverywhere();
  // select the passed iOS test row (last matching), then the final toBeVisible action
  const rows = await page.$$('.te-node');
  for (const r of rows) {
    const txt = await r.evaluate((el) => el.textContent || '');
    if (txt.includes(TEST)) { await r.evaluate((el) => el.querySelector('.te-name')?.click()); await sleep(600); }
  }
  const acts = await page.$$('.action-item');
  let target = null;
  for (const a of acts) { const txt = await a.evaluate((el) => el.textContent || ''); if (txt.includes('Mocked Post Title')) target = a; }
  if (target) { await target.click(); await sleep(1200); }
  await clickEl('.detail-tab', 'Network', 1200);
  await clickEl('.net-row', 'posts', 1200);
  await clickExact('button, [role=tab]', 'Response', 1500);
  await page.mouse.move(700, 400);
  await sleep(600);
  await page.screenshot({ path: out });
} else if (shot === 'pick-locator') {
  await openUi();
  await setPrepareBetweenRuns(false);
  await runNetworkMockingEverywhere();
  // Android device tab (pick is unavailable in the All view), then pick mode
  await clickEl('.worker-tab', 'Tapsmith_Phone', 900);
  await clickEl('.mirror-pick-toggle', undefined, 2500);
  // the rail grows a status row for a moment after a run and shifts the mirror,
  // so measure the canvas right before moving onto it
  const canvas = await rectOf('.dm-canvas');
  if (!canvas) throw new Error('mirror canvas not found');
  console.log('canvas', JSON.stringify(canvas));
  // "Fetch Posts" button on the Android API Calls screen (fractions of the
  // mirror canvas; recalibrate with docs-shots/canvas.mjs if the layout moves)
  const FX = Number(process.env.PICK_FX || 0.183), FY = Number(process.env.PICK_FY || 0.205);
  const x = canvas.left + canvas.w * FX, y = canvas.top + canvas.h * FY;
  await page.mouse.move(x, y); await sleep(900);
  await page.mouse.click(x, y); await sleep(2500);
  await page.screenshot({ path: out });
  await clickEl('.mirror-pick-toggle', undefined, 300);
  await setPrepareBetweenRuns(true);
} else if (shot === 'trace-viewer') {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await sleep(2500);
  // the failed assertion, then the Errors tab
  const acts = await page.$$('.action-item');
  for (const a of acts) { const txt = await a.evaluate((el) => el.textContent || ''); if (txt.includes('Login successful')) { await a.click(); break; } }
  await sleep(1200);
  await clickEl('.detail-tab', 'Errors', 1500);
  await page.mouse.move(600, 700);
  await sleep(500);
  await page.screenshot({ path: out });
} else if (shot === 'html-report') {
  await page.goto(url, { waitUntil: 'networkidle0' });
  await sleep(1200);
  await page.screenshot({ path: out });
} else {
  console.error('unknown shot', shot); process.exit(2);
}
await browser.close();
console.log('wrote', out);
