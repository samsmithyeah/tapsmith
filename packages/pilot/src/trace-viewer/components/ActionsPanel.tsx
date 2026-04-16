import { useState, useRef, useEffect } from 'preact/hooks';
import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent, GroupTraceEvent, TraceMetadata } from '../../trace/types.js';

interface Props {
  events: AnyTraceEvent[]
  actionEvents: (ActionTraceEvent | AssertionTraceEvent)[]
  selectedIndex: number
  pinnedIndex: number
  onHover: (index: number | null) => void
  onPin: (index: number) => void
  metadata: TraceMetadata
  showMetadata?: boolean
}

// Simple text-based icons — no emoji
const ACTION_ICONS: Record<string, [string, string]> = {
  tap:         ['\u25ce', 'tap'],      // ◎
  longPress:   ['\u25ce', 'tap'],
  doubleTap:   ['\u25ce', 'tap'],
  type:        ['T',      'type'],
  clearAndType:['T',      'type'],
  swipe:       ['\u2194', 'swipe'],    // ↔
  scroll:      ['\u2195', 'scroll'],   // ↕
  pressKey:    ['\u21b5', 'type'],     // ↵
  launchApp:   ['\u25b6', 'nav'],      // ▶
  openDeepLink:['\u2197', 'nav'],      // ↗
  drag:        ['\u21c4', 'swipe'],    // ⇄
  pinchIn:     ['\u25c9', 'tap'],
  pinchOut:    ['\u25c9', 'tap'],
  focus:       ['\u25cb', 'tap'],
  blur:        ['\u25cb', 'tap'],
  selectOption:['\u25bc', 'tap'],      // ▼
  highlight:   ['\u25a1', 'tap'],
  'request.get':    ['\u2190', 'api'],   // ←
  'request.post':   ['\u2192', 'api'],   // →
  'request.put':    ['\u2192', 'api'],
  'request.patch':  ['\u2192', 'api'],
  'request.delete': ['\u2717', 'api'],   // ✗
  'request.head':   ['\u2190', 'api'],
};

function getIcon(event: ActionTraceEvent | AssertionTraceEvent): [string, string] {
  if (event.type === 'assertion') {
    const passed = event.passed;
    return [passed ? '\u2713' : '\u2717', passed ? 'assert' : 'assert failed'];
  }
  if (!event.success) {
    return ['\u2717', 'failed'];  // ✗
  }
  return ACTION_ICONS[event.action] ?? ['\u2022', 'tap'];
}

function getLabel(event: ActionTraceEvent | AssertionTraceEvent): string {
  if (event.type === 'assertion') return event.assertion;
  return event.action;
}

function getSelectorDisplay(event: ActionTraceEvent | AssertionTraceEvent): string {
  const sel = event.selector;
  if (!sel) return '';
  try {
    const parsed = JSON.parse(sel);
    if (parsed.text) return `"${parsed.text}"`;
    if (parsed.role) return `role=${parsed.role.role}${parsed.role.name ? ` "${parsed.role.name}"` : ''}`;
    if (parsed.contentDesc) return `desc="${parsed.contentDesc}"`;
    if (parsed.testId) return `testId="${parsed.testId}"`;
    if (parsed.resourceId) return `id="${parsed.resourceId}"`;
    return sel;
  } catch {
    return sel;
  }
}

