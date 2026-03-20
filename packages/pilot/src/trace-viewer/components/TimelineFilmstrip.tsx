import { useRef, useEffect } from 'preact/hooks'
import type { ActionTraceEvent, AssertionTraceEvent, TraceMetadata } from '../../trace/types.js'

interface Props {
  events: (ActionTraceEvent | AssertionTraceEvent)[]
  screenshots: Map<string, string>
  metadata: TraceMetadata
  selectedIndex: number
  onSelect: (index: number) => void
}

function formatRelativeTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  return `${Math.round(seconds)}s`
}

export function TimelineFilmstrip({ events, screenshots, metadata, selectedIndex, onSelect }: Props) {
  const selectedRef = useRef<HTMLElement>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [selectedIndex])

  const statusClass = metadata.testStatus === 'passed' ? 'passed' : 'failed'
  const statusIcon = metadata.testStatus === 'passed' ? '\u2713' : '\u2717'

  const firstTimestamp = events.length > 0 ? events[0].timestamp : 0

  return (
    <div class="timeline">
      <div class="timeline-meta">
        <span class={`test-status ${statusClass}`}>{statusIcon} {metadata.testName}</span>
        {' \u00b7 '}
        {metadata.testDuration}ms
        {' \u00b7 '}
        {metadata.device.serial}
      </div>
      <div class="timeline-inner">
        {events.map((event, i) => {
          const pad = String(event.actionIndex).padStart(3, '0')
          const afterKey = `screenshots/action-${pad}-after.png`
          const beforeKey = `screenshots/action-${pad}-before.png`
          const url = screenshots.get(afterKey) ?? screenshots.get(beforeKey)
          const isSelected = i === selectedIndex
          const isFailed = event.type === 'action' ? !event.success : !event.passed
          const relativeTime = formatRelativeTime(event.timestamp - firstTimestamp)

          return (
            <div key={i} class="timeline-item">
              {url ? (
                <img
                  ref={isSelected ? selectedRef as preact.RefObject<HTMLImageElement> : undefined}
                  class={`timeline-thumb${isSelected ? ' selected' : ''}${isFailed ? ' failed' : ''}`}
                  src={url}
                  onClick={() => onSelect(i)}
                />
              ) : (
                <div
                  ref={isSelected ? selectedRef as preact.RefObject<HTMLDivElement> : undefined}
                  class={`timeline-placeholder${isSelected ? ' selected' : ''}`}
                  onClick={() => onSelect(i)}
                >
                  {i + 1}
                </div>
              )}
              <div class="timeline-time-label">{relativeTime}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
