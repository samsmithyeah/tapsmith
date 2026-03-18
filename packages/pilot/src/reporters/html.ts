/**
 * HTML reporter — self-contained interactive web report.
 *
 * Generates a single HTML file with an embedded test report that includes
 * filtering by status, test details with errors and screenshots, and
 * summary statistics. No external dependencies required to view.
 *
 * @see PILOT-70
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PilotReporter, FullResult } from '../reporter.js'
import type { PilotConfig } from '../config.js'
type OpenMode = 'always' | 'never' | 'on-failure'

export class HtmlReporter implements PilotReporter {
  private _outputFolder: string
  private _open: OpenMode
  private _config?: PilotConfig
  private _startTime = new Date()

  constructor(options: Record<string, unknown> = {}) {
    this._outputFolder = (options.outputFolder as string) ?? 'pilot-report'
    this._open = (options.open as OpenMode) ?? 'on-failure'
  }

  onRunStart(config: PilotConfig, _fileCount: number): void {
    this._config = config
    this._startTime = new Date()
  }

  async onRunEnd(result: FullResult): Promise<void> {
    const rootDir = this._config?.rootDir ?? process.cwd()
    const outputDir = path.resolve(rootDir, this._outputFolder)
    fs.mkdirSync(outputDir, { recursive: true })

    // Copy screenshots to report folder
    const screenshotMap = new Map<string, string>()
    for (const test of result.tests) {
      if (test.screenshotPath && fs.existsSync(test.screenshotPath)) {
        const basename = path.basename(test.screenshotPath)
        const dest = path.join(outputDir, basename)
        fs.copyFileSync(test.screenshotPath, dest)
        screenshotMap.set(test.screenshotPath, basename)
      }
    }

    const html = generateHtml(result, this._startTime, screenshotMap)
    const indexPath = path.join(outputDir, 'index.html')
    fs.writeFileSync(indexPath, html)

    const hasFailed = result.tests.some((t) => t.status === 'failed')
    const shouldOpen =
      this._open === 'always' || (this._open === 'on-failure' && hasFailed)

    if (shouldOpen) {
      try {
        const { spawn } = await import('node:child_process')
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        spawn(cmd, [indexPath], { detached: true, stdio: 'ignore' }).unref()
      } catch {
        // Best-effort open
      }
    }

    process.stderr.write(`HTML report written to ${indexPath}\n`)
  }
}

function generateHtml(
  result: FullResult,
  startTime: Date,
  screenshotMap: Map<string, string>,
): string {
  const passed = result.tests.filter((t) => t.status === 'passed').length
  const failed = result.tests.filter((t) => t.status === 'failed').length
  const skipped = result.tests.filter((t) => t.status === 'skipped').length
  const duration = (result.duration / 1000).toFixed(2)

  const testRows = result.tests.map((t) => {
    const screenshotFile = t.screenshotPath ? screenshotMap.get(t.screenshotPath) : null
    return {
      name: escapeHtml(t.fullName),
      status: t.status,
      duration: t.durationMs,
      error: t.error ? escapeHtml(t.error.message) : null,
      stack: t.error?.stack ? escapeHtml(t.error.stack.split('\n').slice(1, 6).join('\n')) : null,
      screenshot: screenshotFile,
    }
  })

  const testDataJson = JSON.stringify(testRows)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pilot Test Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
  .header { background: #1a1a2e; color: white; padding: 24px; border-radius: 8px; margin-bottom: 20px; }
  .header h1 { font-size: 24px; margin-bottom: 12px; }
  .stats { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat-value { font-size: 28px; font-weight: bold; }
  .stat-label { font-size: 12px; opacity: 0.7; text-transform: uppercase; }
  .stat-passed .stat-value { color: #4caf50; }
  .stat-failed .stat-value { color: #f44336; }
  .stat-skipped .stat-value { color: #ff9800; }
  .filters { margin-bottom: 16px; display: flex; gap: 8px; }
  .filter-btn { padding: 6px 16px; border: 1px solid #ddd; border-radius: 20px; background: white; cursor: pointer; font-size: 13px; }
  .filter-btn.active { background: #1a1a2e; color: white; border-color: #1a1a2e; }
  .filter-btn:hover { background: #e0e0e0; }
  .filter-btn.active:hover { background: #2a2a4e; }
  .search { margin-bottom: 16px; }
  .search input { width: 100%; padding: 10px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
  .test-list { list-style: none; }
  .test-item { background: white; border-radius: 8px; margin-bottom: 8px; overflow: hidden; border: 1px solid #e0e0e0; }
  .test-header { padding: 12px 16px; cursor: pointer; display: flex; align-items: center; gap: 12px; }
  .test-header:hover { background: #fafafa; }
  .test-icon { width: 24px; font-size: 16px; text-align: center; }
  .test-name { flex: 1; font-size: 14px; }
  .test-duration { font-size: 12px; color: #999; }
  .test-details { padding: 0 16px 16px; border-top: 1px solid #f0f0f0; display: none; }
  .test-details.open { display: block; padding-top: 12px; }
  .error-msg { background: #fff3f3; border-left: 3px solid #f44336; padding: 12px; font-family: monospace; font-size: 13px; white-space: pre-wrap; margin-bottom: 8px; border-radius: 0 4px 4px 0; }
  .stack-trace { background: #f8f8f8; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; color: #666; border-radius: 4px; }
  .screenshot { margin-top: 12px; }
  .screenshot img { max-width: 400px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }
  .screenshot img:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .status-passed { color: #4caf50; }
  .status-failed { color: #f44336; }
  .status-skipped { color: #ff9800; }
</style>
</head>
<body>
<div class="header">
  <h1>Pilot Test Report</h1>
  <p style="opacity:0.7;margin-bottom:12px">${escapeHtml(startTime.toLocaleString())} &middot; ${duration}s</p>
  <div class="stats">
    <div class="stat stat-passed"><div class="stat-value">${passed}</div><div class="stat-label">Passed</div></div>
    <div class="stat stat-failed"><div class="stat-value">${failed}</div><div class="stat-label">Failed</div></div>
    <div class="stat stat-skipped"><div class="stat-value">${skipped}</div><div class="stat-label">Skipped</div></div>
    <div class="stat"><div class="stat-value">${result.tests.length}</div><div class="stat-label">Total</div></div>
  </div>
</div>

<div class="filters">
  <button class="filter-btn active" data-filter="all">All (${result.tests.length})</button>
  <button class="filter-btn" data-filter="passed">Passed (${passed})</button>
  <button class="filter-btn" data-filter="failed">Failed (${failed})</button>
  <button class="filter-btn" data-filter="skipped">Skipped (${skipped})</button>
</div>

<div class="search">
  <input type="text" id="search" placeholder="Filter tests by name...">
</div>

<ul class="test-list" id="test-list"></ul>

<script>
const tests = ${testDataJson};

function render(filter, query) {
  const list = document.getElementById('test-list');
  list.innerHTML = '';
  const q = (query || '').toLowerCase();
  tests.forEach(function(t, i) {
    if (filter !== 'all' && t.status !== filter) return;
    if (q && t.name.toLowerCase().indexOf(q) === -1) return;
    var icon = t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '○';
    var dur = t.duration < 1000 ? t.duration + 'ms' : (t.duration/1000).toFixed(1) + 's';
    var li = document.createElement('li');
    li.className = 'test-item';
    var header = '<div class="test-header" onclick="toggle(' + i + ')">';
    header += '<span class="test-icon status-' + t.status + '">' + icon + '</span>';
    header += '<span class="test-name">' + t.name + '</span>';
    header += '<span class="test-duration">' + dur + '</span></div>';
    var details = '<div class="test-details" id="details-' + i + '">';
    if (t.error) details += '<div class="error-msg">' + t.error + '</div>';
    if (t.stack) details += '<div class="stack-trace">' + t.stack + '</div>';
    if (t.screenshot) details += '<div class="screenshot"><img src="' + t.screenshot + '" onclick="window.open(this.src)"></div>';
    details += '</div>';
    li.innerHTML = header + details;
    list.appendChild(li);
  });
}

function toggle(i) {
  var el = document.getElementById('details-' + i);
  if (el) el.classList.toggle('open');
}

document.querySelectorAll('.filter-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    render(btn.dataset.filter, document.getElementById('search').value);
  });
});

document.getElementById('search').addEventListener('input', function(e) {
  var active = document.querySelector('.filter-btn.active');
  render(active ? active.dataset.filter : 'all', e.target.value);
});

render('all', '');
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
