import puppeteer from 'puppeteer-core';
import * as fs from 'node:fs';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', timeout: 120000,
  args: ['--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=2',
         '--user-data-dir=/tmp/promo-chrome-profile', '--no-default-browser-check'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4830/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 3500));
const rect = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  return { left: r.x, top: r.y, w: r.width, h: r.height };
});
fs.writeFileSync('canvas-rect.json', JSON.stringify(rect));
await page.screenshot({ path: 'probe-page.png' });
console.log(JSON.stringify(rect));
await browser.close();
process.exit(0);
