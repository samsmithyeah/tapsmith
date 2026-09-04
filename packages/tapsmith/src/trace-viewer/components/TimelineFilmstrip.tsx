import { useRef, useEffect } from 'preact/hooks';
import { LoaderCircle, Play } from 'lucide-preact';
import type { ActionTraceEvent, AssertionTraceEvent, TraceMetadata } from '../../trace/types.js';
import type { ContainerSummary } from '../types.js';
import { findNearestScreenshot } from '../../ui-mode/hooks/use-trace-data.js';

// ─── Injected Styles ───

const TIMELINE_STYLES = `
  .timeline-item { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
  .timeline-item .timeline-time-label { position: static; transform: none; font-size: 9px; color: #555; white-space: nowrap; }
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.textContent = TIMELINE_STYLES;
  document.head.appendChild(el);
}

// ─── Types ───

interface Props {
  events: (ActionTraceEvent | AssertionTraceEvent)[]
  screenshots: Map<string, string>
  metadata: TraceMetadata
  selectedIndex: number
  onSelect: (index: number) => void
  hasTrace?: boolean
  onRunTest?: () => void
  isTestPending?: boolean
  nodeType?: 'test' | 'suite' | 'file' | 'project'
  containerSummary?: ContainerSummary
  onRunContainer?: () => void
}

function formatRelativeTime(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${abs}ms`;
  const seconds = abs / 1000;
  if (seconds < 10) return `${sign}${seconds.toFixed(1)}s`;
  return `${sign}${Math.round(seconds)}s`;
}

