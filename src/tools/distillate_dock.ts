import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { expandTilde, jsonResult, safeReadText, safeStat } from '../helpers.js';

interface ConsumerSpec {
  /** Memory-tree root for this consumer; supports `~` and `~/`. */
  memory_root: string;
  /**
   * When true, type subdirs use a project-name layer
   * (e.g. `project/<this_project>/<entry>.md`). Used for user-global memory
   * stores that are shared across multiple workspaces (Antigravity).
   * When false, distillate goes flat under the type subdir.
   */
  cross_project: boolean;
}

const CONSUMERS: Record<string, ConsumerSpec> = {
  antigravity: {
    memory_root: '~/.gemini/antigravity/memory',
    cross_project: true,
  },
  // claude-code is the local default; not registered as a transport target.
  // Memory there lives at slug-scoped paths the producing agent is already in,
  // so dock-style transport doesn't apply.
};

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type MemoryType = (typeof VALID_TYPES)[number];

function isValidType(s: string): s is MemoryType {
  return (VALID_TYPES as readonly string[]).includes(s);
}

/**
 * Parse YAML frontmatter and return the `type` field plus the full key/value map.
 * Tolerant of LF or CRLF line endings; tolerant of quoted string values.
 * Returns `{ type: null }` if no frontmatter or no `type` field.
 */
function parseFrontmatter(text: string): { type: string | null; raw: Record<string, string> } {
  const out: Record<string, string> = {};
  // Frontmatter must start with --- on the first line.
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { type: null, raw: out };
  }
  // Find the closing --- after the first line.
  const afterOpen = text.indexOf('\n', 0) + 1;
  const lf = text.indexOf('\n---\n', afterOpen);
  const crlf = text.indexOf('\r\n---\r\n', afterOpen);
  const end = lf >= 0 && (crlf < 0 || lf < crlf) ? lf : crlf;
  if (end < 0) return { type: null, raw: out };
  const block = text.slice(afterOpen, end);
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*?)\s*$/);
    if (m) {
      out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return { type: out.type || null, raw: out };
}

export function register(server: McpServer): void {
  server.tool(
    'distillate_dock',
    'Copy a distillate file from a producing workspace to a consumer habitat\'s typed memory tree. Reads the source\'s YAML frontmatter to determine type (user/feedback/project/reference), looks up the consumer\'s memory root + layout flag (slug-separated vs cross-project user-global), computes the destination per cairn v0.11.0 layout rules (cross-project consumers get a project-name subdir layer to prevent pile-up), creates intermediate directories, and copies. Returns the destination path and a copied flag. Use to eliminate manual cp friction for cross-workspace distillate transport (e.g. cairn-test-3 producing research for Antigravity consumption).',
    {
      source_path: z
        .string()
        .describe('Absolute path to the distillate file. Must exist and have a valid `type` field in YAML frontmatter.'),
      consumer: z
        .string()
        .describe('Consumer name (e.g. "antigravity"). Must be a registered consumer.'),
      this_project: z
        .string()
        .optional()
        .describe('Producing project name. Used as the subdir layer for cross-project consumers (e.g. "cwar-engine"). Defaults to path.basename(process.cwd()).'),
      dry_run: z
        .boolean()
        .default(false)
        .describe('If true, compute and return the destination but do not actually copy.'),
    },
    async ({ source_path, consumer, this_project, dry_run }) => {
      const result: Record<string, unknown> = {
        source_path,
        consumer,
        this_project: null,
        destination: null,
        copied: false,
        dry_run,
        error: null,
      };

      // Validate source
      const srcAbs = path.resolve(expandTilde(source_path));
      result.source_path = srcAbs;
      const srcStat = safeStat(srcAbs);
      if (!srcStat || !srcStat.isFile()) {
        result.error = `Source not found or not a file: ${srcAbs}`;
        return jsonResult(result);
      }

      // Validate consumer
      const spec = CONSUMERS[consumer];
      if (!spec) {
        const known = Object.keys(CONSUMERS);
        result.error = `Unknown consumer "${consumer}". Known: ${known.length ? known.join(', ') : '(none registered)'}.`;
        return jsonResult(result);
      }

      // Parse type from source frontmatter
      const text = safeReadText(srcAbs);
      if (text === null) {
        result.error = `Could not read source: ${srcAbs}`;
        return jsonResult(result);
      }
      const { type: declaredType } = parseFrontmatter(text);
      if (!declaredType) {
        result.error = 'Source has no `type:` field in YAML frontmatter. Distillate files must declare a type (user/feedback/project/reference).';
        return jsonResult(result);
      }
      if (!isValidType(declaredType)) {
        result.error = `Invalid type "${declaredType}" in frontmatter. Must be one of: ${VALID_TYPES.join(', ')}.`;
        return jsonResult(result);
      }

      // Compute project name
      const projectName = this_project ?? path.basename(process.cwd());
      result.this_project = projectName;

      // Compute destination per v0.11.0 layout rule
      const memoryRoot = path.resolve(expandTilde(spec.memory_root));
      const filename = path.basename(srcAbs);
      const destDir = spec.cross_project
        ? path.join(memoryRoot, declaredType, projectName)
        : path.join(memoryRoot, declaredType);
      const destAbs = path.join(destDir, filename);
      result.destination = destAbs;
      result.layout = spec.cross_project ? 'cross-project (project-subdir layer)' : 'slug-separated (flat)';

      if (dry_run) {
        return jsonResult(result);
      }

      // Create destination dir + copy
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(srcAbs, destAbs);
        result.copied = true;
      } catch (e) {
        result.error = `Copy failed: ${e instanceof Error ? e.message : String(e)}`;
      }

      return jsonResult(result);
    }
  );
}
