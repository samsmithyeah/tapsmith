import { useState, useMemo } from 'preact/hooks'
import type { NetworkEntry } from '../../trace/types.js'

// ─── Injected Styles ───

const NETWORK_STYLES = `
  .net-container { display: flex; flex-direction: column; height: 100%; }
  .net-filter-bar { display: flex; align-items: center; gap: 8px; padding: 6px 0; flex-shrink: 0; }
  .net-filter-input { flex: 1; padding: 4px 8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); font-size: 12px; outline: none; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; }
  .net-filter-input:focus { border-color: var(--color-accent); }
  .net-status-filters { display: flex; gap: 2px; }
  .net-status-btn { padding: 2px 8px; background: transparent; border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-muted); font-size: 11px; cursor: pointer; }
  .net-status-btn:hover { color: var(--color-text-secondary); border-color: var(--color-text-faintest); }
  .net-status-btn.active { color: var(--color-text-primary); border-color: var(--color-accent); background: var(--color-highlight); }

  .net-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .net-table th { text-align: left; padding: 4px 8px; color: var(--color-text-muted); border-bottom: 1px solid var(--color-border); cursor: pointer; user-select: none; white-space: nowrap; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .net-table th:hover { color: var(--color-text-secondary); }
  .net-sort-indicator { margin-left: 4px; font-size: 9px; }
  .net-table td { padding: 4px 8px; border-bottom: 1px solid var(--color-bg-tertiary); white-space: nowrap; }
  .net-table tr.net-row { cursor: pointer; }
  .net-table tr.net-row:hover { background: var(--color-bg-hover); }
  .net-table tr.net-row.expanded { background: var(--color-bg-selected); }

  .net-method { font-weight: 600; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; }
  .net-url { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; max-width: 400px; }
  .net-status-2xx { color: var(--color-success); }
  .net-status-3xx { color: var(--color-accent); }
  .net-status-4xx { color: var(--color-warning); }
  .net-status-5xx { color: var(--color-error); }
  .net-type { color: var(--color-text-muted); }
  .net-duration { color: var(--color-text-muted); text-align: right; }
  .net-size { color: var(--color-text-muted); text-align: right; }

  .net-detail { background: var(--color-bg-secondary); }
  .net-detail td { padding: 0; }
  .net-detail-inner { padding: 10px 14px; font-size: 12px; }
  .net-detail-section { margin-bottom: 10px; }
  .net-detail-section-title { color: var(--color-accent); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .net-detail-url { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; color: var(--color-text-secondary); word-break: break-all; white-space: pre-wrap; margin-bottom: 10px; }
  .net-headers-grid { display: grid; grid-template-columns: minmax(120px, auto) 1fr; gap: 2px 12px; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; }
  .net-header-key { color: var(--color-attr); }
  .net-header-value { color: var(--color-string); word-break: break-all; }
  .net-body-block { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 3px; padding: 8px; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; color: var(--color-text-secondary); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }

  .net-empty { color: var(--color-text-faintest); font-size: 12px; padding: 24px; text-align: center; }
  .net-empty-note { color: var(--color-text-faintest); font-size: 11px; margin-top: 6px; }
  .net-table-wrapper { flex: 1; overflow-y: auto; }
`

let stylesInjected = false
function injectStyles() {
  if (stylesInjected) return
  stylesInjected = true
  const el = document.createElement('style')
  el.textContent = NETWORK_STYLES
  document.head.appendChild(el)
}

// ─── Types ───

interface Props {
  entries: NetworkEntry[]
  bodies: Map<string, string>
}

type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx'

type SortColumn = 'method' | 'url' | 'status' | 'type' | 'duration' | 'size'
type SortDirection = 'asc' | 'desc'

// ─── Helpers ───

function statusClass(status: number): string {
  if (status >= 500) return 'net-status-5xx'
  if (status >= 400) return 'net-status-4xx'
  if (status >= 300) return 'net-status-3xx'
  return 'net-status-2xx'
}

