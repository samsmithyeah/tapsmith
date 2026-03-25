/**
 * Playwright-inspired layout for UI mode.
 *
 * Left: Test Explorer
 * Content area:
 *   Top strip: Timeline filmstrip
 *   Middle: Actions panel (left) + Screenshot/Device panel (right)
 *   Bottom: Detail tabs (Source, Call, Log, Console, Network, Hierarchy, Errors)
 */

import { useState, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface LayoutProps {
  topBar: ComponentChildren
  testExplorer: ComponentChildren
  filmstrip: ComponentChildren
  actionsPanel: ComponentChildren
  screenshotPanel: ComponentChildren
  detailTabs: ComponentChildren
}

export function Layout({ topBar, testExplorer, filmstrip, actionsPanel, screenshotPanel, detailTabs }: LayoutProps) {
  const [explorerWidth, setExplorerWidth] = useState(260);
  const [actionsWidth, setActionsWidth] = useState(380);
  const [detailHeight, setDetailHeight] = useState(250);

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
    (e: MouseEvent) => makeColResize(() => explorerWidth, setExplorerWidth, 180, 450)(e),
    [explorerWidth, makeColResize],
  );

  const handleActionsResize = useCallback(
    (e: MouseEvent) => makeColResize(() => actionsWidth, setActionsWidth, 250, 600)(e),
    [actionsWidth, makeColResize],
  );

  const handleDetailResize = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = detailHeight;
    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY;
      setDetailHeight(Math.max(100, Math.min(500, startHeight + delta)));
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
          <div class="ui-filmstrip">{filmstrip}</div>

          {/* Middle: Actions + Screenshot/Device */}
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
      </div>
    </div>
  );
}
