import fs from 'fs';
import path from 'path';
import { safeReadText } from '../helpers.js';

const LAW_RE = /\[LAW\s+([a-zA-Z0-9_\-/.]+)\]/g;
const MEM_RE = /\[MEM\s+(user|feedback|project|reference)\/([a-zA-Z0-9_\-/.]+)\]/g;

export interface LawCitation {
  slug: string;
  file: string;
  line: number;
}

export interface MemCitation {
  type: 'user' | 'feedback' | 'project' | 'reference';
  name: string;
  file: string;
  line: number;
}

/** Walk a project for citation patterns, ignoring noisy directories. */
export function scanCitations(root: string): { laws: LawCitation[]; memory: MemCitation[]; files_scanned: number } {
  const laws: LawCitation[] = [];
  const memory: MemCitation[] = [];
  let scanned = 0;
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'dist-aot', 'dist-proxy', 'build', '.next', 'out', '.cache']);
  const allowedExts = new Set([
    '.md', '.mdx', '.txt',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.h',
    '.json', '.yml', '.yaml', '.toml',
  ]);

  function recur(dir: string, depth: number) {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (entry.name.startsWith('.')) {
          // Allow .claude (cairn lives here) but skip other dotdirs
          if (entry.name !== '.claude') continue;
        }
        recur(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!allowedExts.has(ext)) continue;
        scanned += 1;
        const text = safeReadText(full);
        if (!text) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Reset regex state per-line
          let m: RegExpExecArray | null;
          LAW_RE.lastIndex = 0;
          while ((m = LAW_RE.exec(line)) !== null) {
            laws.push({ slug: m[1], file: full, line: i + 1 });
          }
          MEM_RE.lastIndex = 0;
          while ((m = MEM_RE.exec(line)) !== null) {
            memory.push({
              type: m[1] as 'user' | 'feedback' | 'project' | 'reference',
              name: m[2],
              file: full,
              line: i + 1,
            });
          }
        }
      }
    }
  }
  recur(root, 0);
  return { laws, memory, files_scanned: scanned };
}

/** Group hits by slug/name and return aggregated stats. */
export function aggregateLawHits(hits: LawCitation[]): Array<{ slug: string; citation_count: number; files: string[] }> {
  const map = new Map<string, { count: number; files: Set<string> }>();
  for (const h of hits) {
    const e = map.get(h.slug) || { count: 0, files: new Set<string>() };
    e.count += 1;
    e.files.add(h.file);
    map.set(h.slug, e);
  }
  return Array.from(map.entries()).map(([slug, v]) => ({
    slug,
    citation_count: v.count,
    files: Array.from(v.files),
  }));
}

export function aggregateMemHits(
  hits: MemCitation[]
): Array<{ type: string; name: string; citation_count: number; files: string[] }> {
  const map = new Map<string, { type: string; name: string; count: number; files: Set<string> }>();
  for (const h of hits) {
    const key = `${h.type}/${h.name}`;
    const e = map.get(key) || { type: h.type, name: h.name, count: 0, files: new Set<string>() };
    e.count += 1;
    e.files.add(h.file);
    map.set(key, e);
  }
  return Array.from(map.values()).map((v) => ({
    type: v.type,
    name: v.name,
    citation_count: v.count,
    files: Array.from(v.files),
  }));
}
