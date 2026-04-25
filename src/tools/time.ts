import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { humanizeAge, humanTimeUtc, jsonResult, safeStat } from '../helpers.js';

export function register(server: McpServer): void {
  server.tool(
    'now',
    'Return the current wall-clock time as ISO, unix seconds, unix milliseconds, and a human-readable UTC string.',
    {},
    async () => {
      const d = new Date();
      const ms = d.getTime();
      return jsonResult({
        iso: d.toISOString(),
        unix_seconds: Math.floor(ms / 1000),
        unix_ms: ms,
        human: humanTimeUtc(d),
      });
    }
  );

  server.tool(
    'age_of',
    'Return the mtime, age in seconds, and a human-readable age string for a path. Returns { exists: false } if the path is missing.',
    {
      path: z.string().describe('Absolute or relative path to inspect.'),
    },
    async ({ path: inputPath }) => {
      const stat = safeStat(inputPath);
      if (!stat) return jsonResult({ exists: false, path: inputPath });
      const mtimeMs = stat.mtimeMs;
      const mtimeUnix = Math.floor(mtimeMs / 1000);
      const ageSeconds = Math.floor((Date.now() - mtimeMs) / 1000);
      return jsonResult({
        exists: true,
        path: inputPath,
        mtime_iso: new Date(mtimeMs).toISOString(),
        mtime_unix: mtimeUnix,
        age_seconds: ageSeconds,
        age_human: humanizeAge(ageSeconds),
      });
    }
  );
}
