// Auto-extracted from main.tsx — UI mode stylesheet

export const uiModeStyles = `
/* ─── Reset & Base ─── */

:root, [data-theme="dark"] {
  /* UI mode variables */
  --bg-primary: #1e1e1e;
  --bg-secondary: #252526;
  --bg-tertiary: #2d2d30;
  --bg-hover: #2a2d2e;
  --bg-selected: #094771;
  --bg-active: #37373d;
  --border: #3e3e42;
  --border-light: #4e4e52;
  --color-text: #cccccc;
  --color-text-muted: #888888;
  --color-text-faint: #666666;
  --color-text-faintest: #444444;
  --color-accent: #4fc1ff;
  --color-success: #4ec9b0;
  --color-error: #f14c4c;
  --color-warning: #cca700;
  --color-skipped: #888888;
  --color-topbar-bg: #252526;
  --font-mono: 'SF Mono', 'Cascadia Code', 'Consolas', 'DejaVu Sans Mono', monospace;
  --font-ui: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  /* Trace viewer component variables (used by ActionsPanel, DetailTabs, etc.) */
  --color-bg: #1e1e1e;
  --color-bg-secondary: #252526;
  --color-bg-tertiary: #2d2d2d;
  --color-bg-hover: #2a2d2e;
  --color-bg-selected: #04395e;
  --color-bg-group: #1e2a3a;
  --color-border: #3c3c3c;
  --color-text-primary: #e8e8e8;
  --color-text-secondary: #ccc;
  --color-accent-hover: #6dcfff;
  --color-accent-dim: #264f78;
  --color-string: #ce9178;
  --color-keyword: #569cd6;
  --color-function: #dcdcaa;
  --color-number: #b5cea8;
  --color-attr: #9cdcfe;
  --color-highlight: rgba(79,193,255,0.12);
  --color-error-bg: #2d1215;
  --color-error-border: #f8514933;
  --color-spinner-track: #333;
}

[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f3f3f3;
  --bg-tertiary: #e8e8e8;
  --bg-hover: #e8e8e8;
  --bg-selected: #cce5ff;
  --bg-active: #d4d4d4;
  --border: #d4d4d4;
  --border-light: #c8c8c8;
  --color-text: #333333;
  --color-text-muted: #666666;
  --color-text-faint: #999999;
  --color-text-faintest: #bbbbbb;
  --color-accent: #0078d4;
  --color-success: #16825d;
  --color-error: #cd3131;
  --color-warning: #bf8803;
  --color-skipped: #888888;
  --color-topbar-bg: #f3f3f3;
  /* Trace viewer light theme */
  --color-bg: #ffffff;
  --color-bg-secondary: #f5f5f5;
  --color-bg-tertiary: #e8e8e8;
  --color-bg-hover: #eaeaea;
  --color-bg-selected: #d6ecff;
  --color-bg-group: #e8f0fa;
  --color-border: #d4d4d4;
  --color-text-primary: #1f1f1f;
  --color-text-secondary: #383838;
  --color-accent-hover: #106ebe;
  --color-accent-dim: #a0c4e8;
  --color-string: #a31515;
  --color-keyword: #0000ff;
  --color-function: #795e26;
  --color-number: #098658;
  --color-attr: #001080;
  --color-highlight: rgba(0,120,212,0.1);
  --color-error-bg: #fde7e7;
  --color-error-border: #d32f2f33;
  --color-spinner-track: #ddd;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body, #app {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: 13px;
}

/* ─── Layout ─── */

.ui-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.ui-topbar {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
}

.ui-body {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.ui-explorer {
  flex: 0 0 auto;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-secondary);
}

.ui-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.ui-filmstrip {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}

.ui-middle {
  flex: 1;
  display: flex;
  min-height: 0;
  overflow: hidden;
}

.ui-actions {
  flex: 0 0 auto;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}

.ui-screenshot {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.ui-detail {
  flex: 0 0 auto;
  overflow: hidden;
  border-top: 1px solid var(--border);
}

.ui-resize-handle {
  flex: 0 0 6px;
  background: transparent;
  transition: background 0.15s;
  position: relative;
}
.ui-resize-handle:hover { background: color-mix(in srgb, var(--color-accent) 30%, transparent); }
.ui-resize-handle:active { background: var(--color-accent); }
.ui-resize-handle:hover::after {
  content: '\u2022\u2022\u2022';
  position: absolute;
  color: var(--color-accent);
  font-size: 8px;
  letter-spacing: -1px;
  pointer-events: none;
}
.ui-resize-col { cursor: col-resize; }
.ui-resize-col:hover::after {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(90deg);
}
.ui-resize-row { cursor: row-resize; }
.ui-resize-row:hover::after {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

/* ─── Screen area (Action screenshots) ─── */

.ui-screen-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.ui-screen-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 2px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  flex-shrink: 0;
}

.ui-download-btn {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-faint);
  font-size: 11px;
  cursor: pointer;
  font-family: var(--font-ui);
}
.ui-download-btn:hover { color: var(--color-text); background: var(--bg-hover); }

.ui-screen-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ─── Device Pane ─── */

.ui-device-pane {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--border);
  background: var(--bg-secondary);
}

.device-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.device-pane-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.device-pane-header-title {
  font-weight: 600;
  color: var(--color-text);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.device-pane-serial {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-pane-workers {
  display: flex;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.device-pane-worker {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 11px;
  font-family: var(--font-ui);
  transition: background 0.15s, border-color 0.15s;
}
.device-pane-worker:hover { background: var(--bg-hover); color: var(--color-text); }
.device-pane-worker.active { border-color: var(--color-accent); color: var(--color-accent); background: var(--bg-selected); }

.device-pane-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
}

.device-pane-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  padding: 8px;
  overflow-y: auto;
  height: 100%;
}

@container (min-width: 400px) {
  .device-pane-grid { grid-template-columns: 1fr 1fr; }
}

@container (min-width: 800px) {
  .device-pane-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
}

.device-pane-grid-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 120px;
}

.device-pane-grid-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
  padding: 0 2px;
}

.device-pane-grid-item .dm-viewport {
  flex: 1;
  min-height: 0;
  align-items: flex-start;
}

.device-pane-grid-item .dm-canvas {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: #000;
}

/* ─── Run Controls (Top Bar) ─── */

.run-controls {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  gap: 12px;
  background: var(--bg-secondary);
  min-height: 42px;
}

.rc-left { display: flex; align-items: center; gap: 8px; }
.rc-center { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: center; }
.rc-right { display: flex; align-items: center; gap: 12px; }

.rc-logo-text {
  font-weight: 700;
  font-size: 15px;
  color: var(--color-accent);
  letter-spacing: -0.3px;
}
.rc-mode {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-left: 6px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
}

.rc-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--color-text);
  cursor: pointer;
  font-size: 12px;
  font-family: var(--font-ui);
  transition: background 0.15s;
}
.rc-btn:hover:not(:disabled) { background: var(--bg-hover); }
.rc-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.rc-run-all { color: var(--color-success); }
.rc-stop { color: var(--color-error); }
.rc-toggle.active { color: #fff; border-color: var(--color-accent); background: var(--color-accent); box-shadow: 0 0 6px rgba(79,193,255,0.3); }
.rc-run-failed { color: var(--color-warning); }
.rc-download { color: var(--color-text-muted); }


.rc-counts { display: flex; gap: 8px; font-size: 12px; }
.rc-count.passed { color: var(--color-success); }
.rc-count.failed { color: var(--color-error); }
.rc-count.skipped { color: var(--color-skipped); }

.rc-connection {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--color-text-muted);
}
.rc-divider {
  width: 1px;
  height: 16px;
  background: var(--border);
  flex-shrink: 0;
}
.rc-device {
  display: flex;
  align-items: center;
  gap: 4px;
}
.rc-device-actionable {
  cursor: context-menu;
}
.rc-context-menu {
  position: fixed;
  z-index: 1000;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  padding: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  min-width: 160px;
}
.rc-context-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-family: var(--font-ui);
  cursor: pointer;
  text-align: left;
}
.rc-context-item:hover {
  background: var(--bg-hover);
  color: var(--color-text-primary);
}
.rc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.rc-dot.idle { background: var(--color-success); }
.rc-dot.running { background: var(--color-accent); animation: pulse 1s infinite; }
.rc-dot.done { background: var(--color-success); }
.rc-dot.initializing { background: var(--color-warning); }
.rc-dot.error { background: var(--color-error); }

.rc-theme-select {
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: var(--font-ui);
  cursor: pointer;
  outline: none;
}
.rc-theme-select:focus { border-color: var(--color-accent); box-shadow: 0 0 0 2px rgba(79, 193, 255, 0.15); }

/* ─── Test Explorer ─── */

.test-explorer { display: flex; flex-direction: column; height: 100%; }

.te-header { padding: 8px; border-bottom: 1px solid var(--border); }

.te-search {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--color-text);
  font-size: 12px;
  font-family: var(--font-ui);
  outline: none;
  margin-bottom: 6px;
}
.te-search:focus { border-color: var(--color-accent); box-shadow: 0 0 0 2px rgba(79, 193, 255, 0.15); }
.te-search::placeholder { color: var(--color-text-faint); }

.te-status-filters { display: flex; gap: 3px; }

.te-status-btn {
  flex: 1;
  padding: 3px 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 10px;
  font-family: var(--font-ui);
  transition: background 0.15s;
}
.te-status-btn:hover { background: var(--bg-hover); }
.te-status-btn.active { background: var(--bg-active); color: var(--color-text); border-color: var(--border-light); }
.te-status-btn.active.te-status-passed { color: var(--color-success); }
.te-status-btn.active.te-status-failed { color: var(--color-error); }

.te-count { font-weight: 600; margin-left: 2px; }

.te-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.te-toolbar-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.te-toolbar-actions { display: flex; gap: 2px; }
.te-toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0;
}
.te-toolbar-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--color-text); }
.te-toolbar-btn:disabled { opacity: 0.35; cursor: default; }
.te-toolbar-btn.active { color: var(--color-accent); background: var(--bg-hover); }
.te-toolbar-btn.active:hover:not(:disabled) { color: var(--color-accent); }
@keyframes te-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.te-toolbar-btn.stopping { color: var(--color-warning, #e5a100); }
.te-toolbar-btn.stopping svg { animation: te-pulse 1.2s ease-in-out infinite; }
.te-toolbar-sep { width: 1px; height: 14px; background: var(--border); margin: 0 2px; align-self: center; }

.te-tree { flex: 1; overflow-y: auto; padding: 4px 0; }

.te-empty { padding: 20px; text-align: center; color: var(--color-text-faint); font-size: 12px; }

.te-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  min-height: 26px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s, border-left-color 0.15s;
  border-left: 2px solid transparent;
}
.te-node:hover { background: var(--bg-hover); }
.te-node.selected { background: var(--bg-selected); }
.te-node.te-status-running { border-left-color: var(--color-accent); }
.te-node.te-status-flash-failed { animation: flash-fail 0.6s ease-out; }
@keyframes flash-fail {
  0% { background: rgba(241, 76, 76, 0.3); }
  100% { background: transparent; }
}
.te-node.te-node-project { margin-top: 4px; padding-top: 6px; padding-bottom: 6px; border-top: 1px solid var(--border); }
.te-node-group:first-child > .te-node.te-node-project { margin-top: 0; border-top: none; }

.te-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  transition: transform 0.15s;
  cursor: pointer;
  flex-shrink: 0;
}
.te-chevron::before {
  content: '';
  display: block;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent var(--color-text-muted);
}
.te-chevron:hover::before { border-left-color: var(--color-text); }
.te-chevron.expanded { transform: rotate(90deg); }
.te-chevron-spacer { display: inline-block; width: 20px; flex-shrink: 0; }

.te-status-icon { width: 16px; text-align: center; font-size: 12px; flex-shrink: 0; }
.te-status-icon.passed { color: var(--color-success); }
.te-status-icon.failed { color: var(--color-error); }
.te-status-icon.skipped { color: var(--color-skipped); }
.te-status-icon.running { color: var(--color-accent); animation: pulse 1s infinite; }
.te-status-icon.idle { color: var(--color-text-faint); }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.te-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.te-node-file .te-name { font-weight: 600; }
.te-node-project .te-name { font-weight: 700; color: var(--color-accent); font-size: 11px; letter-spacing: 0.03em; text-transform: uppercase; }

.te-deps { font-size: 10px; color: var(--color-text-faint); font-style: italic; flex-shrink: 0; margin-right: 4px; }

.te-duration { font-size: 10px; color: var(--color-text-faint); font-family: var(--font-mono); flex-shrink: 0; }

.te-actions { display: flex; gap: 2px; flex-shrink: 0; }
.te-action-btn { opacity: 0; transition: opacity 0.15s; }
.te-node:hover .te-action-btn { opacity: 1; }
.te-watch-btn.active { opacity: 1; }

.te-action-btn {
  width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 3px;
  background: transparent; color: var(--color-text-muted);
  cursor: pointer; font-size: 10px;
}
.te-action-btn:hover { background: var(--bg-active); color: var(--color-text); }
.te-run-btn:hover { color: var(--color-success); }
.te-watch-btn.active { color: var(--color-accent); }

/* ─── Device Mirror ─── */

.device-mirror {
  display: flex; flex-direction: column; align-items: center;
  height: 100%; width: 100%; padding: 8px; gap: 6px;
}

.dm-viewport {
  flex: 1; display: flex; align-items: center; justify-content: center;
  position: relative; min-height: 0; width: 100%;
}

.dm-canvas {
  max-width: 100%; max-height: 100%; object-fit: contain;
  border-radius: 6px; border: 2px solid var(--border); background: #000;
}
.dm-canvas.tap-mode { cursor: crosshair; border-color: var(--color-accent); }

.dm-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-tertiary); border-radius: 6px; z-index: 1;
}

.dm-placeholder {
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  color: var(--color-text-faint);
}

.dm-phone-icon { width: 42px; height: 72px; color: var(--color-text-faintest); }

.dm-placeholder-text { font-size: 13px; font-weight: 600; color: var(--color-text-muted); }
.dm-placeholder-hint { font-size: 11px; color: var(--color-text-faint); }

.dm-placeholder-dots { display: flex; gap: 6px; }
.dm-dot {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--color-text-faintest);
  animation: dm-bounce 1.4s ease-in-out infinite;
}
.dm-dot:nth-child(2) { animation-delay: 0.2s; }
.dm-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes dm-bounce { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }

.dm-controls { display: flex; gap: 6px; }

.dm-btn {
  display: flex; align-items: center; gap: 4px;
  padding: 4px 10px; border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg-tertiary); color: var(--color-text-muted);
  cursor: pointer; font-size: 11px; font-family: var(--font-ui);
  transition: background 0.15s, color 0.15s;
}
.dm-btn:hover { background: var(--bg-hover); color: var(--color-text); }
.dm-btn.active { color: var(--color-accent); border-color: var(--color-accent); }

/* ─── Trace viewer components (ActionsPanel, DetailTabs, etc.) ─── */

.actions-panel { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--color-bg-secondary); overflow: hidden; }
.actions-header { display: flex; align-items: center; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.actions-header-tab { padding: 6px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--color-text-muted); cursor: pointer; border-bottom: 2px solid transparent; }
.actions-header-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
.actions-filter { padding: 6px 8px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.actions-filter input { width: 100%; padding: 4px 8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); font-size: 12px; outline: none; }
.actions-filter input:focus { border-color: var(--color-accent); box-shadow: 0 0 0 2px rgba(79, 193, 255, 0.15); }
.actions-list { flex: 1; overflow-y: auto; }

.action-item { padding: 5px 10px; cursor: pointer; border-left: 2px solid transparent; display: flex; align-items: center; gap: 8px; min-height: 30px; }
.action-item:hover { background: var(--color-bg-hover); }
.action-item.selected { background: var(--color-bg-selected); border-left-color: var(--color-accent); }
.action-item.pinned { border-left-color: var(--color-accent); }
.action-item.pinned:not(.selected) { border-left-color: var(--color-accent-dim); }
.action-item.failed .action-name { color: var(--color-error); }
.action-icon { font-size: 12px; flex-shrink: 0; width: 18px; text-align: center; color: var(--color-text-muted); }
.action-icon.tap { color: var(--color-success); }
.action-icon.type { color: var(--color-string); }
.action-icon.swipe { color: var(--color-keyword); }
.action-icon.scroll { color: var(--color-keyword); }
.action-icon.nav { color: var(--color-function); }
.action-icon.assert { color: var(--color-number); }
.action-icon.assert.failed, .action-icon.failed { color: var(--color-error); }
.action-name { font-size: 12px; color: var(--color-text-primary); white-space: nowrap; }
.action-selector-text { color: var(--color-text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.action-duration { color: var(--color-text-faintest); font-size: 11px; flex-shrink: 0; margin-left: auto; padding-left: 8px; }
.action-details { display: flex; align-items: center; overflow: hidden; flex: 1; min-width: 0; gap: 6px; }

.group-item { padding: 4px 10px; color: var(--color-text-muted); font-size: 11px; font-weight: 600; border-left: 2px solid var(--color-accent); background: var(--color-bg-group); }
.group-item.lifecycle { border-left: none; background: var(--color-bg); color: var(--color-text-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; padding: 6px 10px 3px; margin-top: 2px; }

.metadata-panel { padding: 12px; font-size: 12px; overflow-y: auto; flex: 1; }
.metadata-grid { display: grid; grid-template-columns: 100px 1fr; gap: 4px 12px; }
.metadata-label { color: var(--color-text-muted); }
.metadata-value { color: var(--color-text-secondary); word-break: break-all; }

/* Screenshot panel */
.screenshot-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--color-bg); min-height: 0; }
.screenshot-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); flex-shrink: 0; }
.screenshot-tab { padding: 6px 16px; cursor: pointer; color: var(--color-text-muted); border-bottom: 2px solid transparent; font-size: 12px; }
.screenshot-tab:hover { color: var(--color-text-secondary); }
.screenshot-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
.screenshot-container { flex: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 8px; min-height: 0; }
.screenshot-empty { color: var(--color-text-faintest); text-align: center; font-size: 13px; }

.detail-panel { height: 100%; display: flex; flex-direction: column; background: var(--color-bg); }
.detail-tabs-bar { display: flex; gap: 0; background: var(--color-bg-secondary); border-bottom: 1px solid var(--color-border); flex-shrink: 0; }
.detail-tab { padding: 6px 14px; cursor: pointer; color: var(--color-text-muted); border-bottom: 2px solid transparent; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
.detail-tab:hover { color: var(--color-text-secondary); }
.detail-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
.detail-tab.has-error { color: var(--color-error); }
.detail-content { flex: 1; overflow-y: auto; padding: 10px 14px; font-size: 12px; }
.detail-content.detail-content-flush { padding: 0; overflow: hidden; }

.call-grid { display: grid; grid-template-columns: 90px 1fr; gap: 3px 12px; }
.call-label { color: var(--color-text-muted); }
.call-value { color: var(--color-text-secondary); word-break: break-all; }
.call-value.error { color: var(--color-error); }
.call-value.success { color: var(--color-success); }

.log-entry { font-family: var(--font-mono); font-size: 11px; padding: 1px 0; display: flex; gap: 8px; line-height: 1.6; }
.log-level { min-width: 40px; font-weight: 600; text-transform: uppercase; font-size: 10px; }
.log-level.error { color: var(--color-error); }
.log-level.warn { color: var(--color-warning); }
.log-level.info { color: var(--color-accent); }
.log-level.debug { color: var(--color-text-muted); }
.log-level.log { color: var(--color-text-secondary); }
.log-source { font-size: 10px; color: var(--color-text-faintest); min-width: 46px; }
.log-message { word-break: break-all; }

.source-code { font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre; overflow-x: auto; }
.source-line { display: flex; }
.source-line-number { min-width: 40px; text-align: right; padding-right: 12px; color: var(--color-text-faintest); user-select: none; }
.source-line-content { flex: 1; }
.source-line.highlight { background: var(--color-highlight); }

.error-block { display: flex; flex-direction: column; gap: 8px; }
.error-entry { background: var(--color-error-bg); border: 1px solid var(--color-error-border); border-radius: 4px; padding: 10px; }
.error-entry-selected { border-color: var(--color-error); }
.error-entry-label { font-size: 11px; color: var(--color-text-muted); margin-bottom: 4px; font-family: var(--font-mono); }
.error-message { color: var(--color-error); font-weight: 500; margin-bottom: 6px; font-size: 12px; }
.error-stack { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); white-space: pre-wrap; word-break: break-all; }
.test-error-banner { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: var(--color-error-bg); border-bottom: 1px solid var(--color-error-border); cursor: pointer; font-size: 12px; color: var(--color-error); flex-shrink: 0; }
.test-error-banner:hover { background: var(--color-error-border); }
.test-error-banner-icon { font-weight: 700; flex-shrink: 0; }
.test-error-banner-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.no-content { color: var(--color-text-faintest); font-size: 12px; }

/* Timeline */
.timeline { display: flex; align-items: flex-end; gap: 0; padding: 0; background: var(--color-bg-secondary); border-bottom: 1px solid var(--color-border); flex-shrink: 0; overflow-x: auto; position: relative; height: 80px; }
.timeline-inner { display: flex; align-items: flex-end; gap: 2px; padding: 4px 8px; min-width: 100%; }
.timeline-thumb { height: 56px; width: auto; border-radius: 2px; border: 2px solid transparent; cursor: pointer; opacity: 0.6; transition: all 0.1s; flex-shrink: 0; }
.timeline-thumb:hover { opacity: 1; }
.timeline-thumb.selected { opacity: 1; border-color: var(--color-accent); }
.timeline-thumb.failed { border-bottom: 2px solid var(--color-error); }
.timeline-placeholder { width: 40px; height: 56px; border-radius: 2px; background: var(--color-bg-tertiary); border: 2px solid transparent; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--color-text-faintest); flex-shrink: 0; cursor: pointer; }
.timeline-placeholder.selected { border-color: var(--color-accent); }
.timeline-time-label { position: absolute; transform: translateX(-50%); }
.timeline-meta { position: absolute; top: 2px; right: 12px; font-size: 11px; color: var(--color-text-faint); }
.timeline-meta .test-status { font-weight: 600; }
.timeline-meta .passed { color: var(--color-success); }
.timeline-meta .failed { color: var(--color-error); }
.timeline-meta .running { color: var(--color-accent); animation: pulse 1s infinite; }

/* ─── Scrollbar ─── */


/* ─── Empty State ─── */

.ui-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--color-text-faint);
  user-select: none;
}
.ui-empty-icon {
  font-size: 28px;
  color: var(--color-text-faintest);
  margin-bottom: 4px;
}
.ui-empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-muted);
}
.ui-empty-hint {
  font-size: 12px;
}
.ui-empty-shortcut {
  font-size: 11px;
  margin-top: 4px;
}
.ui-empty-shortcut kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--border-light);
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  box-shadow: 0 1px 0 var(--border);
}


/* ─── Run Duration ─── */

.rc-elapsed {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-muted);
  min-width: 48px;
  text-align: right;
  tabular-nums: true;
  font-variant-numeric: tabular-nums;
}

/* ─── Kbd shortcut hints ─── */

.rc-kbd {
  display: inline-block;
  padding: 0 4px;
  margin-left: 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-primary);
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.5;
  box-shadow: 0 1px 0 var(--border);
}

/* ─── Scrollbar ─── */

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--border-light); }
`;
