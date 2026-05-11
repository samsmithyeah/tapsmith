import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { Focus, ExternalLink, Download, Camera, LoaderCircle, CircleDot, Play, Layers, ListTree } from 'lucide-preact';
import type { ActionTraceEvent, AssertionTraceEvent } from '../../trace/types.js';
import type { ContainerSummary } from '../../ui-mode/main.js';

// ─── Injected Styles ───

const SCREENSHOT_STYLES = `
  .screenshot-zoom-label { margin-left: auto; padding: 6px 12px; color: var(--color-text-muted); font-size: 11px; }
  .screenshot-image-wrapper { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .screenshot-image-wrapper > img,
  .screenshot-image-wrapper .dm-frame:not(.dm-skin-ios):not(.dm-skin-android) > img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; }
  .screenshot-image-wrapper .dm-skin-ios > img,
  .screenshot-image-wrapper .dm-skin-android > img { max-width: 100%; object-fit: contain; border-radius: calc(var(--bezel-radius) - var(--bezel)); }
  .bounds-overlay { position: absolute; z-index: 4; pointer-events: none; border-radius: 8px; overflow: hidden; }
  .bounds-rect { position: absolute; border: 2px solid var(--color-accent); background: rgba(79,193,255,0.15); border-radius: 2px; }
  .bounds-rect-hierarchy { position: absolute; border: 2px solid var(--color-success); background: rgba(78,201,176,0.15); border-radius: 2px; }
  .bounds-rect-selector { position: absolute; border: 2px solid #c084fc; background: rgba(192,132,252,0.18); border-radius: 2px; }
  .bounds-point { position: absolute; width: 16px; height: 16px; margin-left: -8px; margin-top: -8px; border-radius: 50%; background: rgba(255,80,80,0.5); border: 2px solid #ff5050; box-shadow: 0 0 8px rgba(255,80,80,0.4); }
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.textContent = SCREENSHOT_STYLES;
  document.head.appendChild(el);
}

// ─── Types ───

interface Props {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  screenshots: Map<string, string>
  highlightBounds?: { left: number; top: number; right: number; bottom: number } | null
  selectorHighlights?: { left: number; top: number; right: number; bottom: number }[]
  hoverBounds?: { left: number; top: number; right: number; bottom: number } | null
  onScreenshotClick?: (point: { x: number; y: number }) => void
  onScreenshotHover?: (point: { x: number; y: number } | null) => void
  pickMode?: boolean
  onPickModeToggle?: () => void
  /** Device pixel ratio — bounds are in logical points, screenshots in pixels. */
  devicePixelRatio?: number
  testName?: string
  testStatus?: string
  onDownloadTrace?: () => void
  onDownloadVideo?: () => void
  hasTrace?: boolean
  onRunTest?: () => void
  isTestPending?: boolean
  platform?: 'android' | 'ios'
  nodeType?: 'test' | 'suite' | 'file' | 'project'
  containerSummary?: ContainerSummary
  onRunContainer?: () => void
}

type ScreenshotTab = 'before' | 'after' | 'action'

interface NaturalSize {
  width: number
  height: number
}

interface RenderedSize {
  width: number
  height: number
  left: number
  top: number
}

export function ScreenshotPanel({ event, screenshots, highlightBounds, selectorHighlights, hoverBounds, onScreenshotClick, onScreenshotHover, pickMode, onPickModeToggle, devicePixelRatio, testName, testStatus, onDownloadTrace, onDownloadVideo, hasTrace, onRunTest, isTestPending, platform, nodeType, containerSummary, onRunContainer }: Props) {
  injectStyles();

  const [tab, setTab] = useState<ScreenshotTab>('action');
  const [scale, setScale] = useState(1);
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null);
  const [renderedSize, setRenderedSize] = useState<RenderedSize | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const updateRenderedSize = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;

    const wrapper = wrapperRef.current;
    const imgRect = img.getBoundingClientRect();
    const wrapperRect = wrapper?.getBoundingClientRect();
    setRenderedSize({
      width: img.clientWidth,
      height: img.clientHeight,
      left: wrapperRect ? imgRect.left - wrapperRect.left : 0,
      top: wrapperRect ? imgRect.top - wrapperRect.top : 0,
    });
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const update = () => {
      setViewportSize({ width: wrapper.clientWidth, height: wrapper.clientHeight });
      updateRenderedSize();
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [event, tab, updateRenderedSize]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    updateRenderedSize();
    const ro = new ResizeObserver(updateRenderedSize);
    ro.observe(img);
    return () => ro.disconnect();
  }, [event, tab, updateRenderedSize]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    setScale(prev => {
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      return Math.max(0.5, Math.min(5, prev + delta));
    });
  }, []);

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (img) {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      updateRenderedSize();
    }
    const wrapper = wrapperRef.current;
    if (wrapper) {
      setViewportSize({ width: wrapper.clientWidth, height: wrapper.clientHeight });
    }
  }, [updateRenderedSize]);

  const toNaturalCoords = useCallback((e: MouseEvent): { x: number; y: number } | null => {
    if (!imgRef.current || !naturalSize) return null;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    return {
      x: Math.round(clickX * (naturalSize.width / rect.width)),
      y: Math.round(clickY * (naturalSize.height / rect.height)),
    };
  }, [naturalSize]);

  const handleImageClick = useCallback((e: MouseEvent) => {
    if (!onScreenshotClick) return;
    const point = toNaturalCoords(e);
    if (point) onScreenshotClick(point);
  }, [onScreenshotClick, toNaturalCoords]);

  const handleImageMouseMove = useCallback((e: MouseEvent) => {
    if (!onScreenshotHover) return;
    const point = toNaturalCoords(e);
    onScreenshotHover(point);
  }, [onScreenshotHover, toNaturalCoords]);

  const handleImageMouseLeave = useCallback(() => {
    onScreenshotHover?.(null);
  }, [onScreenshotHover]);

  // ─── Nothing selected ───

  if (!nodeType) {
    return (
      <div class="screenshot-panel">
        <div class="screenshot-container viewer-body has-grid">
          <div class="viewer-empty">
            <div class="viewer-empty-icon"><ListTree size={20} /></div>
            <div class="viewer-empty-title">No test selected</div>
            <div class="viewer-empty-sub">Select a test from the sidebar to view its trace.</div>
          </div>
        </div>
      </div>
    )
  }

  // ─── Container selected (suite / file / project) ───

  if (nodeType !== 'test' && containerSummary) {
    const { totalTests, passed, failed, running, skipped, idle } = containerSummary
    const isContainerPending = isTestPending || running > 0
    const parts: preact.JSX.Element[] = []
    if (passed > 0) parts.push(<span class="summary-stat passed"><span class="summary-dot" />{passed} passed</span>)
    if (failed > 0) parts.push(<span class="summary-stat failed"><span class="summary-dot" />{failed} failed</span>)
    if (running > 0) parts.push(<span class="summary-stat running"><span class="summary-dot" />{running} running</span>)
    if (skipped > 0) parts.push(<span class="summary-stat skipped"><span class="summary-dot" />{skipped} skipped</span>)
    if (idle > 0) parts.push(<span class="summary-stat idle"><span class="summary-dot" />{idle} not run</span>)
    return (
      <div class="screenshot-panel">
        <div class="screenshot-container viewer-body has-grid">
          <div class="viewer-empty">
            <div class="viewer-empty-icon"><Layers size={20} /></div>
            <div class="viewer-empty-title">{containerSummary.name}</div>
            <div class="viewer-empty-sub">{totalTests} {totalTests === 1 ? 'test' : 'tests'} in this {nodeType === 'suite' ? 'suite' : nodeType}</div>
            {parts.length > 0 && <div class="viewer-empty-summary">{parts}</div>}
            {onRunContainer && (
              <button class="viewer-empty-cta" onClick={onRunContainer} disabled={isContainerPending}>
                {isContainerPending
                  ? <><LoaderCircle size={12} style={{ animation: 'spin 1.1s linear infinite' }} /> Running…</>
                  : <><Play size={12} /> Run {totalTests} {totalTests === 1 ? 'test' : 'tests'}</>}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ─── Test selected, no trace yet ───

  if (hasTrace === false && testStatus !== 'passed' && testStatus !== 'failed') {
    const state = testStatus === 'running' ? 'running'
      : testStatus === 'skipped' ? 'skipped'
      : 'idle';
    return (
      <div class="screenshot-panel">
        <div class="viewer-head">
          <div class="viewer-head-meta">
            {testStatus && (
              <span class={`te-status-icon ${testStatus === 'passed' ? 'passed' : testStatus === 'failed' ? 'failed' : ''}`}>
                {testStatus === 'passed' ? '✓' : testStatus === 'failed' ? '✗' : '○'}
              </span>
            )}
            {testName && <span class="viewer-head-title">{testName}</span>}
          </div>
          <div class="viewer-head-actions">
            {onPickModeToggle && (
              <button class="viewer-pick-btn" disabled title="Pick element">
                <Focus size={12} /> Pick
              </button>
            )}
          </div>
        </div>
        <div class="screenshot-container viewer-body has-grid">
          <div class="viewer-empty">
            <div class="viewer-empty-icon">
              {state === 'running'
                ? <LoaderCircle size={20} style={{ animation: 'spin 1.1s linear infinite' }} />
                : state === 'skipped'
                  ? <CircleDot size={20} />
                  : <Camera size={20} />}
            </div>
            <div class="viewer-empty-title">
              {state === 'running' ? 'Running test…'
                : state === 'skipped' ? 'Test skipped'
                : 'No screenshot'}
            </div>
            <div class="viewer-empty-sub">
              {state === 'running' ? 'Screenshots will appear as actions are captured.'
                : state === 'skipped' ? 'This test was skipped on the last run.'
                : 'Run this test to capture a trace.'}
            </div>
            {state === 'idle' && onRunTest && (
              <button class="viewer-empty-cta" onClick={onRunTest} disabled={isTestPending}>
                {isTestPending
                  ? <><LoaderCircle size={12} style={{ animation: 'spin 1.1s linear infinite' }} /> Running…</>
                  : <><Play size={12} /> Run this test</>}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div class="screenshot-panel">
        <div class="screenshot-container">
          <div class="screenshot-empty">Select an action to view screenshots</div>
        </div>
      </div>
    );
  }

  const pad = String(event.actionIndex).padStart(3, '0');
  const beforeUrl = screenshots.get(`screenshots/action-${pad}-before.png`);
  // "After" = the next action's before-screenshot (screen state after this action).
  // This avoids capturing 2 screenshots per action through the agent.
  const nextPad = String(event.actionIndex + 1).padStart(3, '0');
  const afterUrl = screenshots.get(`screenshots/action-${nextPad}-before.png`)
    ?? screenshots.get(`screenshots/action-${pad}-after.png`); // fallback for legacy traces

  const hasBefore = !!beforeUrl;
  const hasAfter = !!afterUrl;

  // The "Action" tab shows the screenshot that best represents the moment
  // the action happened. For taps/swipes that's the BEFORE screenshot (you
  // want to see where the touch landed). For assertions it's the AFTER
  // screenshot — the assertion resolved when the expected state appeared,
  // so the "before" state (often still loading) is the wrong frame to show.
  const isAssertion = event.type === 'assertion';
  let currentUrl: string | undefined;
  if (tab === 'before') currentUrl = beforeUrl;
  else if (tab === 'after') currentUrl = afterUrl ?? beforeUrl;
  else currentUrl = isAssertion ? (afterUrl ?? beforeUrl) : beforeUrl;

  // If selected tab has no screenshot, fall back
  if (!currentUrl) {
    currentUrl = afterUrl ?? beforeUrl;
  }

  const frameStyle = (() => {
    if (!platform || !naturalSize || !viewportSize) return undefined;

    const screenshotAspectRatio = naturalSize.width / naturalSize.height;
    const maxFrameHeight = Math.max(0, viewportSize.height);
    if (!Number.isFinite(screenshotAspectRatio) || screenshotAspectRatio <= 0 || maxFrameHeight <= 0) {
      return undefined;
    }

    const metrics = platform === 'ios'
      ? { inlineInsetRatio: 0.06, blockInsetRatio: 0.06 }
      : { inlineInsetRatio: 0.04, blockInsetRatio: 0.045 };
    const screenWidthRatio = 1 - metrics.inlineInsetRatio;
    const frameHeightRatio = screenWidthRatio / screenshotAspectRatio + metrics.blockInsetRatio;
    const frameWidth = Math.min(viewportSize.width, maxFrameHeight / frameHeightRatio);
    const screenHeight = frameWidth * screenWidthRatio / screenshotAspectRatio;

    return {
      width: `${frameWidth.toFixed(2)}px`,
      '--screen-max-height': `${screenHeight.toFixed(2)}px`,
    };
  })();

  const bounds = (event.type === 'action' || event.type === 'assertion') ? event.bounds : undefined;
  const point = event.type === 'action' ? event.point : undefined;
  // Show bounds + point overlay only on the "action" tab
  const showOverlay = tab === 'action' && (!!bounds || !!point);

  return (
    <div class="screenshot-panel">
      <div class="viewer-head">
        <div class="viewer-head-meta">
          {testStatus && (
            <span class={`te-status-icon ${testStatus === 'passed' ? 'passed' : testStatus === 'failed' ? 'failed' : ''}`}>
              {testStatus === 'passed' ? '✓' : testStatus === 'failed' ? '✗' : '○'}
            </span>
          )}
          {testName && <span class="viewer-head-title">{testName}</span>}
        </div>
        <div class="viewer-head-actions">
          {onPickModeToggle && (
            <button class={`viewer-pick-btn ${pickMode ? 'active' : ''}`} onClick={onPickModeToggle} title={pickMode ? 'Exit pick mode' : 'Pick element'}>
              <Focus size={12} /> {pickMode ? 'Picking…' : 'Pick'}
            </button>
          )}
          {onDownloadTrace && (
            <button class="viewer-download-btn" onClick={onDownloadTrace} title="Download trace ZIP">
              <ExternalLink size={12} /> Trace
            </button>
          )}
          {onDownloadVideo && (
            <button class="viewer-download-btn" onClick={onDownloadVideo} title="Download video">
              <Download size={12} /> Video
            </button>
          )}
          {scale !== 1 && (
            <div class="screenshot-zoom-label">{Math.round(scale * 100)}%</div>
          )}
        </div>
      </div>
      <div class="screenshot-container viewer-body has-grid" onWheel={handleWheel} style={{ position: 'relative' }}>
        {(hasBefore && hasAfter) && (
          <div class="screenshot-tab-float">
            <div class={`screenshot-tab${tab === 'action' ? ' active' : ''}`} onClick={() => setTab('action')}>Action</div>
            <div class={`screenshot-tab${tab === 'before' ? ' active' : ''}`} onClick={() => setTab('before')}>Before</div>
            <div class={`screenshot-tab${tab === 'after' ? ' active' : ''}`} onClick={() => setTab('after')}>After</div>
          </div>
        )}
        {currentUrl ? (
          <div ref={wrapperRef} class="screenshot-image-wrapper" style={scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'center center' } : undefined}>
            {platform ? (
              <div class="screenshot-device-frame" style={frameStyle}>
                <div class={`dm-frame dm-skin-${platform}`}>
                  <img
                    ref={imgRef}
                    src={currentUrl}
                    alt={`Screenshot ${tab}`}
                    onLoad={handleImageLoad}
                    onClick={handleImageClick}
                    onMouseMove={handleImageMouseMove}
                    onMouseLeave={handleImageMouseLeave}
                    style={onScreenshotClick ? { cursor: 'crosshair' } : undefined}
                  />
                </div>
              </div>
            ) : (
              <img
                ref={imgRef}
                src={currentUrl}
                alt={`Screenshot ${tab}`}
                onLoad={handleImageLoad}
                onClick={handleImageClick}
                onMouseMove={handleImageMouseMove}
                onMouseLeave={handleImageMouseLeave}
                style={onScreenshotClick ? { cursor: 'crosshair' } : undefined}
              />
            )}
            {showOverlay && naturalSize && renderedSize && (
              <BoundsOverlay
                bounds={bounds}
                point={point}
                naturalSize={naturalSize}
                renderedWidth={renderedSize.width}
                renderedHeight={renderedSize.height}
                renderedLeft={renderedSize.left}
                renderedTop={renderedSize.top}
                devicePixelRatio={devicePixelRatio}
              />
            )}
            {highlightBounds && naturalSize && renderedSize && (
              <HierarchyHighlightOverlay
                bounds={highlightBounds}
                naturalSize={naturalSize}
                renderedWidth={renderedSize.width}
                renderedHeight={renderedSize.height}
                renderedLeft={renderedSize.left}
                renderedTop={renderedSize.top}
                devicePixelRatio={devicePixelRatio}
              />
            )}
            {hoverBounds && naturalSize && renderedSize && (
              <HierarchyHighlightOverlay
                bounds={hoverBounds}
                naturalSize={naturalSize}
                renderedWidth={renderedSize.width}
                renderedHeight={renderedSize.height}
                renderedLeft={renderedSize.left}
                renderedTop={renderedSize.top}
                devicePixelRatio={devicePixelRatio}
              />
            )}
            {selectorHighlights && selectorHighlights.length > 0 && naturalSize && renderedSize && (
              <SelectorHighlightOverlay
                boundsList={selectorHighlights}
                naturalSize={naturalSize}
                renderedWidth={renderedSize.width}
                renderedHeight={renderedSize.height}
                renderedLeft={renderedSize.left}
                renderedTop={renderedSize.top}
                devicePixelRatio={devicePixelRatio}
              />
            )}
          </div>
        ) : (
          <div class="screenshot-empty">No screenshot available for this action</div>
        )}
      </div>
    </div>
  );
}

// ─── Bounds Overlay ───

interface BoundsOverlayProps {
  bounds?: { left: number; top: number; right: number; bottom: number }
  point?: { x: number; y: number }
  naturalSize: NaturalSize
  renderedWidth: number
  renderedHeight: number
  renderedLeft: number
  renderedTop: number
  devicePixelRatio?: number
}

function BoundsOverlay({ bounds, point, naturalSize, renderedWidth, renderedHeight, renderedLeft, renderedTop, devicePixelRatio }: BoundsOverlayProps) {
  if (!bounds && !point) return null;

  // Bounds are in logical points; screenshots are in pixels.
  // Multiply by devicePixelRatio to convert points → pixels before scaling.
  const dpr = devicePixelRatio ?? 1;
  const scaleX = renderedWidth / naturalSize.width * dpr;
  const scaleY = renderedHeight / naturalSize.height * dpr;

  return (
    <div
      class="bounds-overlay"
      style={{
        width: `${renderedWidth}px`,
        height: `${renderedHeight}px`,
        left: `${renderedLeft}px`,
        top: `${renderedTop}px`,
      }}
    >
      {bounds && (
        <div
          class="bounds-rect"
          style={{
            left: `${bounds.left * scaleX}px`,
            top: `${bounds.top * scaleY}px`,
            width: `${(bounds.right - bounds.left) * scaleX}px`,
            height: `${(bounds.bottom - bounds.top) * scaleY}px`,
          }}
        />
      )}
      {point && (
        <div
          class="bounds-point"
          style={{
            left: `${point.x * scaleX}px`,
            top: `${point.y * scaleY}px`,
          }}
        />
      )}
    </div>
  );
}

// ─── Hierarchy Highlight Overlay ───

interface HierarchyHighlightProps {
  bounds: { left: number; top: number; right: number; bottom: number }
  naturalSize: NaturalSize
  renderedWidth: number
  renderedHeight: number
  renderedLeft: number
  renderedTop: number
  devicePixelRatio?: number
}

function HierarchyHighlightOverlay({ bounds, naturalSize, renderedWidth, renderedHeight, renderedLeft, renderedTop, devicePixelRatio }: HierarchyHighlightProps) {
  const dpr = devicePixelRatio ?? 1;
  const scaleX = renderedWidth / naturalSize.width * dpr;
  const scaleY = renderedHeight / naturalSize.height * dpr;

  return (
    <div
      class="bounds-overlay"
      style={{
        width: `${renderedWidth}px`,
        height: `${renderedHeight}px`,
        left: `${renderedLeft}px`,
        top: `${renderedTop}px`,
      }}
    >
      <div
        class="bounds-rect-hierarchy"
        style={{
          left: `${bounds.left * scaleX}px`,
          top: `${bounds.top * scaleY}px`,
          width: `${(bounds.right - bounds.left) * scaleX}px`,
          height: `${(bounds.bottom - bounds.top) * scaleY}px`,
        }}
      />
    </div>
  );
}

// ─── Selector Highlight Overlay (multiple bounds) ───

interface SelectorHighlightProps {
  boundsList: { left: number; top: number; right: number; bottom: number }[]
  naturalSize: NaturalSize
  renderedWidth: number
  renderedHeight: number
  renderedLeft: number
  renderedTop: number
  devicePixelRatio?: number
}

function SelectorHighlightOverlay({ boundsList, naturalSize, renderedWidth, renderedHeight, renderedLeft, renderedTop, devicePixelRatio }: SelectorHighlightProps) {
  const dpr = devicePixelRatio ?? 1;
  const scaleX = renderedWidth / naturalSize.width * dpr;
  const scaleY = renderedHeight / naturalSize.height * dpr;

  return (
    <div
      class="bounds-overlay"
      style={{
        width: `${renderedWidth}px`,
        height: `${renderedHeight}px`,
        left: `${renderedLeft}px`,
        top: `${renderedTop}px`,
      }}
    >
      {boundsList.map((bounds, i) => (
        <div
          key={i}
          class="bounds-rect-selector"
          style={{
            left: `${bounds.left * scaleX}px`,
            top: `${bounds.top * scaleY}px`,
            width: `${(bounds.right - bounds.left) * scaleX}px`,
            height: `${(bounds.bottom - bounds.top) * scaleY}px`,
          }}
        />
      ))}
    </div>
  );
}
