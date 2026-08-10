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
      // One device line per platform: a multi-platform session runs on several
      // at once, and a platform that failed to provision must not look like it
      // is simply sharing the other one's device.
      const targets = info.deviceTargets ?? [];
      const unavailable = (t: { error?: string }): string =>
        `unavailable — ${t.error ?? 'no reason was recorded'}`;
      if (targets.length > 1) {
        for (const t of targets) {
          const label = t.platform ?? 'device';
          lines.push(`Device (${label}): ${t.device ?? unavailable(t)}`);
        }
      } else if (targets.length === 1) {
        // The target's own serial before `info.device`: a dispatcher may fill
        // one and not the other, and a session that names no device at all
        // reads as if it had not resolved one.
        lines.push(`Device: ${targets[0].device ?? info.device ?? unavailable(targets[0])}`);
      } else if (info.device) {
        lines.push(`Device: ${info.device}`);
      }
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
