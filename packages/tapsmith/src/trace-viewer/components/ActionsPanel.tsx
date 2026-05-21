import { useState, useRef, useEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Check, X, Type, Clock, Play, ExternalLink, MoveHorizontal, ArrowUpDown, CircleDot, ChevronDown, Hand, Pointer, Eye, Keyboard, RotateCcw, Target, Globe, Send, AlertTriangle } from 'lucide-preact';
import type { AnyTraceEvent, ActionTraceEvent, AssertionTraceEvent, GroupTraceEvent, TraceMetadata } from '../../trace/types.js';
import type { InFlightAction } from '../types.js';

interface Props {
  events: AnyTraceEvent[]
  actionEvents: (ActionTraceEvent | AssertionTraceEvent)[]
  selectedIndex: number
  pinnedIndex: number
  onHover: (index: number | null) => void
  onPin: (index: number) => void
  metadata: TraceMetadata
  showMetadata?: boolean
  /** UI mode only — the action/assertion currently in flight on the device.
   * Renders an extra row at the end of the list with a spinner. */
  inFlightAction?: InFlightAction | null
  /** UI mode only — pre-flight progress text from the device-setup phase
   * (e.g. "installing app demo.apk"). Replaces the empty state with a
   * spinner + message while no actions have run yet. */
  preflightMessage?: string
}


const ICON_SIZE = 13;

const ACTION_ICON_MAP: Record<string, [ComponentChildren, string]> = {
  tap:         [<Hand size={ICON_SIZE} />, 'tap'],
  longPress:   [<Hand size={ICON_SIZE} />, 'tap'],
  doubleTap:   [<Hand size={ICON_SIZE} />, 'tap'],
  type:        [<Type size={ICON_SIZE} />, 'type'],
  clearAndType:[<Type size={ICON_SIZE} />, 'type'],
  swipe:       [<MoveHorizontal size={ICON_SIZE} />, 'swipe'],
  scroll:      [<ArrowUpDown size={ICON_SIZE} />, 'scroll'],
  scrollIntoView: [<Eye size={ICON_SIZE} />, 'scroll'],
  pressKey:    [<Keyboard size={ICON_SIZE} />, 'type'],
  launchApp:   [<Play size={ICON_SIZE} />, 'nav'],
  openDeepLink:[<ExternalLink size={ICON_SIZE} />, 'nav'],
  restartApp:  [<RotateCcw size={ICON_SIZE} />, 'nav'],
  drag:        [<MoveHorizontal size={ICON_SIZE} />, 'swipe'],
  pinchIn:     [<Pointer size={ICON_SIZE} />, 'tap'],
  pinchOut:    [<Pointer size={ICON_SIZE} />, 'tap'],
  focus:       [<Target size={ICON_SIZE} />, 'tap'],
  blur:        [<CircleDot size={ICON_SIZE} />, 'tap'],
  selectOption:[<ChevronDown size={ICON_SIZE} />, 'tap'],
  highlight:   [<Eye size={ICON_SIZE} />, 'tap'],
  waitForIdle: [<Clock size={ICON_SIZE} />, 'scroll'],
  'request.get':    [<Globe size={ICON_SIZE} />, 'api'],
  'request.post':   [<Send size={ICON_SIZE} />, 'api'],
  'request.put':    [<Send size={ICON_SIZE} />, 'api'],
  'request.patch':  [<Send size={ICON_SIZE} />, 'api'],
  'request.delete': [<X size={ICON_SIZE} />, 'api'],
  'request.head':   [<Globe size={ICON_SIZE} />, 'api'],
  'route':          [<MoveHorizontal size={ICON_SIZE} />, 'net'],
  'unroute':        [<MoveHorizontal size={ICON_SIZE} />, 'net'],
  'unrouteAll':     [<MoveHorizontal size={ICON_SIZE} />, 'net'],
  'route.fulfill':  [<Check size={ICON_SIZE} />, 'net'],
  'route.abort':    [<X size={ICON_SIZE} />, 'net'],
  'route.continue': [<ExternalLink size={ICON_SIZE} />, 'net'],
  'route.fetch':    [<MoveHorizontal size={ICON_SIZE} />, 'net'],
};

function getIcon(event: ActionTraceEvent | AssertionTraceEvent): [ComponentChildren, string] {
  if (event.type === 'assertion') {
    const passed = event.passed;
    return [passed ? <Check size={ICON_SIZE} /> : <X size={ICON_SIZE} />, passed ? 'assert' : 'assert failed'];
  }
  if (!event.success) {
    return [<X size={ICON_SIZE} />, 'failed'];
  }
  return ACTION_ICON_MAP[event.action] ?? [<CircleDot size={ICON_SIZE} />, 'tap'];
}

