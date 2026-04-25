import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { expandTilde, jsonResult, pathToSlug, slugToCandidates } from '../helpers.js';

export function register(server: McpServer): void {
  server.tool(
    'slug_for',
    'Convert an absolute filesystem path to a cairn project slug. Returns the slug plus the user-global memory root, the project-scoped memory root, and the project .claude directory.',
    {
      path: z.string().describe('Absolute filesystem path to the project directory.'),
    },
    async ({ path: inputPath }) => {
      const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(inputPath);
      const slug = pathToSlug(abs);
      const home = os.homedir();
      const result = {
        input_path: inputPath,
        absolute_path: abs,
        slug,
        memory_root_user_global: path.join(home, '.claude', 'memory'),
        memory_root_project_scoped: path.join(home, '.claude', 'projects', slug, 'memory'),
        project_claude: path.join(abs, '.claude'),
      };
      return jsonResult(result);
    }
  );

  server.tool(
    'paths_for',
    'Reverse a cairn slug to candidate filesystem paths. Tries Windows (`C--Users-...` -> `C:\\Users\\...`) and Unix patterns. Returns all decoded candidates plus a list filtered to those that exist on disk.',
    {
      slug: z.string().describe('Project slug (e.g. C--Users-winno-projects-foo).'),
    },
    async ({ slug }) => {
      const candidates = slugToCandidates(slug);
      const existing = candidates.filter((c) => {
        try {
          return existsSync(expandTilde(c));
        } catch {
          return false;
        }
      });
      return jsonResult({
        slug,
        candidates,
        existing,
      });
    }
  );
}