export function ActionsPanel({ events, actionEvents, selectedIndex, pinnedIndex, onHover, onPin, metadata, showMetadata }: Props) {
  const [tab, setTab] = useState<'actions' | 'metadata'>('actions');
  const [filter, setFilter] = useState('');
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMetadata && tab === 'metadata') setTab('actions');
  }, [showMetadata, tab]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedIndex]);

  // Build flat list with groups
  const items: Array<
    | { kind: 'action'; event: ActionTraceEvent | AssertionTraceEvent; actionIndex: number }
    | { kind: 'group-start'; event: GroupTraceEvent }
    | { kind: 'group-end'; event: GroupTraceEvent }
  > = [];

  let actionIdx = 0;
  for (const event of events) {
    if (event.type === 'action' || event.type === 'assertion') {
      items.push({ kind: 'action', event: event as ActionTraceEvent | AssertionTraceEvent, actionIndex: actionIdx });
      actionIdx++;
    } else if (event.type === 'group-start') {
      items.push({ kind: 'group-start', event: event as GroupTraceEvent });
    } else if (event.type === 'group-end') {
      items.push({ kind: 'group-end', event: event as GroupTraceEvent });
    }
  }

  const filterLower = filter.toLowerCase();

  return (
    <div class="actions-panel">
      <div class="actions-header">
        <div class={`actions-header-tab${tab === 'actions' ? ' active' : ''}`} onClick={() => setTab('actions')}>Actions</div>
        {showMetadata && <div class={`actions-header-tab${tab === 'metadata' ? ' active' : ''}`} onClick={() => setTab('metadata')}>Metadata</div>}
      </div>

      {tab === 'actions' && (
        items.length > 0 ? (
          <>
            <div class="actions-filter">
              <input
                type="text"
                placeholder="Filter actions..."
                value={filter}
                onInput={e => setFilter((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="actions-list">
              {items.map((item, i) => {
                if (item.kind === 'group-start') {
                  if (filterLower && !item.event.name.toLowerCase().includes(filterLower)) return null;
                  const isLifecycle = item.event.name === 'beforeAll Hooks' || item.event.name === 'beforeEach Hooks' || item.event.name === 'afterEach Hooks' || item.event.name === 'Test';
                  return (
                    <div key={`g-${i}`} class={`group-item${isLifecycle ? ' lifecycle' : ''}`}>
                      {isLifecycle ? '' : '\u25b8 '}{item.event.name}
                    </div>
                  );
                }
                if (item.kind === 'group-end') return null;

                const event = item.event;
                const label = getLabel(event);
                const selector = getSelectorDisplay(event);
                const matchesFilter = !filterLower ||
                  label.toLowerCase().includes(filterLower) ||
                  selector.toLowerCase().includes(filterLower);
                if (!matchesFilter) return null;

                const isSelected = item.actionIndex === selectedIndex;
                const isPinned = item.actionIndex === pinnedIndex;
                const isFailed = event.type === 'action' ? !event.success : !event.passed;
                const [icon, iconClass] = getIcon(event);

                return (
                  <div
                    key={`a-${item.actionIndex}`}
                    ref={isSelected ? selectedRef : undefined}
                    class={`action-item${isSelected ? ' selected' : ''}${isPinned ? ' pinned' : ''}${isFailed ? ' failed' : ''}`}
                    onMouseEnter={() => onHover(item.actionIndex)}
                    onMouseLeave={() => onHover(null)}
                    onClick={() => onPin(item.actionIndex)}
                  >
                    <span class={`action-icon ${iconClass}`}>{icon}</span>
                    <div class="action-details">
                      <span class="action-name">{label}</span>
                      {selector && <span class="action-selector-text">{selector}</span>}
                    </div>
                    <span class="action-duration">{event.duration}ms</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div class="ui-empty-state">
            <div class="ui-empty-icon">{'\u25b6'}</div>
            <div class="ui-empty-title">No actions yet</div>
            <div class="ui-empty-hint">Run tests to see actions here</div>
            <div class="ui-empty-shortcut">Press <kbd>R</kbd> to run all</div>
          </div>
        )
      )}

      {tab === 'metadata' && (
        <div class="metadata-panel">
          <div class="metadata-grid">
            <span class="metadata-label">Test</span>
            <span class="metadata-value">{metadata.testName}</span>
            <span class="metadata-label">File</span>
            <span class="metadata-value">{metadata.testFile}</span>
            <span class="metadata-label">Status</span>
            <span class="metadata-value" style={{ color: metadata.testStatus === 'passed' ? 'var(--color-success)' : metadata.testStatus === 'failed' ? 'var(--color-error)' : undefined }}>{metadata.testStatus}</span>
            <span class="metadata-label">Duration</span>
            <span class="metadata-value">{metadata.testDuration}ms</span>
            <span class="metadata-label">Device</span>
            <span class="metadata-value">{metadata.device.serial}</span>
            {metadata.device.model && <>
              <span class="metadata-label">Model</span>
              <span class="metadata-value">{metadata.device.model}</span>
            </>}
            <span class="metadata-label">Emulator</span>
            <span class="metadata-value">{metadata.device.isEmulator ? 'Yes' : 'No'}</span>
            <span class="metadata-label">Actions</span>
            <span class="metadata-value">{metadata.actionCount}</span>
            <span class="metadata-label">Screenshots</span>
            <span class="metadata-value">{metadata.screenshotCount}</span>
            <span class="metadata-label">Pilot</span>
            <span class="metadata-value">v{metadata.pilotVersion}</span>
            {metadata.project && <>
              <span class="metadata-label">Project</span>
              <span class="metadata-value">{metadata.project}</span>
            </>}
            {metadata.appState && <>
              <span class="metadata-label">App State</span>
              <span class="metadata-value">{metadata.appState}</span>
            </>}
            {metadata.error && <>
              <span class="metadata-label">Error</span>
              <span class="metadata-value" style={{ color: 'var(--color-error)' }}>{metadata.error}</span>
            </>}
          </div>
        </div>
      )}
    </div>
  );
}