function getInFlightIcon(item: InFlightAction): [ComponentChildren, string] {
  if (item.kind === 'assertion') return [<Clock size={ICON_SIZE} />, ''];
  return ACTION_ICON_MAP[item.label] ?? [<Clock size={ICON_SIZE} />, ''];
}

export interface SelectorParts { fn: string; args: string[]; optionKey?: string }

export function parseSelectorParts(sel: string | undefined): SelectorParts | null {
  if (!sel) return null;
  try {
    const parsed = JSON.parse(sel);
    if (parsed.text) return { fn: 'getByText', args: [parsed.text] };
    if (parsed.textContains) return { fn: 'getByText', args: [parsed.textContains] };
    if (parsed.role) return { fn: 'getByRole', args: [parsed.role.role, ...(parsed.role.name ? [parsed.role.name] : [])] };
    if (parsed.contentDesc) return { fn: 'getByDescription', args: [parsed.contentDesc] };
    if (parsed.hint) return { fn: 'getByPlaceholder', args: [parsed.hint] };
    if (parsed.testId) return { fn: 'getByTestId', args: [parsed.testId] };
    if (parsed.label) return { fn: 'getByLabel', args: [parsed.label] };
    if (parsed.resourceId) return { fn: 'locator', args: [parsed.resourceId], optionKey: 'id' };
    if (parsed.className) return { fn: 'locator', args: [parsed.className], optionKey: 'className' };
    if (parsed.xpath) return { fn: 'locator', args: [parsed.xpath], optionKey: 'xpath' };
    return null;
  } catch {
    return null;
  }
}

function parseSelectorString(sel: string | undefined): string {
  const parts = parseSelectorParts(sel);
  if (!parts) return sel ?? '';
  if (parts.optionKey) return `${parts.fn}({ ${parts.optionKey}: "${parts.args[0]}" })`;
  return `${parts.fn}(${parts.args.map(a => `"${a}"`).join(', ')})`;
}

function SelectorDisplay({ sel }: { sel: string | undefined }) {
  const parts = parseSelectorParts(sel);
  if (!parts) {
    const plain = sel ?? '';
    return <span class="action-selector-text">{plain || '—'}</span>;
  }
  if (parts.optionKey) {
    return (
      <span class="action-selector-text">
        <span class="sel-fn">{parts.fn}</span>
        {'({ '}<span class="sel-fn">{parts.optionKey}</span>{': '}<span class="sel-val">"{parts.args[0]}"</span>{' })'}
      </span>
    );
  }
  return (
    <span class="action-selector-text">
      <span class="sel-fn">{parts.fn}</span>
      ({parts.args.map((a, i) => (
        <span key={i}>{i > 0 && ', '}<span class="sel-val">"{a}"</span></span>
      ))})
    </span>
  );
}

function getLabel(event: ActionTraceEvent | AssertionTraceEvent): string {
  if (event.type === 'assertion') return event.assertion;
  return event.action;
}

function getSelectorDisplay(event: ActionTraceEvent | AssertionTraceEvent): string {
  return parseSelectorString(event.selector);
}

