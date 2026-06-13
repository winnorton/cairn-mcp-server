/**
 * gather — WS 08 (HIVE_CONTEXT_SESSIONS).
 *
 * Two responsibilities:
 *  1. Discover candidate sessions across the three harness roots.
 *  2. Persist selected sessions into the corpus as normalized envelopes.
 *
 * MCP tool shape follows the pattern in session_distill.ts.
 * Corpus layout per §2.2: normalized/<harness>/<project_slug>/<id>.envelope.json
 * Dedup per §3: skip if target envelope with same content_hash already exists.
 *
 * DO NOT call registerAdapter() or touch index.ts here — that is the orchestrator's job.
 * Registration note: see bottom of this file for the exact import + register lines to
 * add to src/tools/index.ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalizeAuto, detect } from '../adapters/index.js';
import { assertPersistable } from '../helpers/envelope_validator.js';
import { jsonResult } from '../helpers.js';
import type { Envelope } from '../adapters/types.js';
import type { HarnessName } from '../adapters/detect.js';

// ---------------------------------------------------------------------------
// Harness discovery roots
// ---------------------------------------------------------------------------

/**
 * The three harness root globs, expressed as { root, depth, extensions } so we
 * can enumerate without spawning a shell.
 *
 * Claude Code: ~/.claude/projects/<project-slug>/<session-id>.jsonl
 * Pi:          ~/.pi/agent/sessions/<project-slug>/<datetime>_<id>.jsonl
 * Antigravity: ~/.gemini/antigravity/conversations/<uuid>.db
 */
const HARNESS_ROOTS: Array<{
  label: HarnessName;
  root: string;
  /** depth below root at which session files sit (0 = directly in root) */
  fileDepth: number;
  extensions: string[];
}> = [
  {
    label: 'claude-code',
    root: path.join(os.homedir(), '.claude', 'projects'),
    fileDepth: 1,   // projects/<slug>/<file>
    extensions: ['.jsonl'],
  },
  {
    label: 'pi',
    root: path.join(os.homedir(), '.pi', 'agent', 'sessions'),
    fileDepth: 1,   // sessions/<slug>/<file>
    extensions: ['.jsonl'],
  },
  {
    label: 'antigravity',
    root: path.join(os.homedir(), '.gemini', 'antigravity', 'conversations'),
    fileDepth: 0,   // conversations/<file>
    extensions: ['.db', '.pb', '.protobuf'],
  },
];

// ---------------------------------------------------------------------------
// Candidate type
// ---------------------------------------------------------------------------

export interface SessionCandidate {
  harness: HarnessName;
  path: string;
  /** Detected harness (may differ from label if detect() overrides) */
  detected_harness: string;
  /** ISO-8601 of file mtime */
  mtime: string;
  /** File size in bytes */
  size: number;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Walk one level below a directory and return direct children files matching
 * the given extensions. For fileDepth=1, we walk one subdirectory deep.
 */
function walkHarnessRoot(
  root: string,
  fileDepth: number,
  extensions: string[],
): string[] {
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const results: string[] = [];

  if (!fs.existsSync(root)) return results;

  function collect(dir: string, depth: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory() && depth < fileDepth) {
        collect(full, depth + 1);
      } else if (ent.isFile() && depth === fileDepth) {
        const ext = path.extname(ent.name).toLowerCase();
        if (extSet.has(ext)) {
          results.push(full);
        }
      }
    }
  }

  collect(root, 0);
  return results;
}

/**
 * Discover all candidate session files across all three harness roots.
 * Returns them sorted by mtime descending (newest first).
 *
 * @param roots Optional map of harness→root overrides. When provided, the named
 *              harness(es) are swept from those paths instead of the hardcoded
 *              defaults. Unspecified harnesses still use their defaults.
 *              No-arg call is identical to today's behavior (MCP tool unchanged).
 */
export function discoverCandidates(roots?: Partial<Record<HarnessName, string>>): SessionCandidate[] {
  const candidates: SessionCandidate[] = [];

  for (const harnessDef of HARNESS_ROOTS) {
    // Apply root override if provided for this harness
    const overrideRoot = roots?.[harnessDef.label];
    const effectiveRoot = overrideRoot ?? harnessDef.root;
    const effectiveDef = { ...harnessDef, root: effectiveRoot };

    // When a root override is given, try both depth 0 (files directly in the
    // override dir) and the harness's default fileDepth (for standard layouts).
    // This lets callers point at flat dirs like docs/study_sessions/ as well as
    // the standard <root>/<slug>/<file> layout.
    const depthsToTry: number[] =
      overrideRoot !== undefined && overrideRoot !== harnessDef.root
        ? Array.from(new Set([0, harnessDef.fileDepth]))
        : [harnessDef.fileDepth];

    const seenPaths = new Set<string>();
    const files: string[] = [];
    for (const depth of depthsToTry) {
      for (const f of walkHarnessRoot(effectiveDef.root, depth, effectiveDef.extensions)) {
        if (!seenPaths.has(f)) {
          seenPaths.add(f);
          files.push(f);
        }
      }
    }

    for (const filePath of files) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      let detectedHarness: string;
      try {
        detectedHarness = detect(filePath);
      } catch {
        detectedHarness = 'unknown';
      }
      // Skip files where detection contradicts — safety guard
      if (detectedHarness === 'unknown') continue;
      candidates.push({
        harness: harnessDef.label,
        path: filePath,
        detected_harness: detectedHarness,
        mtime: stat.mtime.toISOString(),
        size: stat.size,
      });
    }
  }

  // Newest first
  candidates.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return candidates;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Compute the target envelope path for a given envelope and corpus root.
 * Layout: <corpusRoot>/normalized/<harness>/<project_slug>/<id>.envelope.json
 */