function shortenContentType(contentType: string): string {
  if (!contentType) return ''
  const ct = contentType.split(';')[0].trim()
  const mapping: Record<string, string> = {
    'application/json': 'json',
    'text/html': 'html',
    'text/plain': 'text',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/javascript': 'js',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'application/octet-stream': 'binary',
    'application/x-www-form-urlencoded': 'form',
    'multipart/form-data': 'multipart',
  }
  return mapping[ct] ?? ct.replace(/^application\//, '').replace(/^text\//, '')
}

function truncateUrl(url: string, maxLen: number): string {
  if (url.length <= maxLen) return url
  return url.slice(0, maxLen - 1) + '\u2026'
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('json')
}

function formatBody(body: string, contentType: string): string {
  if (!isJsonContentType(contentType)) return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

function matchesStatusFilter(status: number, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  const prefix = Math.floor(status / 100)
  const filterPrefix = parseInt(filter[0], 10)
  return prefix === filterPrefix
}

// ─── Component ───

export function NetworkTab({ entries, bodies }: Props) {
  injectStyles()

  const [urlFilter, setUrlFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortColumn, setSortColumn] = useState<SortColumn>('method')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  const filteredAndSorted = useMemo(() => {
    let result = entries.filter(e => {
      if (urlFilter && !e.url.toLowerCase().includes(urlFilter.toLowerCase())) return false
      if (!matchesStatusFilter(e.status, statusFilter)) return false
      return true
    })

    result = [...result].sort((a, b) => {
      let cmp = 0
      switch (sortColumn) {
        case 'method': cmp = a.method.localeCompare(b.method); break
        case 'url': cmp = a.url.localeCompare(b.url); break
        case 'status': cmp = a.status - b.status; break
        case 'type': cmp = shortenContentType(a.contentType).localeCompare(shortenContentType(b.contentType)); break
        case 'duration': cmp = a.duration - b.duration; break
        case 'size': cmp = a.responseSize - b.responseSize; break
      }
      return sortDirection === 'asc' ? cmp : -cmp
    })

    return result
  }, [entries, urlFilter, statusFilter, sortColumn, sortDirection])

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(col)
      setSortDirection('asc')
    }
  }

  const handleRowClick = (index: number) => {
    setExpandedIndex(expandedIndex === index ? null : index)
  }

  const sortIndicator = (col: SortColumn) => {
    if (sortColumn !== col) return null
    return <span class="net-sort-indicator">{sortDirection === 'asc' ? '\u25B2' : '\u25BC'}</span>
  }

  if (entries.length === 0) {
    return (
      <div class="net-empty">
        No network requests captured
        <div class="net-empty-note">Enable network capture in your trace config to record HTTP requests.</div>
      </div>
    )
  }

  const STATUS_FILTERS: StatusFilter[] = ['all', '2xx', '3xx', '4xx', '5xx']

  return (
    <div class="net-container">
      <div class="net-filter-bar">
        <input
          class="net-filter-input"
          type="text"
          placeholder="Filter by URL..."
          value={urlFilter}
          onInput={(e) => setUrlFilter((e.target as HTMLInputElement).value)}
        />
        <div class="net-status-filters">
          {STATUS_FILTERS.map(f => (
            <button
              key={f}
              class={`net-status-btn${statusFilter === f ? ' active' : ''}`}
              onClick={() => setStatusFilter(f)}
            >
              {f === 'all' ? 'All' : f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div class="net-table-wrapper">
        <table class="net-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('method')}>Method{sortIndicator('method')}</th>
              <th onClick={() => handleSort('url')}>URL{sortIndicator('url')}</th>
              <th onClick={() => handleSort('status')}>Status{sortIndicator('status')}</th>
              <th onClick={() => handleSort('type')}>Type{sortIndicator('type')}</th>
              <th style={{ textAlign: 'right' }} onClick={() => handleSort('duration')}>Duration{sortIndicator('duration')}</th>
              <th style={{ textAlign: 'right' }} onClick={() => handleSort('size')}>Size{sortIndicator('size')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredAndSorted.map(entry => {
              const isExpanded = expandedIndex === entry.index
              const requestBody = entry.requestBodyPath ? bodies.get(entry.requestBodyPath) : undefined
              const responseBody = entry.responseBodyPath ? bodies.get(entry.responseBodyPath) : undefined

              return (
                <>
                  <tr
                    key={entry.index}
                    class={`net-row${isExpanded ? ' expanded' : ''}`}
                    onClick={() => handleRowClick(entry.index)}
                  >
                    <td class="net-method">{entry.method}</td>
                    <td class="net-url">{truncateUrl(entry.url, 60)}</td>
                    <td class={statusClass(entry.status)}>{entry.status}</td>
                    <td class="net-type">{shortenContentType(entry.contentType)}</td>
                    <td class="net-duration">{entry.duration}ms</td>
                    <td class="net-size">{formatSize(entry.responseSize)}</td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${entry.index}-detail`} class="net-detail">
                      <td colSpan={6}>
                        <div class="net-detail-inner">
                          <div class="net-detail-section">
                            <div class="net-detail-section-title">URL</div>
                            <div class="net-detail-url">{entry.url}</div>
                          </div>

                          <div class="net-detail-section">
                            <div class="net-detail-section-title">Request Headers</div>
                            {Object.keys(entry.requestHeaders).length > 0 ? (
                              <div class="net-headers-grid">
                                {Object.entries(entry.requestHeaders).map(([k, v]) => (
                                  <>
                                    <span class="net-header-key">{k}</span>
                                    <span class="net-header-value">{v}</span>
                                  </>
                                ))}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--color-text-faintest)', fontSize: '11px' }}>None</span>
                            )}
                          </div>

                          {requestBody && (
                            <div class="net-detail-section">
                              <div class="net-detail-section-title">Request Body</div>
                              <pre class="net-body-block">{formatBody(requestBody, entry.contentType)}</pre>
                            </div>
                          )}

                          <div class="net-detail-section">
                            <div class="net-detail-section-title">Response Headers</div>
                            {Object.keys(entry.responseHeaders).length > 0 ? (
                              <div class="net-headers-grid">
                                {Object.entries(entry.responseHeaders).map(([k, v]) => (
                                  <>
                                    <span class="net-header-key">{k}</span>
                                    <span class="net-header-value">{v}</span>
                                  </>
                                ))}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--color-text-faintest)', fontSize: '11px' }}>None</span>
                            )}
                          </div>

                          {responseBody && (
                            <div class="net-detail-section">
                              <div class="net-detail-section-title">Response Body</div>
                              <pre class="net-body-block">{formatBody(responseBody, entry.contentType)}</pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
