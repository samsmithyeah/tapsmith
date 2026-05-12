import type { TraceMetadata } from '../../trace/types.js';

// ─── Types ───

export type Theme = 'system' | 'light' | 'dark'

interface Props {
  metadata: TraceMetadata | null
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

// ─── Helpers ───

function formatTestPath(metadata: TraceMetadata): preact.JSX.Element {
  const file = metadata.testFile;
  const fileName = file.split('/').pop() ?? file;
  const parts = metadata.testName.split(' > ');

  const statusIcon = metadata.testStatus === 'passed' ? '✓' : '✗';
  const statusClass = metadata.testStatus === 'passed' ? 'passed' : 'failed';

  return (
    <span>
      <span class={`rail-test-status ${statusClass}`}>{statusIcon}</span>
      {' '}
      <span class="rail-test-file">{fileName}</span>
      {parts.map((part, i) => (
        <span key={i}>
          <span class="rail-chevron"> {'>'} </span>
          {part}
        </span>
      ))}
    </span>
  );
}

// ─── Component ───

export function TopBar({ metadata, theme, onThemeChange }: Props) {
  return (
    <div class="rail">
      <div class="rail-brand">
        <span class="rail-brand-mark">T</span>
        <div>
          <div class="rail-logo-text">Tapsmith</div>
          <div class="rail-brand-sub">Trace Viewer</div>
        </div>
      </div>

      {metadata && (
        <div class="rail-center">
          <div class="rail-test-info">
            {formatTestPath(metadata)}
          </div>
        </div>
      )}

      <div class="rail-right">
        <select
          class="rail-theme-select"
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
