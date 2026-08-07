import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';

export function registerSessionInfoTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'tapsmith_session_info',
    'Get configuration and environment info for the current test session: platform, app package, device, timeout, retries, and per-project settings. Useful for understanding the test environment before writing or running tests.',
    {},
    async () => {
      await dispatcher.ensureInitialized?.();
      const info = dispatcher.getSessionInfo();
      const lines: string[] = [];

      lines.push('## Session');
      // Name the config first: everything below is derived from it, and a
      // session running on synthesized defaults is otherwise indistinguishable
      // from one backed by a real project.
      lines.push(`Config: ${info.configPath ?? 'none — using built-in defaults'}`);
      if (info.device) lines.push(`Device: ${info.device}`);
      if (info.platform) lines.push(`Platform: ${info.platform}`);
      if (info.package) lines.push(`Package: ${info.package}`);
      lines.push(`Timeout: ${info.timeout}ms`);
      lines.push(`Retries: ${info.retries}`);

      if (info.configWarning) {
        lines.push('');
        lines.push(`WARNING: ${info.configWarning}`);
      }

      if (info.projects.length > 0) {
        lines.push('');
        lines.push('## Projects');
        for (const p of info.projects) {
          const details: string[] = [];
          if (p.platform) details.push(p.platform);
          if (p.package) details.push(p.package);
          details.push(`${p.testFiles.length} file(s)`);
          if (p.dependencies.length > 0) details.push(`depends on: ${p.dependencies.join(', ')}`);
          lines.push(`- **${p.name}**: ${details.join(' | ')}`);
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
