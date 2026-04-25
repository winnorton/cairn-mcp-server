import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import { expandTilde, jsonResult, safeReadText } from '../helpers.js';

interface Finding {
  file: string;
  pattern?: string;
  jsonPath?: string;
  value: string | string[];
  matches: boolean;
  occurrences?: number;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function scanReadme(text: string): { values: string[] } {
  const values: string[] = [];
  // Pattern 1: `@v0.10.8` (e.g. adopt URL pinning)
  const at = [...text.matchAll(/@v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  values.push(...at);
  // Pattern 2: `^v0.10.8 —` in Status section
  const status = [...text.matchAll(/^v(\d+\.\d+\.\d+)\s+—/gm)].map((m) => m[1]);
  values.push(...status);
  return { values: uniq(values) };
}

function scanAdopt(text: string): { values: string[]; occurrences: number } {
  const matches = [...text.matchAll(/cairn v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  return { values: uniq(matches), occurrences: matches.length };
}

function scanHandoff(text: string): { values: string[] } {
  const matches = [...text.matchAll(/Latest release:[^\n]*?v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  return { values: uniq(matches) };
}

function scanManifest(text: string): { value: string | null } {
  try {
    const json = JSON.parse(text);
    if (typeof json.version === 'string') return { value: json.version };
  } catch {
    // not JSON or no version field
  }
  return { value: null };
}

export function register(server: McpServer): void {
  server.tool(
    'check_version_consistency',
    'Scan a cairn-shape repo for matching version strings across VERSION, manifest.json, README.md, adopt.md, and HANDOFF.md. Files that do not exist are skipped silently. Returns the canonical version (from VERSION), per-file findings, and a list of mismatches.',
    {
      repo_path: z
        .string()
        .optional()
        .describe('Absolute path to the repo to scan. Defaults to the current working directory.'),
    },
    async ({ repo_path }) => {
      const repo = repo_path ? path.resolve(expandTilde(repo_path)) : process.cwd();

      // Source of truth: VERSION
      const versionPath = path.join(repo, 'VERSION');
      const versionText = safeReadText(versionPath);
      const canonical = versionText?.trim() || null;

      const findings: Finding[] = [];
      const mismatches: string[] = [];

      if (canonical !== null) {
        findings.push({
          file: 'VERSION',
          value: canonical,
          matches: true,
        });
      }

      // manifest.json
      const manifestPath = path.join(repo, 'manifest.json');
      const manifestText = safeReadText(manifestPath);
      if (manifestText !== null) {
        const { value } = scanManifest(manifestText);
        const matches = value === canonical;
        findings.push({
          file: 'manifest.json',
          jsonPath: '$.version',
          value: value ?? '(no .version field)',
          matches,
        });
        if (!matches) {
          mismatches.push(`manifest.json $.version=${value} (canonical=${canonical})`);
        }
      }

      // README.md
      const readmePath = path.join(repo, 'README.md');
      const readmeText = safeReadText(readmePath);
      if (readmeText !== null) {
        const { values } = scanReadme(readmeText);
        if (values.length === 0) {
          findings.push({
            file: 'README.md',
            pattern: '@v... or ^v... —',
            value: '(none found)',
            matches: true,
          });
        } else {
          for (const v of values) {
            const matches = v === canonical;
            findings.push({
              file: 'README.md',
              pattern: '@v... or ^v... —',
              value: v,
              matches,
            });
            if (!matches) {
              mismatches.push(`README.md found v${v} (canonical=${canonical})`);
            }
          }
        }
      }

      // adopt.md
      const adoptPath = path.join(repo, 'adopt.md');
      const adoptText = safeReadText(adoptPath);
      if (adoptText !== null) {
        const { values, occurrences } = scanAdopt(adoptText);
        if (values.length === 0) {
          findings.push({
            file: 'adopt.md',
            pattern: 'cairn v...',
            value: '(none found)',
            matches: true,
            occurrences: 0,
          });
        } else {
          for (const v of values) {
            const matches = v === canonical;
            findings.push({
              file: 'adopt.md',
              pattern: 'cairn v...',
              value: v,
              matches,
              occurrences,
            });
            if (!matches) {
              mismatches.push(`adopt.md found cairn v${v} (canonical=${canonical}) (${occurrences} total occurrences)`);
            }
          }
        }
      }

      // HANDOFF.md
      const handoffPath = path.join(repo, 'HANDOFF.md');
      const handoffText = safeReadText(handoffPath);
      if (handoffText !== null) {
        const { values } = scanHandoff(handoffText);
        if (values.length === 0) {
          findings.push({
            file: 'HANDOFF.md',
            pattern: 'Latest release: ... v...',
            value: '(none found)',
            matches: true,
          });
        } else {
          for (const v of values) {
            const matches = v === canonical;
            findings.push({
              file: 'HANDOFF.md',
              pattern: 'Latest release: ... v...',
              value: v,
              matches,
            });
            if (!matches) {
              mismatches.push(`HANDOFF.md "Latest release" v${v} (canonical=${canonical})`);
            }
          }
        }
      }

      return jsonResult({
        repo_path: repo,
        consistent: mismatches.length === 0,
        canonical_version: canonical,
        findings,
        mismatches,
      });
    }
  );
}
