import { useRef, useEffect, useState, useCallback } from 'preact/hooks';
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

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [toolCalls.length]);

  // Merge started+completed events: show in-progress items immediately,
  // replace with completed version when it arrives.
  const mergedCalls = mergeToolCalls(toolCalls);

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
          {mergedCalls.length > 0 && (
            <button class="mcp-btn" onClick={onClear} title="Clear activity feed">
              Clear
            </button>
          )}
        </div>
      </div>

      <div class="mcp-feed" ref={feedRef}>
        {mergedCalls.length === 0
          ? (
            <div class="mcp-empty">
              {clientName
                ? 'Waiting for tool calls...'
                : sseUrl
                  ? <McpSetupHint sseUrl={sseUrl} />
                  : 'MCP server starting...'}
            </div>
          )
          : mergedCalls.map(tc => (
            <div
              key={tc.id}
              class={`mcp-entry ${tc.status}${expandedId === tc.id ? ' expanded' : ''}`}
              onClick={() => setExpandedId(prev => prev === tc.id ? null : tc.id)}
            >
              <div class="mcp-entry-header">
                <span class="mcp-time">{formatTime(tc.timestamp)}</span>
                <span class="mcp-tool">{tc.tool.replace('pilot_', '')}</span>
                {tc.status === 'started'
                  ? <span class="mcp-duration running">running…</span>
                  : tc.durationMs != null && (
                    <span class="mcp-duration">{formatDuration(tc.durationMs)}</span>
                  )}
              </div>
              {tc.status === 'started' && (
                <div class="mcp-entry-summary mcp-in-progress">
                  {formatToolArgs(tc.tool, tc.args)}
                </div>
              )}
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

function CopyableCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((e: Event) => {
    e.stopPropagation();
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [command]);

  return (
    <div class="mcp-command">
      <div class="mcp-command-label">{label}</div>
      <div class="mcp-command-row">
        <code class="mcp-command-text">{command}</code>
        <button class="mcp-copy-btn" onClick={handleCopy} title="Copy to clipboard">
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function McpSetupHint({ sseUrl }: { sseUrl: string }) {
  const sseCommand = `claude mcp add pilot --transport sse ${sseUrl}`;

  return (
    <div class="mcp-setup">
      <div class="mcp-setup-title">Connect your AI agent</div>
      <CopyableCommand label="SSE endpoint" command={sseUrl} />
      <CopyableCommand label="Claude Code (run in terminal)" command={sseCommand} />
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

function mergeToolCalls(calls: McpToolCallMessage[]): McpToolCallMessage[] {
  const byId = new Map<string, McpToolCallMessage>();
  for (const tc of calls) {
    const existing = byId.get(tc.id);
    if (!existing || tc.status !== 'started') {
      byId.set(tc.id, tc);
    }
  }
  return Array.from(byId.values());
}

function formatToolArgs(tool: string, args: Record<string, unknown>): string {
  if (tool === 'pilot_run_tests' && Array.isArray(args.files)) {
    const files = args.files as string[];
    const names = files.map(f => {
      const parts = String(f).split('/');
      return parts[parts.length - 1];
    });
    return `Running ${names.join(', ')}`;
  }
  if (tool === 'pilot_tap' || tool === 'pilot_type') {
    return String(args.selector ?? '');
  }
  return '';
}
