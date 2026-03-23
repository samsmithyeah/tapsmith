import { useState, useRef, useCallback } from 'preact/hooks'
import type { ActionTraceEvent, AssertionTraceEvent } from '../../trace/types.js'

// ─── Injected Styles ───

const SCREENSHOT_STYLES = `
  .screenshot-zoom-label { margin-left: auto; padding: 6px 12px; color: var(--color-text-muted); font-size: 11px; }
  .screenshot-image-wrapper { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .screenshot-image-wrapper img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; }
  .bounds-overlay { position: absolute; pointer-events: none; border-radius: 8px; overflow: hidden; }
  .bounds-rect { position: absolute; border: 2px solid var(--color-accent); background: rgba(79,193,255,0.15); border-radius: 2px; }
  .bounds-rect-hierarchy { position: absolute; border: 2px solid var(--color-success); background: rgba(78,201,176,0.15); border-radius: 2px; }
  .bounds-point { position: absolute; width: 16px; height: 16px; margin-left: -8px; margin-top: -8px; border-radius: 50%; background: rgba(255,80,80,0.5); border: 2px solid #ff5050; box-shadow: 0 0 8px rgba(255,80,80,0.4); }
`

let stylesInjected = false
function injectStyles() {
  if (stylesInjected) return
  stylesInjected = true
  const el = document.createElement('style')
  el.textContent = SCREENSHOT_STYLES
  document.head.appendChild(el)
}

// ─── Types ───

interface Props {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  screenshots: Map<string, string>
  highlightBounds?: { left: number; top: number; right: number; bottom: number } | null
  onScreenshotClick?: (point: { x: number; y: number }) => void
}

type ScreenshotTab = 'before' | 'after' | 'action'

interface NaturalSize {
  width: number
  height: number
}

export function ScreenshotPanel({ event, screenshots, highlightBounds, onScreenshotClick }: Props) {
  injectStyles()

  const [tab, setTab] = useState<ScreenshotTab>('after')
  const [scale, setScale] = useState(1)
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    setScale(prev => {
      const delta = e.deltaY > 0 ? -0.1 : 0.1
      return Math.max(0.5, Math.min(5, prev + delta))
    })
  }, [])

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current
    if (img) {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight })
    }
  }, [])

  const handleImageClick = useCallback((e: MouseEvent) => {
    if (!onScreenshotClick || !imgRef.current || !naturalSize) return
    const img = imgRef.current
    const rect = img.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top
    const naturalX = Math.round(clickX * (naturalSize.width / rect.width))
    const naturalY = Math.round(clickY * (naturalSize.height / rect.height))
    onScreenshotClick({ x: naturalX, y: naturalY })
  }, [onScreenshotClick, naturalSize])

  if (!event) {
    return (
      <div class="screenshot-panel">
        <div class="screenshot-container">
          <div class="screenshot-empty">Select an action to view screenshots</div>
        </div>
      </div>
    )
  }

  const pad = String(event.actionIndex).padStart(3, '0')
  const beforeUrl = screenshots.get(`screenshots/action-${pad}-before.png`)
  const afterUrl = screenshots.get(`screenshots/action-${pad}-after.png`)

  const hasBefore = !!beforeUrl
  const hasAfter = !!afterUrl

  // Auto-select best available tab
  let currentUrl: string | undefined
  if (tab === 'before') currentUrl = beforeUrl
  else if (tab === 'after') currentUrl = afterUrl ?? beforeUrl
  else currentUrl = beforeUrl // 'action' tab shows before with overlay

  // If selected tab has no screenshot, fall back
  if (!currentUrl) {
    currentUrl = afterUrl ?? beforeUrl
  }

  const showOverlay = tab === 'action' && event.type === 'action'
  const bounds = event.type === 'action' ? event.bounds : undefined
  const point = event.type === 'action' ? event.point : undefined

  return (
    <div class="screenshot-panel">
      <div class="screenshot-tabs">
        {hasBefore && hasAfter && (
          <div class={`screenshot-tab${tab === 'action' ? ' active' : ''}`} onClick={() => setTab('action')}>Action</div>
        )}
        {hasBefore && (
          <div class={`screenshot-tab${tab === 'before' ? ' active' : ''}`} onClick={() => setTab('before')}>Before</div>
        )}
        {hasAfter && (
          <div class={`screenshot-tab${tab === 'after' ? ' active' : ''}`} onClick={() => setTab('after')}>After</div>
        )}
        {scale !== 1 && (
          <div class="screenshot-zoom-label">{Math.round(scale * 100)}%</div>
        )}
      </div>
      <div class="screenshot-container" onWheel={handleWheel}>
        {currentUrl ? (
          <div class="screenshot-image-wrapper" style={scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'center center' } : undefined}>
            <img
              ref={imgRef}
              src={currentUrl}
              alt={`Screenshot ${tab}`}
              onLoad={handleImageLoad}
              onClick={handleImageClick}
              style={onScreenshotClick ? { cursor: 'crosshair' } : undefined}
            />
            {showOverlay && naturalSize && imgRef.current && (
              <BoundsOverlay
                bounds={bounds}
                point={point}
                naturalSize={naturalSize}
                renderedWidth={imgRef.current.clientWidth}
                renderedHeight={imgRef.current.clientHeight}
              />
            )}
            {highlightBounds && naturalSize && imgRef.current && (
              <HierarchyHighlightOverlay
                bounds={highlightBounds}
                naturalSize={naturalSize}
                renderedWidth={imgRef.current.clientWidth}
                renderedHeight={imgRef.current.clientHeight}
              />
            )}
          </div>
        ) : (
          <div class="screenshot-empty">No screenshot available for this action</div>
        )}
      </div>
    </div>
  )
}

// ─── Bounds Overlay ───

interface BoundsOverlayProps {
  bounds?: { left: number; top: number; right: number; bottom: number }
  point?: { x: number; y: number }
  naturalSize: NaturalSize
  renderedWidth: number
  renderedHeight: number
}

function BoundsOverlay({ bounds, point, naturalSize, renderedWidth, renderedHeight }: BoundsOverlayProps) {
  if (!bounds && !point) return null

  const scaleX = renderedWidth / naturalSize.width
  const scaleY = renderedHeight / naturalSize.height

  return (
    <div
      class="bounds-overlay"
      style={{
        width: `${renderedWidth}px`,
        height: `${renderedHeight}px`,
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
  )
}

// ─── Hierarchy Highlight Overlay ───

interface HierarchyHighlightProps {
  bounds: { left: number; top: number; right: number; bottom: number }
  naturalSize: NaturalSize
  renderedWidth: number
  renderedHeight: number
}

function HierarchyHighlightOverlay({ bounds, naturalSize, renderedWidth, renderedHeight }: HierarchyHighlightProps) {
  const scaleX = renderedWidth / naturalSize.width
  const scaleY = renderedHeight / naturalSize.height

  return (
    <div
      class="bounds-overlay"
      style={{
        width: `${renderedWidth}px`,
        height: `${renderedHeight}px`,
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
  )
}
