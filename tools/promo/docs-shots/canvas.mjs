// Print the mirror canvas rect for a device tab (CSS px) to calibrate pick fractions.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', timeout: 120000, protocolTimeout: 300000, args: ['--no-first-run', '--user-data-dir=/tmp/docs-shots-chrome-state'] });
const page = await browser.newPage(); await page.setViewport({ width: 1512, height: 828 });
await page.goto('http://127.0.0.1:4830/', { waitUntil: 'networkidle2' }); await new Promise((r) => setTimeout(r, 2500));
const tab = process.argv[2] || 'Tapsmith_Phone';
await page.evaluate((t) => { for (const el of document.querySelectorAll('.worker-tab')) if ((el.textContent || '').includes(t)) el.click(); }, tab);
await new Promise((r) => setTimeout(r, 1200));
console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.dm-canvas')].map((c) => { const r = c.getBoundingClientRect(); return { left: r.x, top: r.y, w: r.width, h: r.height }; }))));
await page.screenshot({ path: process.argv[3] || '/tmp/canvas.png' });
await browser.close();
