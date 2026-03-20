import { useRef, useEffect } from 'preact/hooks'
import type { ActionTraceEvent, AssertionTraceEvent, TraceMetadata } from '../../trace/types.js'

interface Props {
  events: (ActionTraceEvent | AssertionTraceEvent)[]
  screenshots: Map<string, string>
  metadata: TraceMetadata
  selectedIndex: number
  onSelect: (index: number) => void
}

export function TimelineFilmstrip({ events, screenshots, metadata, selectedIndex, onSelect }: Props) {
  const selectedRef = useRef<HTMLElement>(null)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [selectedIndex])

  const statusClass = metadata.testStatus === 'passed' ? 'passed' : 'failed'
  const statusIcon = metadata.testStatus === 'passed' ? '\u2713' : '\u2717'

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

          if (url) {
            return (
              <img
                key={i}
                ref={isSelected ? selectedRef as preact.RefObject<HTMLImageElement> : undefined}
                class={`timeline-thumb${isSelected ? ' selected' : ''}${isFailed ? ' failed' : ''}`}
                src={url}
                onClick={() => onSelect(i)}
              />
            )
          }

          return (
            <div
              key={i}
              ref={isSelected ? selectedRef as preact.RefObject<HTMLDivElement> : undefined}
              class={`timeline-placeholder${isSelected ? ' selected' : ''}`}
              onClick={() => onSelect(i)}
            >
              {i + 1}
            </div>
          )
        })}
      </div>
    </div>
  )
}
