export interface McpToolCallEvent {
  id: string
  tool: string
  args: Record<string, unknown>
  status: 'started' | 'completed' | 'error'
  resultSummary?: string
  error?: string
  durationMs?: number
  timestamp: number
}

export interface McpClientInfo {
  name: string
  version: string
}

type ToolCallListener = (event: McpToolCallEvent) => void
type ClientListener = (info: McpClientInfo | null) => void

export class McpEventEmitter {
  private _toolCallListeners: ToolCallListener[] = [];
  private _clientListeners: ClientListener[] = [];

  onToolCall(listener: ToolCallListener): void {
    this._toolCallListeners.push(listener);
  }

  onClientChange(listener: ClientListener): void {
    this._clientListeners.push(listener);
  }

  emitToolCall(event: McpToolCallEvent): void {
    for (const listener of this._toolCallListeners) {
      listener(event);
    }
  }

  emitClientChange(info: McpClientInfo | null): void {
    for (const listener of this._clientListeners) {
      listener(info);
    }
  }
}

let _callCounter = 0;

export function nextCallId(): string {
  return `mcp-${++_callCounter}-${Date.now()}`;
}

export function summarizeResult(tool: string, result: string): string {
  switch (tool) {
    case 'pilot_snapshot': {
      const selectorMatch = result.match(/## Suggested Selectors\n([\s\S]*)/);
      const selectorCount = selectorMatch
        ? selectorMatch[1].trim().split('\n').length
        : 0;
      const elementMatch = result.match(/^- /gm);
      const elementCount = elementMatch ? elementMatch.length : 0;
      return `${elementCount} elements, ${selectorCount} selectors`;
    }
    case 'pilot_screenshot':
      return 'PNG image captured';
    case 'pilot_test_selector': {
      try {
        const parsed = JSON.parse(result);
        return parsed.matched
          ? `matched ${parsed.count} element${parsed.count !== 1 ? 's' : ''}`
          : 'no match';
      } catch {
        return result.slice(0, 60);
      }
    }
    case 'pilot_list_devices': {
      try {
        const devices = JSON.parse(result);
        return `${devices.length} device${devices.length !== 1 ? 's' : ''}`;
      } catch {
        return result.slice(0, 60);
      }
    }
    case 'pilot_run_tests': {
      const passMatch = result.match(/(\d+) passed/);
      const failMatch = result.match(/(\d+) failed/);
      if (passMatch || failMatch) {
        const parts: string[] = [];
        if (passMatch) parts.push(`${passMatch[1]} passed`);
        if (failMatch) parts.push(`${failMatch[1]} failed`);
        return parts.join(', ');
      }
      return result.includes('All tests passed') ? 'all passed' : result.slice(0, 60);
    }
    case 'pilot_tap':
    case 'pilot_type':
    case 'pilot_swipe':
    case 'pilot_press_key':
    case 'pilot_launch_app':
      return result === 'OK' ? 'OK' : result.slice(0, 60);
    case 'pilot_read_trace':
      return result.includes('## Steps')
        ? result.match(/## Steps \((\d+) events\)/)?.[0] ?? result.slice(0, 60)
        : result.slice(0, 60);
    default:
      return result.slice(0, 60);
  }
}