export function TimelineFilmstrip({ events, screenshots, metadata, selectedIndex, onSelect, hasTrace, onRunTest, isTestPending, nodeType, containerSummary, onRunContainer }: Props) {
  injectStyles();

  const selectedRef = useRef<HTMLElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedIndex]);

  const statusClass = metadata.testStatus === 'passed' ? 'passed'
    : metadata.testStatus === 'failed' ? 'failed'
    : metadata.testStatus === 'running' ? 'running'
    : 'idle';
  const statusIcon = metadata.testStatus === 'passed' ? '\u2713'
    : metadata.testStatus === 'failed' ? '\u2717'
    : '\u25CB';

  // \u2500\u2500\u2500 Nothing selected \u2500\u2500\u2500

  if (!nodeType) {
    return (
      <div class="film-empty" data-state="idle">
        <span class="film-empty-dot" />
        <span class="film-empty-text">No test selected</span>
      </div>
    );
  }

  // \u2500\u2500\u2500 Container selected (suite / file / project) \u2500\u2500\u2500

  if (nodeType !== 'test' && containerSummary) {
    const { totalTests, running } = containerSummary;
    const isContainerPending = isTestPending || running > 0;
    const parts: string[] = [];
    if (containerSummary.passed > 0) parts.push(`${containerSummary.passed} passed`);
    if (containerSummary.failed > 0) parts.push(`${containerSummary.failed} failed`);
    if (containerSummary.running > 0) parts.push(`${containerSummary.running} running`);
    if (containerSummary.idle > 0) parts.push(`${containerSummary.idle} not run`);
    const label = `${containerSummary.name} \u00B7 ${totalTests} ${totalTests === 1 ? 'test' : 'tests'}${parts.length ? ` \u00B7 ${parts.join(', ')}` : ''}`;
    return (
      <div class="film-empty" data-state={running > 0 ? 'running' : 'idle'}>
        {running > 0
          ? <LoaderCircle size={13} class="film-empty-icon" style={{ animation: 'spin 1.1s linear infinite' }} />
          : <span class="film-empty-dot" />}
        <span class="film-empty-text">{label}</span>
        {onRunContainer && (
          <button class="film-empty-cta" onClick={onRunContainer} disabled={isContainerPending}>
            {isContainerPending
              ? <><LoaderCircle size={10} style={{ animation: 'spin 1.1s linear infinite' }} /> Running…</>
              : <><Play size={10} /> Run {totalTests} {totalTests === 1 ? 'test' : 'tests'}</>}
          </button>
        )}
      </div>
    );
  }

  // \u2500\u2500\u2500 Test selected, no trace yet \u2500\u2500\u2500

  if (hasTrace === false && metadata.testStatus !== 'passed' && metadata.testStatus !== 'failed') {
    const state = metadata.testStatus === 'running' ? 'running'
      : metadata.testStatus === 'skipped' ? 'skipped'
      : 'idle';
    return (
      <div class="film-empty" data-state={state}>
        {state === 'running'
          ? <LoaderCircle size={13} class="film-empty-icon" style={{ animation: 'spin 1.1s linear infinite' }} />
          : <span class="film-empty-dot" />}
        <span class="film-empty-text">
          {state === 'running' ? 'Running test\u2026'
            : state === 'skipped' ? 'Skipped'
            : 'Not run yet'}
        </span>
        {state !== 'running' && state !== 'skipped' && onRunTest && (
          <button class="film-empty-cta" onClick={onRunTest} disabled={isTestPending}>
            {isTestPending
              ? <><LoaderCircle size={10} style={{ animation: 'spin 1.1s linear infinite' }} /> Running…</>
              : <><Play size={10} /> Run this test</>}
          </button>
        )}
      </div>
    );
  }

  // Anchor the strip at the earliest thing in it, not the test's start: the
  // runner replays inherited scope setup (the file-entry app reset, beforeAll
  // hooks) into every test's trace, and for every test after the first that
  // setup ran before the test began. Measured from the test start those
  // frames read as negative offsets, which look like a clock error.
  // Labels are placed by `timestamp`, so it must count towards the anchor: a
  // synthesized `startTime` is clamped up to the test start and would hide a
  // completion that predates it.
  const earliestEvent = events.reduce<number | undefined>((min, e) => {
    const t = Math.min(e.timestamp, e.startTime ?? e.timestamp);
    return min === undefined || t < min ? t : min;
  }, undefined);
  const firstTimestamp = metadata.startTime > 0 && earliestEvent !== undefined
    ? Math.min(metadata.startTime, earliestEvent)
    : metadata.startTime > 0
      ? metadata.startTime
      : earliestEvent ?? 0;
  const hasTestName = !!metadata.testName;
  const hasDeviceSerial = !!metadata.device.serial;
  const fileName = metadata.testFile ? metadata.testFile.split('/').pop() : undefined;
  const breadcrumb = [metadata.project, fileName].filter(Boolean).join(' \u203a ');

  return (
    <div class="timeline">
      <div class="timeline-meta" data-testid="timeline-meta">
        {hasTestName
          ? <span class={`test-status ${statusClass}`}>{statusIcon} {breadcrumb ? <>{breadcrumb}{' \u203a '}</> : null}{metadata.testName}</span>
          : <span class="test-status">No test selected</span>}
        {hasTestName && metadata.testStatus !== 'running' && metadata.testStatus !== 'idle' && (
          <span>{' \u00b7 '}{metadata.testDuration}ms</span>
        )}
        {hasDeviceSerial && <>{' \u00b7 '}{metadata.device.model || metadata.device.serial}</>}
      </div>
      <div class="timeline-inner">
        {events.map((event, i) => {
          const pad = String(event.actionIndex).padStart(3, '0');
          const afterKey = `screenshots/action-${pad}-after.png`;
          const beforeKey = `screenshots/action-${pad}-before.png`;
          const url = screenshots.get(afterKey) ?? screenshots.get(beforeKey)
            ?? findNearestScreenshot(screenshots, event.actionIndex);
          const isSelected = i === selectedIndex;
          const isFailed = event.type === 'action' ? !event.success : !event.passed;
          const relativeTime = formatRelativeTime(event.timestamp - firstTimestamp);

          return (
            <div key={i} class={`timeline-item film-frame${isFailed ? ' failed' : ''}${isSelected ? ' active' : ''}`} data-testid="film-frame">
              {url ? (
                <img
                  ref={isSelected ? selectedRef as preact.RefObject<HTMLImageElement> : undefined}
                  class={`timeline-thumb film-thumb${isSelected ? ' selected' : ''}${isFailed ? ' failed' : ''}`}
                  src={url}
                  onClick={() => onSelect(i)}
                />
              ) : (
                <div
                  ref={isSelected ? selectedRef as preact.RefObject<HTMLDivElement> : undefined}
                  class={`timeline-placeholder film-thumb${isSelected ? ' selected' : ''}`}
                  onClick={() => onSelect(i)}
                >
                  {i + 1}
                </div>
              )}
              <div class="timeline-time-label film-label" data-testid="film-label">{relativeTime}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
