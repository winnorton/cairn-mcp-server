import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import {
  expandTilde,
  jsonResult,
  pathToSlug,
  safeStat,
  walkFiles,
} from '../helpers.js';
import { aggregateLawHits, aggregateMemHits, scanCitations } from '../helpers/citations.js';

interface LawSummary {
  slug: string;
  citation_count: number;
  last_cited_iso: string | null;
  files: string[];
}

interface MemSummary {
  type: string;
  name: string;
  citation_count: number;
  last_cited_iso: string | null;
  files: string[];
}

interface HabitatProgressResult {
  scope: { project_path: string; slug: string; since: string | null; files_scanned: number };
  laws: LawSummary[];
  memory: MemSummary[];
  stale_entries: Array<{ kind: 'law' | 'memory'; name: string; last_seen: string | null; suggestion: string }>;
  hot_entries: Array<{ kind: 'law' | 'memory'; name: string; citation_count: number; suggestion: string }>;
  unused_candidates: Array<{ kind: 'law' | 'memory'; name: string; exists_at: string; suggestion: string }>;
}

function collectExistingMemoryEntries(home: string, slug: string): Array<{ type: string; name: string; path: string }> {
  const out: Array<{ type: string; name: string; path: string }> = [];
  const roots = [
    path.join(home, '.claude', 'projects', slug, 'memory'),
    path.join(home, '.claude', 'memory'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const f of walkFiles(root)) {
      if (!f.endsWith('.md')) continue;
      const rel = path.relative(root, f).replace(/\\/g, '/');
      const parts = rel.split('/');
      if (parts.length < 2) continue;
      const type = parts[0];
      const name = parts.slice(1).join('/').replace(/\.md$/, '');
      if (!['user', 'feedback', 'project', 'reference'].includes(type)) continue;
      out.push({ type, name, path: f });
    }
  }
  return out;
}

function collectExistingLaws(projectPath: string, home: string, slug: string): Array<{ slug: string; path: string }> {
  const candidates: Array<{ slug: string; path: string }> = [];
  // Cairn's LAWS.md lives at a few canonical spots; search project + memory roots.
  const lawsLikePaths = [
    path.join(projectPath, 'LAWS.md'),
    path.join(projectPath, 'docs', 'LAWS.md'),
    path.join(home, '.claude', 'projects', slug, 'LAWS.md'),
    path.join(home, '.claude', 'LAWS.md'),
  ];
  for (const lp of lawsLikePaths) {
    if (!fs.existsSync(lp)) continue;
    let text: string;
    try {
      text = fs.readFileSync(lp, 'utf-8');
    } catch {
      continue;
    }
    // Cairn law headers look like `## <slug>` or `### <slug>` (slug-cased).
    const headerRe = /^#{2,4}\s+([a-z][a-z0-9_\-]+)\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(text)) !== null) {
      candidates.push({ slug: m[1], path: lp });
    }
  }
  return candidates;
}

