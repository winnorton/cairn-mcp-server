import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { expandTilde, jsonResult } from '../helpers.js';
import { loadTranscript } from '../helpers/transcript.js';

interface RetrospectiveHit {
  transcript_path: string;
  ts: string;
  context: string;
  would_have_helped_because: string;
}

interface LessonReplayResult {
  lesson: { slug?: string; name?: string; body_excerpt: string };
  scope_scanned: { project_count: number; transcript_count: number; since: string | null };
  retrospective_hits: RetrospectiveHit[];
  total_hits: number;
  lesson_value_estimate: string;
}

/** Stop-words we strip when extracting keywords. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'and', 'or', 'but', 'not', 'if', 'then', 'else', 'when', 'where', 'why', 'how',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'with', 'without', 'about', 'into', 'onto', 'from', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'as', 'so', 'than', 'too', 'very', 'can', 'just', 'also', 'use', 'using', 'used',
  'before', 'after', 'over', 'under', 'between', 'must', 'may',
  'agent', 'lesson', 'memory', 'cairn', 'instead',
]);

/** Pull keywords from a lesson body. Heuristic: short tokens, stop-words removed,
 *  plus quoted phrases preserved as multi-word keys. */
function extractKeywords(body: string): { keywords: string[]; phrases: string[] } {
  const phrases: string[] = [];
  // Backtick `code`
  const backtickRe = /`([^`\n]{2,80})`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(body)) !== null) {
    phrases.push(m[1].toLowerCase());
  }
  // Double-quoted "text"
  const dqRe = /"([^"\n]{2,80})"/g;
  while ((m = dqRe.exec(body)) !== null) {
    phrases.push(m[1].toLowerCase());
  }

  const tokens = body
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .split(/[\s,;:.()\[\]{}<>!?]+/)
    .map((t) => t.replace(/^[`'"-]+|[`'".,;:!?-]+$/g, ''))
    .filter((t) => t.length >= 3 && t.length <= 32 && !STOPWORDS.has(t));

  const tokenCounts = new Map<string, number>();
  for (const t of tokens) tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
  const keywords = Array.from(tokenCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([t]) => t);

  return { keywords, phrases };
}

/** Score a single tool call for whether the lesson "would have helped".
 *  Returns hit description if matched, null otherwise. */
function scoreToolCall(
  call: { tool: string; args?: unknown; ts: string },
  keywords: string[],
  phrases: string[]
): string | null {
  const haystack = (call.tool + ' ' + JSON.stringify(call.args ?? '')).toLowerCase();
  for (const p of phrases) {
    if (p.length >= 3 && haystack.includes(p)) {
      return `tool=${call.tool} args contains phrase "${p}"`;
    }
  }
  let kwHits = 0;
  const matched: string[] = [];
  for (const k of keywords) {
    if (haystack.includes(k)) {
      kwHits += 1;
      matched.push(k);
      if (kwHits >= 3) break;
    }
  }
  if (kwHits >= 2) {
    return `tool=${call.tool} matched keywords [${matched.join(', ')}]`;
  }
  return null;
}

function discoverProjectSlugs(home: string): string[] {
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  try {
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function findTranscriptsForSlug(home: string, slug: string, sinceMs: number): string[] {
  const out: string[] = [];
  // Probe likely transcript locations under the project's claude scope
  const probeRoots = [
    path.join(home, '.claude', 'projects', slug),
    path.join(home, '.claude', 'projects', slug, 'transcripts'),
    path.join(home, '.claude', 'projects', slug, 'sessions'),
  ];
  for (const root of probeRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        const lower = e.name.toLowerCase();
        if (!(lower.endsWith('.jsonl') || lower.endsWith('.ndjson'))) continue;
        const full = path.join(root, e.name);
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= sinceMs) out.push(full);
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  return out;
}

export function register(server: McpServer): void {
  server.tool(
    'lesson_replay',
    'Given a lesson (memory entry body or law text), retrospectively scan past session transcripts in scope for moments where the lesson would have applied. Heuristic: extracts keywords + quoted phrases from the lesson, scans transcript tool calls for matches, returns hits with context. Useful for estimating the value of a candidate lesson before promoting it to LAWS.md.',
    {
      lesson: z.object({
        slug: z.string().optional().describe('Lesson slug if it has been promoted to LAWS.'),
        name: z.string().optional().describe('Memory entry name (e.g. "load_meta_laws_before_building").'),
        body: z.string().describe('The lesson text body to extract keywords from.'),
      }),
      scope: z
        .enum(['this_project', 'all_projects'])
        .optional()
        .default('this_project')
        .describe("Scan only the current project's transcripts or all projects under ~/.claude/projects."),
      since: z
        .string()
        .optional()
        .describe('ISO date; only scan transcripts modified on or after this date.'),
    },
    async ({ lesson, scope, since }) => {
      const home = os.homedir();
      const sinceMs = since ? Date.parse(since) : 0;
      const sinceLabel = since && !Number.isNaN(sinceMs) ? since : null;

      let slugs: string[];
      if (scope === 'all_projects') {
        slugs = discoverProjectSlugs(home);
      } else {
        // this_project: derive slug from cwd
        const cwdSlug = process.cwd().replace(/[\\/:]/g, '-');
        slugs = [cwdSlug];
      }

      const transcripts: string[] = [];
      for (const slug of slugs) {
        transcripts.push(...findTranscriptsForSlug(home, slug, sinceMs));
      }

      const { keywords, phrases } = extractKeywords(lesson.body);
      const hits: RetrospectiveHit[] = [];

      for (const tp of transcripts) {
        const t = loadTranscript(tp);
        if (t.format === 'unknown' || t.format === 'protobuf-antigravity') continue;
        for (const call of t.tool_calls) {
          const why = scoreToolCall(call, keywords, phrases);
          if (why) {
            hits.push({
              transcript_path: tp,
              ts: call.ts,
              context: `${call.tool}(${truncateArgs(call.args)})`,
              would_have_helped_because: why,
            });
          }
        }
      }

      // Limit hits to a reasonable size for return payload
      const cap = 200;
      const cappedHits = hits.slice(0, cap);

      const result: LessonReplayResult = {
        lesson: {
          slug: lesson.slug,
          name: lesson.name,
          body_excerpt: lesson.body.slice(0, 240),
        },
        scope_scanned: {
          project_count: slugs.length,
          transcript_count: transcripts.length,
          since: sinceLabel,
        },
        retrospective_hits: cappedHits,
        total_hits: hits.length,
        lesson_value_estimate:
          hits.length === 0
            ? `No retrospective hits — lesson may not apply to this scope, or keywords didn't match recent activity.`
            : `Would have flagged ${hits.length} moment(s) across ${transcripts.length} transcript(s) in ${slugs.length} project(s).`,
      };
      if (hits.length > cap) {
        (result as { truncated_note?: string }).truncated_note = `${hits.length - cap} hits omitted; showing first ${cap}.`;
      }

      return jsonResult(result);
    }
  );
}

function truncateArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > 120 ? s.slice(0, 120) + '...' : s;
}
