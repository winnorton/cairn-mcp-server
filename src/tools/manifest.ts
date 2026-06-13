/**
 * manifest — WS 08 (HIVE_CONTEXT_SESSIONS).
 *
 * Generates <corpusRoot>/MANIFEST.md from all *.envelope.json files under
 * normalized/**. One row per envelope per §2.3:
 *
 *   id | harness | project_slug | model | started_at | event_count |
 *   tool_call_count | distilled | findings_ref | redaction_hits
 *
 * Header includes per-harness coverage counts (telemetry).
 * Also emits <corpusRoot>/schema/manifest-row.schema.json.
 *
 * Uniqueness check (CI-ready): verifies no two envelopes share an `id`.
 *
 * MCP tool shape follows the pattern in session_distill.ts.
 *
 * DO NOT edit src/tools/index.ts — see the registration comment in gather.ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { jsonResult } from '../helpers.js';
import type { Envelope } from '../adapters/types.js';

// ---------------------------------------------------------------------------
// manifest-row.schema.json (emitted alongside MANIFEST.md)
// ---------------------------------------------------------------------------

export const MANIFEST_ROW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/winnorton/cairn-sessions/schema/manifest-row.schema.json',
  title: 'CairnManifestRow',
  description:
    'One row in MANIFEST.md — a machine-readable summary of a single normalized session envelope. Per §2.3 of SPEC_HIVE_CONTEXT_SESSIONS_00_PROGRAM.',
  type: 'object',
  required: [
    'id',
    'harness',
    'project_slug',
    'model',
    'started_at',
    'event_count',
    'tool_call_count',
    'distilled',
    'findings_ref',
    'redaction_hits',
  ],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description: 'Session UUID — unique across all envelopes in the corpus.',
    },
    harness: {
      type: 'string',
      enum: ['claude-code', 'pi', 'antigravity'],
      description: 'Source harness name.',
    },
    project_slug: {
      type: 'string',
      description: 'Project slug derived from cwd or harness metadata.',
    },
    model: {
      type: ['string', 'null'],
      description: 'Model name/id used in this session.',
    },
    started_at: {
      type: ['string', 'null'],
      description: 'ISO-8601 timestamp of first event.',
    },
    event_count: {
      type: 'integer',
      minimum: 0,
      description: 'Total events[] length in the envelope.',
    },
    tool_call_count: {
      type: 'integer',
      minimum: 0,
      description: 'Number of events with type == "tool_call".',
    },
    distilled: {
      type: 'boolean',
      description: 'Whether a findings/<id>.findings.json exists for this session.',
    },
    findings_ref: {
      type: ['string', 'null'],
      description: 'Relative path to findings file, or null if not yet distilled.',
    },
    redaction_hits: {
      type: 'integer',
      minimum: 0,
      description: 'Number of secrets redacted (session.redaction.hits).',
    },
  },
};

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface ManifestRow {
  id: string;
  harness: string;
  project_slug: string;
  model: string | null;
  started_at: string | null;
  event_count: number;
  tool_call_count: number;
  distilled: boolean;
  findings_ref: string | null;
  redaction_hits: number;
  /** Internal: absolute path to the envelope file (not in schema output) */
  _envelope_path: string;
}

// ---------------------------------------------------------------------------
// Corpus scanning
// ---------------------------------------------------------------------------

/**
 * Walk <corpusRoot>/normalized/**\/*.envelope.json and return parsed rows.
 * Skips unreadable or unparseable files (logs them to `errors`).
 */
