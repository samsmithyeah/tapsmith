import type { TraceMetadata } from '../../trace/types.js';

// ─── Types ───

export type Theme = 'system' | 'light' | 'dark'

interface Props {
  metadata: TraceMetadata | null
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

// ─── Styles ───

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.textContent = `
    .top-bar {
      display: flex;
      align-items: center;
      height: 36px;
      padding: 0 12px;
      background: var(--color-topbar-bg);
      border-bottom: 1px solid var(--color-border);
      flex-shrink: 0;
      gap: 10px;
      user-select: none;
    }

    .top-bar-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .top-bar-logo {
      width: 20px;
      height: 20px;
      background: var(--color-accent);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 11px;
      color: #fff;
      letter-spacing: -0.5px;
    }

    .top-bar-title {
      font-weight: 600;
      font-size: 13px;
      color: var(--color-text-primary);
      letter-spacing: -0.2px;
    }

    .top-bar-separator {
      width: 1px;
      height: 16px;
      background: var(--color-border);
      flex-shrink: 0;
    }

    .top-bar-test-info {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      color: var(--color-text-secondary);
    }

    .top-bar-test-file {
      color: var(--color-text-primary);
    }

    .top-bar-chevron {
      color: var(--color-text-muted);
      margin: 0 1px;
    }

    .top-bar-test-status {
      font-weight: 600;
    }

    .top-bar-test-status.passed {
      color: var(--color-success);
    }

    .top-bar-test-status.failed {
      color: var(--color-error);
    }

    .top-bar-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }

    .top-bar-theme-label {
      font-size: 12px;
      color: var(--color-text-muted);
    }

    .top-bar-theme-select {
      font-size: 12px;
      padding: 2px 4px;
      border-radius: 4px;
      border: 1px solid var(--color-border);
      background: var(--color-bg-secondary);
      color: var(--color-text-primary);
      cursor: pointer;
      outline: none;
      font-family: inherit;
    }

    .top-bar-theme-select:focus {
      border-color: var(--color-accent);
    }
  `;
  document.head.appendChild(el);
}

// ─── Helpers ───

function formatTestPath(metadata: TraceMetadata): preact.JSX.Element {
  const file = metadata.testFile;
  // Show just filename (not full path)
  const fileName = file.split('/').pop() ?? file;

  // Split testName by " > " (describe blocks + test name)
  const parts = metadata.testName.split(' > ');

  const statusIcon = metadata.testStatus === 'passed' ? '\u2713' : '\u2717';
  const statusClass = metadata.testStatus === 'passed' ? 'passed' : 'failed';

  return (
    <span>
      <span class={`top-bar-test-status ${statusClass}`}>{statusIcon}</span>
      {' '}
      <span class="top-bar-test-file">{fileName}</span>
      {parts.map((part, i) => (
        <span key={i}>
          <span class="top-bar-chevron"> {'>'} </span>
          {part}
        </span>
      ))}
    </span>
  );
}

// ─── Component ───

export function TopBar({ metadata, theme, onThemeChange }: Props) {
  injectStyles();

  return (
    <div class="top-bar">
      <div class="top-bar-brand">
        <div class="top-bar-logo">P</div>
        <span class="top-bar-title">Pilot</span>
      </div>

      {metadata && (
        <>
          <div class="top-bar-separator" />
          <div class="top-bar-test-info">
            {formatTestPath(metadata)}
          </div>
        </>
      )}

      <div class="top-bar-right">
        <span class="top-bar-theme-label">Theme:</span>
        <select
          class="top-bar-theme-select"
          value={theme}
          onChange={(e) => onThemeChange((e.target as HTMLSelectElement).value as Theme)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
    </div>
  );
}
