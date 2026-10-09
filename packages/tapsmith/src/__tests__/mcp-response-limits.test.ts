import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../mcp/index.js';
import { McpEventEmitter, type McpToolCallEvent } from '../mcp/events.js';
import {
  boundThrownError,
  boundToolResult,
  clipText,
  MCP_IMAGE_BUDGET_BYTES,
  MCP_RESPONSE_MAX_BYTES,
  MCP_TEXT_BUDGET_BYTES,
  serializedTextBytes,
  truncateMiddle,
} from '../mcp/response-limits.js';

// PILOT-657: a tool response is one JSON-RPC message, and a client drops the
// whole MCP connection when one is too big. Every response is held to fixed
// budgets, with the cut announced in the text.

function textOf(result: CallToolResult): string {
  return result.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
}

function messageBytes(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), 'utf8');
}

describe('serializedTextBytes', () => {
  it('matches the JSON-escaped UTF-8 size, including escapes and surrogate pairs', () => {
    for (const sample of ['plain', 'quote " and \\ backslash', 'line\nbreak\ttab', '\u0001ctl', 'é', '€', '😀', 'lone \ud800 surrogate']) {
      expect(serializedTextBytes(sample)).toBe(Buffer.byteLength(JSON.stringify(sample), 'utf8') - 2);
    }
  });
});

describe('truncateMiddle', () => {
  it('returns text within budget unchanged', () => {
    expect(truncateMiddle('short', 100)).toBe('short');
  });

  it('keeps the start and the end, announcing the cut and the hint', () => {
    const text = `HEAD-${'x'.repeat(50_000)}-TAIL`;
    const cut = truncateMiddle(text, 2_000, 'Look elsewhere.');
    expect(serializedTextBytes(cut)).toBeLessThanOrEqual(2_000);
    expect(cut.startsWith('HEAD-')).toBe(true);
    expect(cut.endsWith('-TAIL')).toBe(true);
    expect(cut).toContain('omitted here');
    expect(cut).toContain('Look elsewhere.');
  });

  it('stays within budget for escape-heavy and multibyte text, never splitting a pair', () => {
    const text = '"\n😀é\u0001'.repeat(20_000);
    const cut = truncateMiddle(text, 5_000);
    expect(Buffer.byteLength(JSON.stringify(cut), 'utf8') - 2).toBeLessThanOrEqual(5_000);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe('clipText', () => {
  it('cuts a long value and says how much went', () => {
    const clipped = clipText('a'.repeat(5_000), 100, 'see the trace');
    expect(clipped.startsWith('a'.repeat(100))).toBe(true);
    expect(clipped).toContain('4900 more characters; see the trace');
  });

  it('leaves a short value alone', () => {
    expect(clipText('ok', 100)).toBe('ok');
  });
});

describe('boundToolResult', () => {
  it('returns a result within budget as the same object', () => {
    const result: CallToolResult = { content: [{ type: 'text', text: 'fine' }] };
    expect(boundToolResult(result)).toBe(result);
  });

  it('holds a huge text result under the byte cap and names the tool-specific way out', () => {
    const result: CallToolResult = { content: [{ type: 'text', text: 'z'.repeat(5 * 1024 * 1024) }], isError: true };
    const bounded = boundToolResult(result, 'tapsmith_list_results');
    expect(messageBytes(bounded)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    expect(serializedTextBytes(textOf(bounded))).toBeLessThanOrEqual(MCP_TEXT_BUDGET_BYTES);
    expect(textOf(bounded)).toContain('status, file or test filters');
    expect(bounded.isError).toBe(true);
  });

  it('shares the text budget across items without starving a later one', () => {
    const result: CallToolResult = {
      content: [
        { type: 'text', text: 'y'.repeat(MCP_TEXT_BUDGET_BYTES * 2) },
        { type: 'text', text: 'closing note' },
      ],
    };
    const bounded = boundToolResult(result);
    expect(bounded.content).toHaveLength(2);
    expect((bounded.content[1] as { text: string }).text).toBe('closing note');
    const textBytes = bounded.content.reduce((sum, c) => sum + (c.type === 'text' ? serializedTextBytes(c.text) : 0), 0);
    expect(textBytes).toBeLessThanOrEqual(MCP_TEXT_BUDGET_BYTES);
  });

  it('drops images past the image budget and says how many', () => {
    const image = { type: 'image' as const, data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' };
    const result: CallToolResult = { content: [{ type: 'text', text: 'run' }, image, image, image, image] };
    const bounded = boundToolResult(result, 'tapsmith_run_tests');
    expect(bounded.content.filter((c) => c.type === 'image')).toHaveLength(2);
    expect(textOf(bounded)).toContain('2 image(s) omitted');
    expect(messageBytes(bounded)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  });

  it('drops a single image larger than the whole image budget', () => {
    const result: CallToolResult = {
      content: [{ type: 'image', data: 'A'.repeat(MCP_IMAGE_BUDGET_BYTES + 1), mimeType: 'image/png' }],
    };
    const bounded = boundToolResult(result, 'tapsmith_screenshot');
    expect(bounded.content.some((c) => c.type === 'image')).toBe(false);
    expect(textOf(bounded)).toContain('1 image(s) omitted');
  });

  it('stays under the cap with thousands of text items', () => {
    const content = Array.from({ length: 5_000 }, () => ({ type: 'text' as const, text: 'w'.repeat(200) }));
    const bounded = boundToolResult({ content });
    expect(messageBytes(bounded)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  });
});

describe('boundThrownError', () => {
  it('shortens a huge error message in place', () => {
    const err = new Error('e'.repeat(1024 * 1024));
    expect(boundThrownError(err)).toBe(err);
    expect(serializedTextBytes(err.message)).toBeLessThanOrEqual(MCP_TEXT_BUDGET_BYTES);
  });
});

describe('MCP server response boundary', () => {
  async function callTool(
    register: (server: ReturnType<typeof createMcpServer>) => void,
    events?: McpEventEmitter,
  ): Promise<CallToolResult> {
    const server = createMcpServer({ events });
    register(server);
    const client = new Client({ name: 'limits-probe', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await client.callTool({ name: 'huge_tool', arguments: { n: 1 } }) as CallToolResult;
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('bounds the result of any registered tool', async () => {
    const res = await callTool((server) => {
      server.tool('huge_tool', 'test', { n: z.number() }, async () => ({
        content: [{ type: 'text' as const, text: 'q'.repeat(3 * 1024 * 1024) }],
      }));
    });
    expect(messageBytes(res)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    expect(textOf(res)).toContain('omitted here');
  });

  it('bounds a thrown error that the protocol layer turns into an error result', async () => {
    const res = await callTool((server) => {
      server.tool('huge_tool', 'test', { n: z.number() }, async () => {
        throw new Error('boom '.repeat(500_000));
      });
    });
    expect(res.isError).toBe(true);
    expect(messageBytes(res)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
  });

  it('reports the bounded result to MCP activity listeners and keeps tool args', async () => {
    const events = new McpEventEmitter();
    const seen: McpToolCallEvent[] = [];
    events.onToolCall((e) => seen.push(e));
    await callTool((server) => {
      server.tool('huge_tool', 'test', { n: z.number() }, async () => ({
        content: [{ type: 'text' as const, text: 'q'.repeat(3 * 1024 * 1024) }],
      }));
    }, events);
    const done = seen.find((e) => e.status === 'completed');
    expect(done?.args).toEqual({ n: 1 });
    expect(done?.resultTruncated).toBe(true);
  });
});
