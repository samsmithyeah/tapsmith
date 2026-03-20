import { useState, useRef, useCallback } from 'preact/hooks'
import type { ActionTraceEvent, AssertionTraceEvent } from '../../trace/types.js'

// ─── Injected Styles ───

const SCREENSHOT_STYLES = `
  .screenshot-zoom-label { margin-left: auto; padding: 6px 12px; color: #888; font-size: 11px; }
  .screenshot-image-wrapper { position: relative; display: inline-block; }
  .screenshot-image-wrapper img { display: block; border-radius: 12px; max-height: calc(100vh - 320px); width: auto; }
  .bounds-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; border-radius: 12px; overflow: hidden; }
  .bounds-rect { position: absolute; border: 2px solid #4fc1ff; background: rgba(79,193,255,0.15); border-radius: 2px; }
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
}

type ScreenshotTab = 'before' | 'after' | 'action'

interface NaturalSize {
  width: number
  height: number
}

export function ScreenshotPanel({ event, screenshots }: Props) {
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
          <div class="device-frame" style={{ transform: `scale(${scale})`, transformOrigin: 'center center', transition: 'transform 0.1s' }}>
            <div class="screenshot-image-wrapper">
              <img
                ref={imgRef}
                src={currentUrl}
                alt={`Screenshot ${tab}`}
                onLoad={handleImageLoad}
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
            </div>
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
    <div class="bounds-overlay">
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
