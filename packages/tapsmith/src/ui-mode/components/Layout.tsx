/**
 * Playwright-inspired layout for UI mode.
 *
 * Left: Test Explorer
 * Content area:
 *   Top strip: Timeline filmstrip
 *   Middle: Actions panel (left) + Screenshot panel (right)
 *   Bottom: Detail tabs (Source, Call, Log, Console, Network, Hierarchy, Errors)
 * Right: Device pane (always-visible live device mirror)
 */

import { useCallback } from 'preact/hooks';
import { usePersistedJSON } from '../hooks/use-persisted-state.js';
import type { ComponentChildren } from 'preact';

interface LayoutProps {
  topBar: ComponentChildren
  testExplorer: ComponentChildren
  filmstrip: ComponentChildren
  actionsPanel: ComponentChildren
  screenshotPanel: ComponentChildren
  detailTabs: ComponentChildren
  devicePane?: ComponentChildren
  mcpPanel?: ComponentChildren
  layout?: 'three' | 'device-first' | 'focus'
  filmstripCollapsed?: boolean
}

export function Layout({ topBar, testExplorer, filmstrip, actionsPanel, screenshotPanel, detailTabs, devicePane, mcpPanel, layout = 'three', filmstripCollapsed }: LayoutProps) {
  const [explorerWidth, setExplorerWidth] = usePersistedJSON('tapsmith-explorer-width', 280);
  const [actionsWidth, setActionsWidth] = usePersistedJSON('tapsmith-actions-width', 380);
  const [filmstripHeight, setFilmstripHeight] = usePersistedJSON('tapsmith-filmstrip-height', 130);
  const [detailHeight, setDetailHeight] = usePersistedJSON('tapsmith-detail-height', 250);
  const [deviceWidth, setDeviceWidth] = usePersistedJSON('tapsmith-device-width', 300);

  const makeColResize = useCallback((
    getter: () => number,
    setter: (v: number) => void,
    min: number,
    max: number,
    invert?: boolean,
  ) => (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = getter();

    const onMove = (ev: MouseEvent) => {
      const delta = invert ? (startX - ev.clientX) : (ev.clientX - startX);
      setter(Math.max(min, Math.min(max, startWidth + delta)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const handleExplorerResize = useCallback(
    (e: MouseEvent) => {
      const max = Math.max(270, window.innerWidth - 300);
      makeColResize(() => explorerWidth, setExplorerWidth, 270, max)(e);
    },
    [explorerWidth, makeColResize],
  );

  const handleActionsResize = useCallback(
    (e: MouseEvent) => makeColResize(() => actionsWidth, setActionsWidth, 250, 600)(e),
    [actionsWidth, makeColResize],
  );

  const handleDeviceResize = useCallback(
    (e: MouseEvent) => makeColResize(() => deviceWidth, setDeviceWidth, 200, Infinity, true)(e),
    [deviceWidth, makeColResize],
  );

  const handleDetailResize = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = detailHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      const max = Math.max(100, window.innerHeight - 100);
      setDetailHeight(Math.max(100, Math.min(max, startHeight + delta)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [detailHeight]);

  const handleFilmstripResize = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = filmstripHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      setFilmstripHeight(Math.max(60, Math.min(300, startHeight + delta)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [filmstripHeight]);

  const showDevice = layout !== 'focus' && devicePane;

  return (
    <div class="ui-layout">
      <div class="ui-topbar">{topBar}</div>
      <div class="ui-body">
        {/* Left: Test Explorer */}
        <div class="ui-explorer" style={{ width: `${explorerWidth}px`, minWidth: `${explorerWidth}px` }}>
          {testExplorer}
        </div>
        <div class="ui-resize-handle ui-resize-col" onMouseDown={handleExplorerResize} />

        {/* Content area */}
        <div class="ui-content">
          {/* Timeline filmstrip */}
          <div class="ui-filmstrip" style={filmstripCollapsed
            ? { height: '38px', minHeight: '38px' }
            : { height: `${filmstripHeight}px`, minHeight: `${filmstripHeight}px`, '--filmstrip-h': `${filmstripHeight}px` } as Record<string, string>}>{filmstrip}</div>
          {!filmstripCollapsed && <div class="ui-resize-handle ui-resize-row" onMouseDown={handleFilmstripResize} />}

          {/* Middle: Actions + Screenshot */}
          <div class="ui-middle">
            <div class="ui-actions" style={{ width: `${actionsWidth}px`, minWidth: `${actionsWidth}px` }}>
              {actionsPanel}
            </div>
            <div class="ui-resize-handle ui-resize-col" onMouseDown={handleActionsResize} />
            <div class="ui-screenshot">
              {screenshotPanel}
            </div>
          </div>

          {/* Detail tabs */}
          <div class="ui-resize-handle ui-resize-row" onMouseDown={handleDetailResize} />
          <div class="ui-detail" style={{ height: `${detailHeight}px`, minHeight: `${detailHeight}px` }}>
            {detailTabs}
          </div>
        </div>

        {/* Right: Device pane + optional MCP panel */}
        {showDevice && (
          <>
            <div class="ui-resize-handle ui-resize-col" onMouseDown={handleDeviceResize} />
            <div class="ui-right-column" style={{ width: `${deviceWidth}px`, minWidth: `${deviceWidth}px` }}>
              {mcpPanel && (
                <div class="ui-mcp-pane">
                  {mcpPanel}
                </div>
              )}
              <div class="ui-device-pane">
                {devicePane}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
