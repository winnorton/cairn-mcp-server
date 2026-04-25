import os from 'os';
import path from 'path';
import fs from 'fs';

/** Expand a leading `~` to the user's home directory. */
export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Convert an absolute path to a cairn project slug.
 *  Replaces every `\`, `/`, and `:` with `-`.
 *  Example: `C:\Users\winno\projects\foo` -> `C--Users-winno-projects-foo`.
 */
export function pathToSlug(absPath: string): string {
  return absPath.replace(/[\\/:]/g, '-');
}

/** Best-effort reverse: slug -> candidate paths.
 *  Windows pattern: `^([A-Z])--(.+)$` -> `${1}:\${rest with - -> \}`.
 *  Unix pattern: leading `-` becomes `/`, then remaining `-` -> `/`.
 *  Returns ALL candidates (caller may filter by existence).
 */
export function slugToCandidates(slug: string): string[] {
  const candidates: string[] = [];

  // Windows-style: `C--Users-winno-projects-foo` -> `C:\Users\winno\projects\foo`
  const winMatch = slug.match(/^([A-Za-z])--(.+)$/);
  if (winMatch) {
    const drive = winMatch[1];
    const rest = winMatch[2];
    candidates.push(`${drive}:\\${rest.replace(/-/g, '\\')}`);
    candidates.push(`${drive}:/${rest.replace(/-/g, '/')}`);
  }

  // Unix-style: leading `-` is the root; subsequent `-` becomes `/`
  if (slug.startsWith('-')) {
    candidates.push('/' + slug.slice(1).replace(/-/g, '/'));
  } else {
    // Naive Unix: every `-` becomes `/` (no leading slash)
    candidates.push(slug.replace(/-/g, '/'));
  }

  return candidates;
}

/** Format a duration in seconds as a human-readable "Nx ago" string. */
export function humanizeAge(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 60) return `${Math.round(abs)}s ago`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ago`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ago`;
  if (abs < 86400 * 7) return `${Math.round(abs / 86400)}d ago`;
  if (abs < 86400 * 30) return `${Math.round(abs / 86400 / 7)}w ago`;
  if (abs < 86400 * 365) return `${Math.round(abs / 86400 / 30)}mo ago`;
  return `${Math.round(abs / 86400 / 365)}y ago`;
}

/** ISO timestamp without milliseconds, e.g. `2026-04-25T14:32:00Z`. */
export function isoNow(): string {
  return new Date().toISOString();
}

/** Human timestamp, e.g. `2026-04-25 14:32 UTC`. */
export function humanTimeUtc(d: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Safely stat a path; return null if it doesn't exist. */
export function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Read a text file, returning null on any error. */
export function safeReadText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/** Walk a directory tree, returning all files (not dirs). Bounded depth. */
export function walkFiles(root: string, maxDepth = 8): string[] {
  const out: string[] = [];
  function recur(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        recur(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  recur(root, 0);
  return out;
}

/** Convert a tool result to the MCP content envelope. */
export function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