function lastCommitTouchingFile(projectPath: string, file: string): string | null {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function lastCitedIsoFor(files: string[]): string | null {
  let max = 0;
  for (const f of files) {
    const st = safeStat(f);
    if (st && st.mtimeMs > max) max = st.mtimeMs;
  }
  return max > 0 ? new Date(max).toISOString() : null;
}

export function register(server: McpServer): void {
  server.tool(
    'habitat_progress',
    "Longitudinal citation accounting for a cairn habitat. Greps the project source + memory for [LAW <slug>] and [MEM <type>/<name>] patterns and aggregates: per-law/per-entry citation counts, last citation date, files cited in. Identifies stale (low/zero citations in window), hot (cited often), and unused candidates (entries that exist but were never cited). Defaults to cwd's project + its slug.",
    {
      project_path: z.string().optional().describe('Absolute path to the project. Defaults to cwd.'),
      since: z
        .string()
        .optional()
        .describe('ISO date; restrict citation files to those modified on/after this date.'),
      slugs: z
        .array(z.string())
        .optional()
        .describe('Optional explicit project slugs (otherwise derived from project_path).'),
    },
    async ({ project_path, since, slugs }) => {
      const projectPath = project_path ? path.resolve(expandTilde(project_path)) : process.cwd();
      const home = os.homedir();
      const slug = slugs && slugs.length > 0 ? slugs[0] : pathToSlug(projectPath);
      const sinceMs = since ? Date.parse(since) : 0;
      const sinceLabel = since && !Number.isNaN(sinceMs) ? since : null;

      // 1. Scan citations within the project tree
      const projectScan = scanCitations(projectPath);
      // 2. Also scan the project-scoped memory root (citations often live in MEMORY.md)
      const memRoot = path.join(home, '.claude', 'projects', slug, 'memory');
      const memScan = fs.existsSync(memRoot) ? scanCitations(memRoot) : { laws: [], memory: [], files_scanned: 0 };

      // Filter both by since (file mtime)
      const filterByMtime = <T extends { file: string }>(items: T[]) =>
        sinceMs === 0
          ? items
          : items.filter((it) => {
              const st = safeStat(it.file);
              return st ? st.mtimeMs >= sinceMs : false;
            });

      const lawHits = [...filterByMtime(projectScan.laws), ...filterByMtime(memScan.laws)];
      const memHits = [...filterByMtime(projectScan.memory), ...filterByMtime(memScan.memory)];

      const lawAgg = aggregateLawHits(lawHits);
      const memAgg = aggregateMemHits(memHits);

      const laws: LawSummary[] = lawAgg.map((a) => ({
        slug: a.slug,
        citation_count: a.citation_count,
        last_cited_iso:
          lastCitedIsoFor(a.files) ||
          (a.files.length > 0 ? lastCommitTouchingFile(projectPath, a.files[0]) : null),
        files: a.files,
      }));
      const memory: MemSummary[] = memAgg.map((a) => ({
        type: a.type,
        name: a.name,
        citation_count: a.citation_count,
        last_cited_iso:
          lastCitedIsoFor(a.files) ||
          (a.files.length > 0 ? lastCommitTouchingFile(projectPath, a.files[0]) : null),
        files: a.files,
      }));

      // 3. Compare against existing entries to find unused candidates
      const existingMem = collectExistingMemoryEntries(home, slug);
      const citedMemKeys = new Set(memory.map((m) => `${m.type}/${m.name}`));
      const unusedMem = existingMem
        .filter((e) => !citedMemKeys.has(`${e.type}/${e.name}`))
        .map((e) => ({
          kind: 'memory' as const,
          name: `${e.type}/${e.name}`,
          exists_at: e.path,
          suggestion: `Memory entry exists but was never cited [${e.type}/${e.name}]. Either add citations in code/docs to make it discoverable, or remove if obsolete.`,
        }));

      const existingLaws = collectExistingLaws(projectPath, home, slug);
      const citedLawSlugs = new Set(laws.map((l) => l.slug));
      const unusedLaws = existingLaws
        .filter((e) => !citedLawSlugs.has(e.slug))
        .map((e) => ({
          kind: 'law' as const,
          name: e.slug,
          exists_at: e.path,
          suggestion: `Law [${e.slug}] is defined but never cited. Either cite it from code/docs or consider demoting back to feedback.`,
        }));

      // 4. Stale and hot classification
      const stale_entries: HabitatProgressResult['stale_entries'] = [];
      const hot_entries: HabitatProgressResult['hot_entries'] = [];
      const STALE_THRESHOLD_DAYS = 60;
      const HOT_THRESHOLD = 5;
      const nowMs = Date.now();

      for (const l of laws) {
        const lastMs = l.last_cited_iso ? Date.parse(l.last_cited_iso) : 0;
        const ageDays = lastMs > 0 ? (nowMs - lastMs) / (86400 * 1000) : Infinity;
        if (l.citation_count <= 1 || ageDays > STALE_THRESHOLD_DAYS) {
          stale_entries.push({
            kind: 'law',
            name: l.slug,
            last_seen: l.last_cited_iso,
            suggestion: `Law [${l.slug}] cited only ${l.citation_count}x. Either reinforce by citing more, or consider demoting if it's not load-bearing.`,
          });
        }
        if (l.citation_count >= HOT_THRESHOLD) {
          hot_entries.push({
            kind: 'law',
            name: l.slug,
            citation_count: l.citation_count,
            suggestion: `Law [${l.slug}] is heavily cited (${l.citation_count}x). Confirm it stays in LAWS.md (don't demote).`,
          });
        }
      }
      for (const m of memory) {
        const lastMs = m.last_cited_iso ? Date.parse(m.last_cited_iso) : 0;
        const ageDays = lastMs > 0 ? (nowMs - lastMs) / (86400 * 1000) : Infinity;
        if (m.citation_count <= 1 || ageDays > STALE_THRESHOLD_DAYS) {
          stale_entries.push({
            kind: 'memory',
            name: `${m.type}/${m.name}`,
            last_seen: m.last_cited_iso,
            suggestion: `Memory [${m.type}/${m.name}] cited only ${m.citation_count}x. Verify still relevant.`,
          });
        }
        if (m.citation_count >= HOT_THRESHOLD) {
          hot_entries.push({
            kind: 'memory',
            name: `${m.type}/${m.name}`,
            citation_count: m.citation_count,
            suggestion: `Memory [${m.type}/${m.name}] cited ${m.citation_count}x — candidate for promotion to LAWS.md (forcing-function rule).`,
          });
        }
      }

      const result: HabitatProgressResult = {
        scope: {
          project_path: projectPath,
          slug,
          since: sinceLabel,
          files_scanned: projectScan.files_scanned + memScan.files_scanned,
        },
        laws,
        memory,
        stale_entries,
        hot_entries,
        unused_candidates: [...unusedLaws, ...unusedMem],
      };
      return jsonResult(result);
    }
  );
}
