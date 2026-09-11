import puppeteer from 'puppeteer-core';
import * as fs from 'node:fs';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', timeout: 120000,
  args: ['--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=2',
         '--user-data-dir=/tmp/promo-chrome-profile', '--no-default-browser-check'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4830/', { waitUntil: 'networkidle2' });
// same page state as record-pick.mjs (MCP panel closed)
await page.evaluate(() => { localStorage.setItem('tapsmith-mcp-panel', 'false'); });
await page.reload({ waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 3500));
// every canvas on the page, so the hover fractions can be calibrated against
// the one record-pick.mjs's rectOf('canvas') will pick (first with width >= 4)
// measure with pick mode ON — that is when record-pick.mjs reads the rect
const tog = await page.$('.mirror-pick-toggle');
if (tog) { await tog.click(); await new Promise(r => setTimeout(r, 900)); }
const all = await page.evaluate(() => [...document.querySelectorAll('canvas')].map((c) => {
  const r = c.getBoundingClientRect();
  return { cls: c.className, left: r.x, top: r.y, w: r.width, h: r.height };
}));
console.log(JSON.stringify(all));
const rect = all.find((r) => r.w >= 4);
// dry-run the recorder's first hover target so the screenshot shows where it lands
await page.mouse.move(rect.left + rect.w * 0.18, rect.top + rect.h * 0.265);
await new Promise(r => setTimeout(r, 700));
fs.writeFileSync('canvas-rect.json', JSON.stringify(rect));
await page.screenshot({ path: 'probe-page.png' });
console.log(JSON.stringify(rect));
if (tog) { await tog.click(); await new Promise(r => setTimeout(r, 300)); }
await browser.close();
process.exit(0);
