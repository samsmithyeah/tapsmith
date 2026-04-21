import { useRef, useEffect } from 'preact/hooks';
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

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [toolCalls.length]);

  const handleCopyConfig = () => {
    if (!sseUrl) return;
    const config = JSON.stringify({ pilot: { type: 'sse', url: sseUrl } }, null, 2);
    navigator.clipboard.writeText(config);
  };

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
            <button class="mcp-btn" onClick={handleCopyConfig} title="Copy .mcp.json config">
              Copy config
            </button>
          )}
          {toolCalls.length > 0 && (
            <button class="mcp-btn" onClick={onClear} title="Clear activity feed">
              Clear
            </button>
          )}
        </div>
      </div>

      <div class="mcp-feed" ref={feedRef}>
        {toolCalls.length === 0
          ? (
            <div class="mcp-empty">
              {clientName
                ? 'Waiting for tool calls...'
                : sseUrl
                  ? `Add to .mcp.json: { "pilot": { "type": "sse", "url": "${sseUrl}" } }`
                  : 'MCP server starting...'}
            </div>
          )
          : toolCalls.filter(tc => tc.status !== 'started').map(tc => (
            <div key={tc.id} class={`mcp-entry ${tc.status}`}>
              <div class="mcp-entry-header">
                <span class="mcp-time">{formatTime(tc.timestamp)}</span>
                <span class="mcp-tool">{tc.tool.replace('pilot_', '')}</span>
                {tc.durationMs != null && (
                  <span class="mcp-duration">{formatDuration(tc.durationMs)}</span>
                )}
              </div>
              {tc.resultSummary && (
                <div class="mcp-entry-summary">
                  {tc.status === 'error' ? `✗ ${tc.error ?? tc.resultSummary}` : tc.resultSummary}
                </div>
              )}
            </div>
          ))}
      </div>
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
