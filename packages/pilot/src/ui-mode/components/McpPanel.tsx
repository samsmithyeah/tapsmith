import { useRef, useEffect, useState } from 'preact/hooks';
import type { McpToolCallMessage } from '../ui-protocol.js';

interface McpPanelProps {
  sseUrl?: string
  clientName?: string
  clientVersion?: string
  toolCalls: McpToolCallMessage[]
  onClear: () => void
}

export function McpPanel({ sseUrl, clientName, clientVersion, toolCalls, onClear }: McpPanelProps) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [toolCalls.length]);

  const handleCopyConfig = () => {
    if (!sseUrl) return;
    const config = JSON.stringify({ pilot: { type: 'sse', url: sseUrl } }, null, 2);
    navigator.clipboard.writeText(config);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const completed = toolCalls.filter(tc => tc.status !== 'started');

  return (
    <div class="mcp-panel">
      <div class="mcp-header">
        <div class="mcp-header-left">
          <span class="mcp-title">MCP Server</span>
          {clientName
            ? (
              <span class="mcp-connection connected">
                <span class="mcp-dot connected" />
                {clientName}{clientVersion ? ` ${clientVersion}` : ''}
              </span>
            )
            : (
              <span class="mcp-connection listening">
                <span class="mcp-dot listening" />
                Listening
              </span>
            )}
        </div>
        <div class="mcp-header-right">
          {sseUrl && (
            <button class="mcp-btn" onClick={handleCopyConfig} title="Copy .mcp.json config to clipboard">
              {copied ? 'Copied!' : 'Copy config'}
            </button>
          )}
          {completed.length > 0 && (
            <button class="mcp-btn" onClick={onClear} title="Clear activity feed">
              Clear
            </button>
          )}
        </div>
      </div>

      <div class="mcp-feed" ref={feedRef}>
        {completed.length === 0
          ? (
            <div class="mcp-empty">
              {clientName
                ? 'Waiting for tool calls...'
                : sseUrl
                  ? <McpSetupHint sseUrl={sseUrl} />
                  : 'MCP server starting...'}
            </div>
          )
          : completed.map(tc => (
            <div
              key={tc.id}
              class={`mcp-entry ${tc.status}${expandedId === tc.id ? ' expanded' : ''}`}
              onClick={() => setExpandedId(prev => prev === tc.id ? null : tc.id)}
            >
              <div class="mcp-entry-header">
                <span class="mcp-time">{formatTime(tc.timestamp)}</span>
                <span class="mcp-tool">{tc.tool.replace('pilot_', '')}</span>
                {tc.durationMs != null && (
                  <span class="mcp-duration">{formatDuration(tc.durationMs)}</span>
                )}
              </div>
              {tc.resultSummary && (
                <div class="mcp-entry-summary">
                  {tc.status === 'error' ? tc.error ?? tc.resultSummary : tc.resultSummary}
                </div>
              )}
              {expandedId === tc.id && Object.keys(tc.args).length > 0 && (
                <div class="mcp-entry-detail">
                  {Object.entries(tc.args).map(([k, v]) => (
                    <div key={k} class="mcp-detail-row">
                      <span class="mcp-detail-key">{k}:</span>
                      <span class="mcp-detail-value">{formatArgValue(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

function McpSetupHint({ sseUrl }: { sseUrl: string }) {
  return (
    <div>
      <div style="margin-bottom: 8px">No agent connected. To use with Claude Code:</div>
      <code class="mcp-code-block">
        {`// .mcp.json\n{\n  "pilot": {\n    "type": "sse",\n    "url": "${sseUrl}"\n  }\n}`}
      </code>
    </div>
  );
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatArgValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '...' : v;
  if (Array.isArray(v)) return `[${v.length} items]`;
  return String(v);
}