function formatGroupName(name: string): string {
  switch (name) {
    case 'beforeAll Hooks': return 'BEFORE ALL';
    case 'beforeEach Hooks': return 'BEFORE EACH';
    case 'afterEach Hooks': return 'AFTER EACH';
    case 'afterAll Hooks': return 'AFTER ALL';
    case 'Test': return 'TEST BODY';
    default: return name.toUpperCase();
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function displayDuration(event: ActionTraceEvent | AssertionTraceEvent): number {
  return event.wallDuration ?? event.duration;
}

export function ActionsPanel({ events, actionEvents: _actionEvents, selectedIndex, pinnedIndex, onHover, onPin, metadata, showMetadata, inFlightAction, preflightMessage }: Props) {
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

  // Compute max duration across all actions for the heatmap
  const maxDur = items.reduce((max, item) => {
    if (item.kind !== 'action' || !('event' in item)) return max;
    return Math.max(max, displayDuration(item.event));
  }, 1);

  // Index assigned to the in-flight row — slots in right after the last
  // completed action so its actionIndex matches the global index that the
  // matching `addActionEvent` will eventually own. Auto-pin in main.tsx
  // sets pinnedIndex to that same value, so the in-flight row highlights.
  const inFlightItemIndex = actionIdx;
  const inFlightSelector = inFlightAction ? parseSelectorString(inFlightAction.selector) : '';
  const inFlightMatchesFilter = !filterLower || !inFlightAction
    || inFlightAction.label.toLowerCase().includes(filterLower)
    || inFlightSelector.toLowerCase().includes(filterLower);
  const showInFlight = !!inFlightAction && inFlightMatchesFilter;

  return (
    <div class="actions-panel">
      <div class="actions-header">
        <div class={`actions-header-tab${tab === 'actions' ? ' active' : ''}`} onClick={() => setTab('actions')}>Actions</div>
        {showMetadata && <div class={`actions-header-tab${tab === 'metadata' ? ' active' : ''}`} onClick={() => setTab('metadata')}>Metadata</div>}
        <span style={{ flex: 1 }} />
        {metadata.testStatus === 'passed' && (
          <span class="verdict-pill pass" style={{ marginRight: '10px' }}>
            <Check size={10} /><span>Passed</span><span class="verdict-dur">{formatDuration(metadata.testDuration)}</span>
          </span>
        )}
        {metadata.testStatus === 'failed' && (
          <span class="verdict-pill fail" style={{ marginRight: '10px' }}>
            <AlertTriangle size={10} /><span>Failed</span><span class="verdict-dur">{formatDuration(metadata.testDuration)}</span>
          </span>
        )}
      </div>

      {tab === 'actions' && (
        (items.length > 0 || showInFlight) ? (
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
                    <div key={`g-${i}`} class={`group-item${isLifecycle ? ' lifecycle' : ''} act-group`}>
                      {formatGroupName(item.event.name)}
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
                const isPassed = event.type === 'assertion' && event.passed;
                const [icon, iconClass] = getIcon(event);
                const shownDuration = displayDuration(event);

                return (
                  <div
                    key={`a-${item.actionIndex}`}
                    ref={isSelected ? selectedRef : undefined}
                    class={`action-item act${isSelected ? ' selected' : ''}${isPinned ? ' pinned' : ''}${isFailed ? ' failed' : ''}${isPassed ? ' passed' : ''}`}
                    style={{ '--dur-pct': `${(shownDuration / maxDur * 100)}%` }}
                    onMouseEnter={() => onHover(item.actionIndex)}
                    onMouseLeave={() => onHover(null)}
                    onClick={() => onPin(item.actionIndex)}
                  >
                    <span class={`action-icon ${iconClass}`}>{icon}</span>
                    <div class="action-details">
                      <span class="action-name">{label}</span>
                      <SelectorDisplay sel={event.selector} />
                    </div>
                    <span
                      class="action-duration act-dur"
                      title={event.wallDuration !== undefined && event.wallDuration !== event.duration
                        ? `wall time ${event.wallDuration}ms; action time ${event.duration}ms`
                        : undefined}
                    >
                      {shownDuration}ms
                    </span>
                  </div>
                );
              })}
              {showInFlight && inFlightAction && (() => {
                const isSelected = inFlightItemIndex === selectedIndex;
                const isPinned = inFlightItemIndex === pinnedIndex;
                const [icon, iconClass] = getInFlightIcon(inFlightAction);
                return (
                  <div
                    key={`a-inflight-${inFlightAction.actionIndex}`}
                    ref={isSelected ? selectedRef : undefined}
                    class={`action-item act in-progress${isSelected ? ' selected' : ''}${isPinned ? ' pinned' : ''}`}
                    onMouseEnter={() => onHover(inFlightItemIndex)}
                    onMouseLeave={() => onHover(null)}
                    onClick={() => onPin(inFlightItemIndex)}
                  >
                    <span class={`action-icon ${iconClass}`}>{icon}</span>
                    <div class="action-details">
                      <span class="action-name">{inFlightAction.label}</span>
                      <SelectorDisplay sel={inFlightAction.selector} />
                    </div>
                    <span class="action-spinner" aria-label="running" />
                  </div>
                );
              })()}
            </div>
          </>
        ) : preflightMessage ? (
          <div class="ui-empty-state preflight">
            <div class="action-spinner preflight-spinner" aria-label="running" />
            <div class="ui-empty-title">Running</div>
            <div class="ui-empty-hint">{preflightMessage}</div>
          </div>
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
            {metadata.device.osVersion && <>
              <span class="metadata-label">OS Version</span>
              <span class="metadata-value">{metadata.device.osVersion}</span>
            </>}
            <span class="metadata-label">Physical</span>
            <span class="metadata-value">{metadata.device.isEmulator ? 'No' : 'Yes'}</span>
            <span class="metadata-label">Actions</span>
            <span class="metadata-value">{metadata.actionCount}</span>
            <span class="metadata-label">Screenshots</span>
            <span class="metadata-value">{metadata.screenshotCount}</span>
            <span class="metadata-label">Tapsmith</span>
            <span class="metadata-value">v{metadata.tapsmithVersion}</span>
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
