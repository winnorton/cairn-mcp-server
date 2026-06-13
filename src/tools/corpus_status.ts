/**
 * corpus_status.ts — WS-09 (HIVE_CONTEXT_SESSIONS)
 *
 * Diagnostic tool: scan cairn-sessions/normalized/** and findings/** and report
 * coverage (per-harness session counts, distilled-vs-undistilled, ledger size,
 * last-distilled). Owns the diagnostics cross-cutting axis for WS-09.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { expandTilde, jsonResult, safeStat } from '../helpers.js';
import type { Finding } from './findings_ledger.js';

// ---------------------------------------------------------------------------
// Internal scan helpers
// ---------------------------------------------------------------------------

interface EnvelopeSummary {
  session_id: string;
  harness: string;
  project_slug: string;
  envelope_path: string;
  started_at: string | null;
  event_count: number;
  has_findings: boolean;
}

interface CorpusStatusResult {
  corpus_root: string;
  scanned_at: string;
  envelopes: {
    total: number;
    by_harness: Record<string, number>;
    by_project: Record<string, number>;
    distilled: number;
    undistilled: number;
    sessions: EnvelopeSummary[];
  };
  findings: {
    total: number;
    last_distilled: string | null;
    ledger_exists: boolean;
    ledger_row_count: number;
    pattern_catalog: string[];  // unique pattern names across all findings
  };
  schema: {
    envelope_schema_exists: boolean;
    finding_schema_exists: boolean;
    manifest_exists: boolean;
  };
  error: string | null;
}

function scanEnvelopes(normalizedRoot: string, findingIds: Set<string>): EnvelopeSummary[] {
  const summaries: EnvelopeSummary[] = [];
  if (!fs.existsSync(normalizedRoot)) return summaries;

  // Layout: normalized/<harness>/<project_slug>/<id>.envelope.json
  let harnessEntries: fs.Dirent[];
  try {
    harnessEntries = fs.readdirSync(normalizedRoot, { withFileTypes: true });
  } catch {
    return summaries;
  }

  for (const he of harnessEntries) {
    if (!he.isDirectory()) continue;
    const harnessName = he.name;
    const harnessDir = path.join(normalizedRoot, harnessName);

    let projectEntries: fs.Dirent[];
    try {
      projectEntries = fs.readdirSync(harnessDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const pe of projectEntries) {
      if (!pe.isDirectory()) continue;
      const projectSlug = pe.name;
      const projectDir = path.join(harnessDir, projectSlug);

      let envFiles: fs.Dirent[];
      try {
        envFiles = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const ef of envFiles) {
        if (!ef.isFile() || !ef.name.endsWith('.envelope.json')) continue;
        const envPath = path.join(projectDir, ef.name);
        const sessionId = ef.name.replace(/\.envelope\.json$/, '');

        let startedAt: string | null = null;
        let eventCount = 0;

        try {
          const raw = fs.readFileSync(envPath, 'utf-8');
          const env = JSON.parse(raw);
          startedAt = env?.session?.started_at ?? null;
          eventCount = Array.isArray(env?.events) ? env.events.length : 0;
        } catch {
          // envelope unreadable — still surface it in the count
        }

        summaries.push({
          session_id: sessionId,
          harness: harnessName,
          project_slug: projectSlug,
          envelope_path: envPath,
          started_at: startedAt,
          event_count: eventCount,
          has_findings: findingIds.has(sessionId),
        });
      }
    }
  }

  return summaries;
}

function scanFindings(findingsDir: string): {
  ids: Set<string>;
  lastDistilled: string | null;
  patternCatalog: string[];
} {
  const ids = new Set<string>();
  let lastDistilled: string | null = null;
  const patternNames = new Set<string>();

  if (!fs.existsSync(findingsDir)) return { ids, lastDistilled, patternCatalog: [] };

  let entries: string[];
  try {
    entries = fs.readdirSync(findingsDir).filter((f) => f.endsWith('.findings.json'));
  } catch {
    return { ids, lastDistilled, patternCatalog: [] };
  }

  for (const fname of entries) {
    const fpath = path.join(findingsDir, fname);
    const sessionId = fname.replace(/\.findings\.json$/, '');
    ids.add(sessionId);

    try {
      const raw = fs.readFileSync(fpath, 'utf-8');
      const finding: Finding = JSON.parse(raw);
      if (finding.distilled_at) {
        if (!lastDistilled || finding.distilled_at > lastDistilled) {
          lastDistilled = finding.distilled_at;
        }
      }
      for (const p of finding.patterns ?? []) {
        if (p.name && p.instance_count > 0) patternNames.add(p.name);
      }
    } catch {
      // skip corrupted
    }
  }

  return { ids, lastDistilled, patternCatalog: Array.from(patternNames).sort() };
}

function countLedgerRows(ledgerPath: string): number {
  if (!fs.existsSync(ledgerPath)) return 0;
  try {
    const text = fs.readFileSync(ledgerPath, 'utf-8');
    // Count pipe-delimited rows that start with '| ' but are not the header or separator rows
    const lines = text.split(/\r?\n/);
    return lines.filter((l) => l.startsWith('| ') && !l.startsWith('| session_id') && !l.startsWith('|---')).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function register(server: McpServer): void {
  server.tool(
    'corpus_status',
    '[WS-09] Diagnostic: scan the cairn-sessions corpus (normalized/ + findings/) and report coverage — per-harness session counts, distilled-vs-undistilled ratio, ledger size, last-distilled timestamp, accumulated pattern catalog. Accepts an explicit corpus_root or defaults to ~/projects/cairn/cairn-sessions.',
    {
      corpus_root: z
        .string()
        .optional()
        .describe('Absolute path to the cairn-sessions corpus root. Defaults to ~/projects/cairn/cairn-sessions.'),
      include_session_list: z
        .boolean()
        .optional()
        .default(false)
        .describe('When true, include the full per-session list in the output (can be large). Defaults to false (counts only).'),
    },
    async ({ corpus_root, include_session_list }) => {
      const resolvedRoot = corpus_root
        ? path.resolve(expandTilde(corpus_root))
        : path.join(process.env.USERPROFILE || process.env.HOME || '', 'projects', 'cairn', 'cairn-sessions');

      const result: CorpusStatusResult = {
        corpus_root: resolvedRoot,
        scanned_at: new Date().toISOString(),
        envelopes: {
          total: 0,
          by_harness: {},
          by_project: {},
          distilled: 0,
          undistilled: 0,
          sessions: [],
        },
        findings: {
          total: 0,
          last_distilled: null,
          ledger_exists: false,
          ledger_row_count: 0,
          pattern_catalog: [],
        },
        schema: {
          envelope_schema_exists: false,
          finding_schema_exists: false,
          manifest_exists: false,
        },
        error: null,
      };

      const rootStat = safeStat(resolvedRoot);
      if (!rootStat || !rootStat.isDirectory()) {
        result.error = `corpus_root not found or not a directory: ${resolvedRoot}`;
        return jsonResult(result);
      }

      try {
        // Schema presence checks
        result.schema.envelope_schema_exists = fs.existsSync(path.join(resolvedRoot, 'schema', 'envelope.schema.json'));
        result.schema.finding_schema_exists = fs.existsSync(path.join(resolvedRoot, 'schema', 'finding.schema.json'));
        result.schema.manifest_exists = fs.existsSync(path.join(resolvedRoot, 'MANIFEST.md'));

        // Findings scan (first, so we can annotate envelopes with has_findings)
        const findingsDir = path.join(resolvedRoot, 'findings');
        const ledgerFilePath = path.join(findingsDir, 'LEDGER.md');
        const { ids: findingIds, lastDistilled, patternCatalog } = scanFindings(findingsDir);
        result.findings.total = findingIds.size;
        result.findings.last_distilled = lastDistilled;
        result.findings.ledger_exists = fs.existsSync(ledgerFilePath);
        result.findings.ledger_row_count = countLedgerRows(ledgerFilePath);
        result.findings.pattern_catalog = patternCatalog;

        // Envelope scan
        const normalizedRoot = path.join(resolvedRoot, 'normalized');
        const sessions = scanEnvelopes(normalizedRoot, findingIds);
        result.envelopes.total = sessions.length;
        result.envelopes.distilled = sessions.filter((s) => s.has_findings).length;
        result.envelopes.undistilled = sessions.filter((s) => !s.has_findings).length;

        for (const s of sessions) {
          result.envelopes.by_harness[s.harness] = (result.envelopes.by_harness[s.harness] ?? 0) + 1;
          result.envelopes.by_project[s.project_slug] = (result.envelopes.by_project[s.project_slug] ?? 0) + 1;
        }

        if (include_session_list) {
          result.envelopes.sessions = sessions;
        }
      } catch (e) {
        result.error = `scan failed: ${e instanceof Error ? e.message : String(e)}`;
      }

      return jsonResult(result);
    }
  );
}
