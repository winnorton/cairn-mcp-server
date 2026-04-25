#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/index.js';

async function main(): Promise<void> {
  const server = new McpServer({
    name: 'cairn-mcp-server',
    version: '0.2.0',
  });

  registerAllTools(server);

  // Crash-guard wrapper around every registered tool — an uncaught throw from a
  // handler can crash the stdio transport (EOF) and sever the agent connection.
  // Mirrors the pattern from cwar-mcp-server.
  const toolMap =
    (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ||
    (server as unknown as { _tools?: Record<string, unknown> })._tools;
  if (toolMap && typeof toolMap === 'object') {
    const entries = toolMap instanceof Map ? toolMap : new Map(Object.entries(toolMap));
    for (const [name, def] of entries) {
      if (!def || typeof def !== 'object') continue;
      const d = def as { callback?: (...args: unknown[]) => unknown; handler?: (...args: unknown[]) => unknown };
      const original = d.callback || d.handler;
      if (typeof original !== 'function') continue;
      const wrapped = async (...args: unknown[]) => {
        try {
          return await original(...args);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[tool-crash-guard] ${name} threw: ${msg}\n`);
          return {
            content: [{ type: 'text' as const, text: `Tool error (${name}): ${msg}` }],
          };
        }
      };
      if ('callback' in d) d.callback = wrapped;
      else if ('handler' in d) d.handler = wrapped;
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('cairn MCP server running on stdio\n');
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
