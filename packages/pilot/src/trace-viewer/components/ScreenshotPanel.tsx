import { useState } from 'preact/hooks'
import type { ActionTraceEvent, AssertionTraceEvent } from '../../trace/types.js'

interface Props {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  screenshots: Map<string, string>
}

type ScreenshotTab = 'before' | 'after' | 'action'

export function ScreenshotPanel({ event, screenshots }: Props) {
  const [tab, setTab] = useState<ScreenshotTab>('after')

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
      </div>
      <div class="screenshot-container">
        {currentUrl ? (
          <div class="device-frame">
            <img src={currentUrl} alt={`Screenshot ${tab}`} />
          </div>
        ) : (
          <div class="screenshot-empty">No screenshot available for this action</div>
        )}
      </div>
    </div>
  )
}