export function scanEnvelopes(
  corpusRoot: string,
): { rows: ManifestRow[]; errors: Array<{ path: string; error: string }> } {
  const normalizedRoot = path.join(corpusRoot, 'normalized');
  const rows: ManifestRow[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  if (!fs.existsSync(normalizedRoot)) {
    return { rows, errors };
  }

  // Walk up to depth=3: normalized/<harness>/<project_slug>/<id>.envelope.json
  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.envelope.json')) {
        try {
          const raw = fs.readFileSync(full, 'utf-8');
          const env = JSON.parse(raw) as Envelope;
          const toolCalls = (env.events ?? []).filter((e) => e.type === 'tool_call').length;
          // Check for findings
          const findingsPath = path.join(corpusRoot, 'findings', `${env.session.id}.findings.json`);
          const hasFindings = fs.existsSync(findingsPath);
          rows.push({
            id: env.session.id,
            harness: env.session.harness,
            project_slug: env.session.project_slug,
            model: env.session.model,
            started_at: env.session.started_at,
            event_count: (env.events ?? []).length,
            tool_call_count: toolCalls,
            distilled: hasFindings,
            findings_ref: hasFindings ? path.join('findings', `${env.session.id}.findings.json`) : null,
            redaction_hits: env.session.redaction.hits,
            _envelope_path: full,
          });
        } catch (err) {
          errors.push({
            path: full,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  walk(normalizedRoot, 0);

  // Sort by started_at ascending (nulls last), then by id for determinism
  rows.sort((a, b) => {
    const ta = a.started_at ?? '';
    const tb = b.started_at ?? '';
    if (ta !== tb) return ta.localeCompare(tb);
    return a.id.localeCompare(b.id);
  });

  return { rows, errors };
}

// ---------------------------------------------------------------------------
// Uniqueness check
// ---------------------------------------------------------------------------

/**
 * Returns duplicate id groups. Empty array = all ids unique.
 * Used by CI gate per §6 (federation-dedup risk).
 */
export function checkUniqueness(rows: ManifestRow[]): Array<{ id: string; paths: string[] }> {
  const seen = new Map<string, string[]>();
  for (const row of rows) {
    const existing = seen.get(row.id) ?? [];
    existing.push(row._envelope_path);
    seen.set(row.id, existing);
  }
  const dupes: Array<{ id: string; paths: string[] }> = [];
  for (const [id, paths] of seen.entries()) {
    if (paths.length > 1) dupes.push({ id, paths });
  }
  return dupes;
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

function escapeCell(s: string | null | boolean | number): string {
  if (s === null || s === undefined) return '';
  const str = String(s);
  return str.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  // Trim to YYYY-MM-DDTHH:MM
  return iso.slice(0, 16).replace('T', ' ');
}

/**
 * Generate MANIFEST.md content from a list of rows.
 */
export function generateManifestMd(
  rows: ManifestRow[],
  generatedAt: string,
): string {
  // Per-harness counts
  const harnessCount: Record<string, number> = {};
  let distilledCount = 0;
  let totalRedactionHits = 0;
  for (const row of rows) {
    harnessCount[row.harness] = (harnessCount[row.harness] ?? 0) + 1;
    if (row.distilled) distilledCount++;
    totalRedactionHits += row.redaction_hits;
  }

  const harnessLines = (['claude-code', 'pi', 'antigravity'] as const)
    .map((h) => `- **${h}**: ${harnessCount[h] ?? 0} session(s)`)
    .join('\n');

  const header = [
    '# MANIFEST',
    '',
    '**Auto-generated by WS 08 (`cairn-mcp-server` gather/manifest step).** Do not edit by hand.',
    '',
    'One row per committed normalized envelope. The row count must equal the number of',
    '`*.envelope.json` files under `normalized/` (enforced by CI gate — WS 08/10).',
    '',
    `_Generated: ${generatedAt}_`,
    '',
    '## Coverage',
    '',
    harnessLines,
    `- **Total**: ${rows.length} session(s)`,
    `- **Distilled**: ${distilledCount} / ${rows.length}`,
    `- **Total redaction hits**: ${totalRedactionHits}`,
    '',
  ].join('\n');

  const tableHeader = [
    '<!-- BEGIN MANIFEST TABLE -->',
    '| id | harness | project_slug | model | started_at | event_count | tool_call_count | distilled | findings_ref | redaction_hits |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ].join('\n');

  const tableRows = rows
    .map((row) => {
      const findingsCell = row.findings_ref
        ? `[findings](${row.findings_ref})`
        : '';
      return (
        `| ${escapeCell(row.id)} ` +
        `| ${escapeCell(row.harness)} ` +
        `| ${escapeCell(row.project_slug)} ` +
        `| ${escapeCell(row.model)} ` +
        `| ${escapeCell(formatDate(row.started_at))} ` +
        `| ${escapeCell(row.event_count)} ` +
        `| ${escapeCell(row.tool_call_count)} ` +
        `| ${escapeCell(row.distilled)} ` +
        `| ${escapeCell(findingsCell)} ` +
        `| ${escapeCell(row.redaction_hits)} |`
      );
    })
    .join('\n');

  const tableFooter = '<!-- END MANIFEST TABLE -->';

  if (rows.length === 0) {
    return (
      header +
      tableHeader +
      '\n' +
      tableFooter +
      '\n\n_No sessions ingested yet. Run `cairn-mcp-server gather` to populate._\n'
    );
  }

  return header + tableHeader + '\n' + tableRows + '\n' + tableFooter + '\n';
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export function register(server: McpServer): void {
  server.tool(
    'manifest',
    'Generate <corpus_root>/MANIFEST.md from all normalized/*.envelope.json files in the cairn-sessions corpus. ' +
      'One row per envelope per §2.3 (id | harness | project_slug | model | started_at | event_count | tool_call_count | distilled | findings_ref | redaction_hits). ' +
      'Header includes per-harness coverage telemetry. ' +
      'Also emits <corpus_root>/schema/manifest-row.schema.json. ' +
      'In check mode, verifies row count == envelope count and reports duplicate ids (CI gate per §6).',
    {
      corpus_root: z
        .string()
        .describe('Absolute path to the cairn-sessions corpus root.'),
      mode: z
        .enum(['generate', 'check'])
        .default('generate')
        .describe(
          '"generate": scan normalized/**/*.envelope.json and write MANIFEST.md + manifest-row.schema.json. ' +
            '"check": verify row count matches envelope count and no duplicate ids (exits non-zero on failure).',
        ),
    },
    async ({ corpus_root, mode }) => {
      const { rows, errors: scanErrors } = scanEnvelopes(corpus_root);
      const dupes = checkUniqueness(rows);

      if (mode === 'check') {
        const ok = dupes.length === 0;
        return jsonResult({
          ok,
          envelope_count: rows.length,
          duplicate_ids: dupes,
          scan_errors: scanErrors,
          message: ok
            ? `All ${rows.length} envelope id(s) are unique.`
            : `FAIL: ${dupes.length} duplicate id group(s) found.`,
        });
      }

      // generate mode
      const generatedAt = new Date().toISOString();
      const md = generateManifestMd(rows, generatedAt);

      // Write MANIFEST.md
      const manifestPath = path.join(corpus_root, 'MANIFEST.md');
      fs.writeFileSync(manifestPath, md, 'utf-8');

      // Write schema/manifest-row.schema.json
      const schemaDir = path.join(corpus_root, 'schema');
      fs.mkdirSync(schemaDir, { recursive: true });
      const schemaPath = path.join(schemaDir, 'manifest-row.schema.json');
      fs.writeFileSync(schemaPath, JSON.stringify(MANIFEST_ROW_SCHEMA, null, 2) + '\n', 'utf-8');

      return jsonResult({
        ok: dupes.length === 0,
        envelope_count: rows.length,
        manifest_path: manifestPath,
        schema_path: schemaPath,
        per_harness: {
          'claude-code': rows.filter((r) => r.harness === 'claude-code').length,
          pi: rows.filter((r) => r.harness === 'pi').length,
          antigravity: rows.filter((r) => r.harness === 'antigravity').length,
        },
        duplicate_ids: dupes,
        scan_errors: scanErrors,
        generated_at: generatedAt,
      });
    },
  );
}