export function envelopeTargetPath(env: Envelope, corpusRoot: string): string {
  return path.join(
    corpusRoot,
    'normalized',
    env.session.harness,
    env.session.project_slug,
    `${env.session.id}.envelope.json`,
  );
}

export interface PersistResult {
  path: string;
  action: 'written' | 'skipped_duplicate';
  /** Session id of the envelope */
  id: string;
  harness: string;
  project_slug: string;
  content_hash: string;
  events: number;
  tool_calls: number;
  redaction_hits: number;
}

/**
 * Normalize a raw session file and persist it into the corpus.
 *
 * Dedup rule (§3): if the target path already exists AND its content_hash
 * matches the incoming envelope's content_hash, skip (idempotent re-ingest).
 * If the target exists with a different hash, overwrite (updated session).
 *
 * @param rawPath    Absolute path to the raw session file.
 * @param corpusRoot Absolute path to the cairn-sessions repo root.
 * @returns          PersistResult describing the outcome.
 */
export function persistSession(rawPath: string, corpusRoot: string): PersistResult {
  // 1. Normalize (adapter detects harness, scrubs, validates)
  const env = normalizeAuto(rawPath);

  // 2. Gate — assertPersistable throws if redaction.scrubbed != true or schema invalid
  assertPersistable(env);

  const targetPath = envelopeTargetPath(env, corpusRoot);
  const toolCalls = env.events.filter((e) => e.type === 'tool_call').length;

  // 3. Dedup check
  if (fs.existsSync(targetPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as { content_hash?: string };
      if (existing.content_hash === env.content_hash) {
        return {
          path: targetPath,
          action: 'skipped_duplicate',
          id: env.session.id,
          harness: env.session.harness,
          project_slug: env.session.project_slug,
          content_hash: env.content_hash,
          events: env.events.length,
          tool_calls: toolCalls,
          redaction_hits: env.session.redaction.hits,
        };
      }
    } catch {
      // Corrupt existing file — overwrite
    }
  }

  // 4. Write (create dirs as needed)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(env, null, 2), 'utf-8');

  return {
    path: targetPath,
    action: 'written',
    id: env.session.id,
    harness: env.session.harness,
    project_slug: env.session.project_slug,
    content_hash: env.content_hash,
    events: env.events.length,
    tool_calls: toolCalls,
    redaction_hits: env.session.redaction.hits,
  };
}

// ---------------------------------------------------------------------------
// MCP tool registration
// ---------------------------------------------------------------------------

export function register(server: McpServer): void {
  server.tool(
    'gather',
    'Discover and ingest session transcripts from all three harness locations (Claude Code, Pi, Antigravity) into the cairn-sessions corpus. ' +
      'In dry-run mode, lists candidates without writing. ' +
      'In persist mode, normalizes each selected session through detect→adapter→redact, asserts the §4 persistability gate, ' +
      'and writes to <corpus_root>/normalized/<harness>/<project_slug>/<id>.envelope.json. ' +
      'Idempotent: re-ingesting a session with the same content_hash is a no-op (skipped_duplicate).',
    {
      mode: z
        .enum(['dry-run', 'persist'])
        .default('dry-run')
        .describe(
          '"dry-run": list candidates across all harness roots without writing. ' +
            '"persist": normalize + persist each session at the given paths (or all discovered if paths omitted).',
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          'Absolute paths to specific raw session files to persist. ' +
            'If omitted in persist mode, all discovered candidates are processed.',
        ),
      corpus_root: z
        .string()
        .optional()
        .describe(
          'Absolute path to the cairn-sessions corpus root. ' +
            'Required in persist mode. Ignored in dry-run.',
        ),
    },
    async ({ mode, paths, corpus_root }) => {
      if (mode === 'dry-run') {
        const candidates = discoverCandidates();
        const summary = {
          total: candidates.length,
          by_harness: {} as Record<string, number>,
          candidates: candidates.map((c) => ({
            harness: c.harness,
            path: c.path,
            mtime: c.mtime,
            size_kb: Math.round(c.size / 1024),
          })),
        };
        for (const c of candidates) {
          summary.by_harness[c.harness] = (summary.by_harness[c.harness] ?? 0) + 1;
        }
        return jsonResult(summary);
      }

      // persist mode
      if (!corpus_root) {
        return jsonResult({
          error: 'corpus_root is required in persist mode.',
        });
      }

      const targetPaths =
        paths && paths.length > 0 ? paths : discoverCandidates().map((c) => c.path);

      const results: PersistResult[] = [];
      const errors: Array<{ path: string; error: string }> = [];

      for (const rawPath of targetPaths) {
        try {
          results.push(persistSession(rawPath, corpus_root));
        } catch (err) {
          errors.push({
            path: rawPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const written = results.filter((r) => r.action === 'written').length;
      const skipped = results.filter((r) => r.action === 'skipped_duplicate').length;

      return jsonResult({
        summary: {
          total_processed: results.length,
          written,
          skipped_duplicates: skipped,
          errors: errors.length,
        },
        results,
        errors,
      });
    },
  );
}

/*
 * ── src/tools/index.ts registration lines ────────────────────────────────────
 *
 * Add these two lines to src/tools/index.ts:
 *
 *   import { register as registerGather } from './gather.js';
 *   import { register as registerManifest } from './manifest.js';
 *
 * And inside registerAllTools():
 *
 *   // v0.5.0 corpus tools (WS 08)
 *   registerGather(server);
 *   registerManifest(server);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
