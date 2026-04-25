import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  expandTilde,
  humanizeAge,
  jsonResult,
  safeReadText,
  safeStat,
  walkFiles,
} from '../helpers.js';

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type MemoryType = (typeof VALID_TYPES)[number];

interface Hit {
  slug: string;
  type: string;
  name: string;
  path: string;
  mtime_iso: string;
  age_human: string;
  snippet: string | null;
}

// Discover all memory roots: each ~/.claude/projects/<slug>/memory plus ~/.claude/memory.
function discoverMemoryRoots(home: string): Array<{ slug: string; root: string }> {
  const out: Array<{ slug: string; root: string }> = [];
  // User-global
  const userGlobal = path.join(home, '.claude', 'memory');
  if (fs.existsSync(userGlobal)) {
    out.push({ slug: '<user-global>', root: userGlobal });
  }
  // Per-project
  const projectsDir = path.join(home, '.claude', 'projects');
  if (fs.existsSync(projectsDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const memRoot = path.join(projectsDir, entry.name, 'memory');
      if (fs.existsSync(memRoot)) {
        out.push({ slug: entry.name, root: memRoot });
      }
    }
  }
  return out;
}

/** Classify a memory file by its directory: `<root>/<type>/<name>.md`. */
function classifyMemoryFile(root: string, file: string): { type: string; name: string } {
  const rel = path.relative(root, file);
  const parts = rel.split(/[\\/]/);
  if (parts.length >= 2) {
    return {
      type: parts[0],
      name: parts.slice(1).join('/').replace(/\.md$/, ''),
    };
  }
  // Top-level file (e.g. MEMORY.md itself)
  return { type: '<root>', name: parts[0].replace(/\.md$/, '') };
}

/** Find first matching line + ~80 chars context. */
function findSnippet(content: string, query: string): string | null {
  const lower = content.toLowerCase();
  const lq = query.toLowerCase();
  const idx = lower.indexOf(lq);
  if (idx === -1) return null;
  // Find line bounds
  const lineStart = lower.lastIndexOf('\n', idx) + 1;
  let lineEnd = lower.indexOf('\n', idx);
  if (lineEnd === -1) lineEnd = content.length;
  let line = content.slice(lineStart, lineEnd).trim();
  if (line.length > 200) {
    // Trim around the match
    const matchInLine = line.toLowerCase().indexOf(lq);
    const start = Math.max(0, matchInLine - 80);
    const end = Math.min(line.length, matchInLine + lq.length + 80);
    line = (start > 0 ? '...' : '') + line.slice(start, end) + (end < line.length ? '...' : '');
  }
  return line;
}

export function register(server: McpServer): void {
  server.tool(
    'memory_query',
    'Search memory entries across one or more cairn project slugs. With no slugs specified, scans every ~/.claude/projects/*/memory/ plus ~/.claude/memory/. Filter by type (user|feedback|project|reference), since (ISO date), or query (case-insensitive substring). Returns hits with snippet (first matching line + context) when query is set.',
    {
      slugs: z
        .array(z.string())
        .optional()
        .describe('Project slugs to search. Omit to scan all known slugs + user-global.'),
      type: z
        .enum(VALID_TYPES)
        .optional()
        .describe('Memory type subdirectory to restrict to: user, feedback, project, or reference.'),
      since: z
        .string()
        .optional()
        .describe('ISO date or timestamp; only include entries with mtime >= this.'),
      query: z
        .string()
        .optional()
        .describe('Case-insensitive substring to match against file content.'),
    },
    async ({ slugs, type, since, query }) => {
      const home = os.homedir();
      const allRoots = discoverMemoryRoots(home);

      // Filter by requested slugs
      let roots = allRoots;
      if (slugs && slugs.length > 0) {
        const wanted = new Set(slugs);
        roots = allRoots.filter((r) => wanted.has(r.slug));
        // If a requested slug isn't in the discovered set, try resolving directly
        for (const s of slugs) {
          if (!allRoots.find((r) => r.slug === s)) {
            const direct = path.join(home, '.claude', 'projects', s, 'memory');
            if (fs.existsSync(direct)) {
              roots.push({ slug: s, root: direct });
            }
          }
        }
      }

      const sinceMs = since ? Date.parse(since) : 0;
      const sinceValid = since ? !Number.isNaN(sinceMs) : true;

      const hits: Hit[] = [];
      for (const { slug, root } of roots) {
        const files = walkFiles(root).filter((f) => f.endsWith('.md'));
        for (const file of files) {
          const cls = classifyMemoryFile(root, file);
          // Filter by type
          if (type && cls.type !== type) continue;
          // Filter by since
          const stat = safeStat(file);
          if (!stat) continue;
          if (sinceValid && sinceMs > 0 && stat.mtimeMs < sinceMs) continue;

          // Filter by query
          let snippet: string | null = null;
          if (query) {
            const content = safeReadText(file);
            if (!content) continue;
            const snip = findSnippet(content, query);
            if (snip === null) continue;
            snippet = snip;
          }

          const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
          hits.push({
            slug,
            type: cls.type,
            name: cls.name,
            path: file,
            mtime_iso: new Date(stat.mtimeMs).toISOString(),
            age_human: humanizeAge(ageSec),
            snippet,
          });
        }
      }

      // Newest first
      hits.sort((a, b) => Date.parse(b.mtime_iso) - Date.parse(a.mtime_iso));

      return jsonResult({
        hits,
        total: hits.length,
        slugs_scanned: roots.map((r) => r.slug),
      });
    }
  );
}
