/**
 * OutputLog — displays live trace events as they arrive.
 *
 * Shows actions, assertions, console output, and errors in a scrollable
 * log view. For Phase 1, this is a simple event log. Phase 2 will wire
 * in the full trace viewer components (ActionsPanel, DetailTabs, etc.).
 */

import { useRef, useEffect } from 'preact/hooks'
import type { AnyTraceEvent } from '../../trace/types.js'

interface OutputLogProps {
  events: AnyTraceEvent[]
}

export function OutputLog({ events }: OutputLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [events.length])

  return (
    <div class="output-log" ref={scrollRef}>
      {events.length === 0 && (
        <div class="ol-empty">Run a test to see live trace events...</div>
      )}
      {events.map((event, i) => (
        <EventRow key={i} event={event} />
      ))}
    </div>
  )
}

function EventRow({ event }: { event: AnyTraceEvent }) {
  switch (event.type) {
    case 'action':
      return (
        <div class={`ol-event ol-action ${event.success ? '' : 'failed'}`}>
          <span class="ol-icon">{actionIcon(event.category)}</span>
          <span class="ol-name">{event.action}</span>
          {event.selector && <span class="ol-selector">{event.selector}</span>}
          <span class="ol-duration">{event.duration}ms</span>
          {!event.success && event.error && (
            <div class="ol-error">{event.error}</div>
          )}
        </div>
      )

    case 'assertion':
      return (
        <div class={`ol-event ol-assertion ${event.passed ? '' : 'failed'}`}>
          <span class="ol-icon">{event.passed ? '\u2713' : '\u2717'}</span>
          <span class="ol-name">{event.assertion}</span>
          {event.selector && <span class="ol-selector">{event.selector}</span>}
          <span class="ol-duration">{event.duration}ms</span>
          {!event.passed && event.error && (
            <div class="ol-error">{event.error}</div>
          )}
        </div>
      )

    case 'group-start':
      return (
        <div class="ol-event ol-group">
          <span class="ol-icon">{'\u25B8'}</span>
          <span class="ol-name">{event.name}</span>
        </div>
      )

    case 'group-end':
      return (
        <div class="ol-event ol-group ol-group-end">
          <span class="ol-icon">{'\u25C2'}</span>
          <span class="ol-name">{event.name}</span>
        </div>
      )

    case 'console':
      return (
        <div class={`ol-event ol-console ol-console-${event.level}`}>
          <span class="ol-icon">[{event.level}]</span>
          <span class="ol-message">{event.message}</span>
        </div>
      )

    case 'error':
      return (
        <div class="ol-event ol-error-event">
          <span class="ol-icon">{'\u2717'}</span>
          <span class="ol-message">{event.message}</span>
        </div>
      )

    default:
      return null
  }
}

function actionIcon(category: string): string {
  switch (category) {
    case 'tap': return '\u25CE'
    case 'type': return 'T'
    case 'swipe': return '\u2194'
    case 'scroll': return '\u2195'
    case 'navigation': return '\u2192'
    case 'assertion': return '\u2713'
    default: return '\u25CB'
  }
}
