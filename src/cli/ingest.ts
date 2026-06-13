#!/usr/bin/env node
/**
 * cairn-ingest — CLI entrypoint (§3 of SPEC_HIVE_CONTEXT_SESSIONS_11_INGEST_CLI).
 *
 * Subcommands:
 *   gather  --corpus <dir> [--roots claude-code=<path>,pi=<path>,antigravity=<path>]
 *   distill --corpus <dir> --llm-base-url <url> [--model <name>] [--max <N>] [--temperature <t>]
 *   status  --corpus <dir>
 *
 * Env fallbacks: CORPUS_ROOT, OPENAI_BASE_URL, OPENAI_API_KEY, CAIRN_DISTILL_MODEL
 * Each subcommand prints a one-line JSON summary. Exits non-zero on hard failure.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { discoverCandidates, persistSession } from '../tools/gather.js';
import { scanEnvelopes, generateManifestMd } from '../tools/manifest.js';
import { corpusStatus } from '../tools/corpus_status.js';
import { distillEnvelope } from '../distill/llm.js';
import type { HarnessName } from '../adapters/detect.js';
import type { Envelope } from '../adapters/types.js';

// ---------------------------------------------------------------------------
// Minimal arg parser — no new dependencies
// ---------------------------------------------------------------------------

interface Args {
  subcommand: string | null;
  flags: Record<string, string | true>;
  /** Positional args (after subcommand) */
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  // argv[0] = node, argv[1] = script, argv[2] = subcommand
  const args: Args = { subcommand: null, flags: {}, positional: [] };
  const raw = argv.slice(2);

  if (raw.length > 0 && !raw[0].startsWith('-')) {
    args.subcommand = raw[0];
    raw.shift();
  }

  let i = 0;
  while (i < raw.length) {
    const tok = raw[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      if (i + 1 < raw.length && !raw[i + 1].startsWith('--')) {
        args.flags[key] = raw[i + 1];
        i += 2;
      } else {
        args.flags[key] = true;
        i += 1;
      }
    } else {
      args.positional.push(tok);
      i += 1;
    }
  }
  return args;
}

function flag(args: Args, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Root resolution for gather
// ---------------------------------------------------------------------------

function parseRoots(rootsStr: string): Partial<Record<HarnessName, string>> {
  const result: Partial<Record<HarnessName, string>> = {};
  for (const pair of rootsStr.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const harness = pair.slice(0, eq).trim() as HarnessName;
    const rootPath = expandHome(pair.slice(eq + 1).trim());
    result[harness] = rootPath;
  }
  return result;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveCorpus(args: Args): string {
  const c = flag(args, 'corpus') ?? process.env.CORPUS_ROOT;
  if (!c) {
    console.error('Error: --corpus <dir> or CORPUS_ROOT env is required');
    process.exit(1);
  }
  return path.resolve(expandHome(c));
}

// ---------------------------------------------------------------------------
// Subcommand: gather
// ---------------------------------------------------------------------------

async function runGather(args: Args): Promise<void> {
  const corpusRoot = resolveCorpus(args);

  if (!fs.existsSync(corpusRoot) || !fs.statSync(corpusRoot).isDirectory()) {
    console.error(`Error: corpus directory not found: ${corpusRoot}`);
    process.exit(1);
  }

  const rootsStr = flag(args, 'roots');
  const rootOverrides = rootsStr ? parseRoots(rootsStr) : undefined;

  const candidates = discoverCandidates(rootOverrides);

  let discovered = 0;
  let persisted = 0;
  let skippedDup = 0;
  let errors = 0;

  for (const candidate of candidates) {
    discovered++;
    try {
      const result = persistSession(candidate.path, corpusRoot);
      if (result.action === 'written') {
        persisted++;
      } else {
        skippedDup++;
      }
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`gather error [${candidate.path}]: ${msg}\n`);
    }
  }

  // Regenerate MANIFEST.md
  let manifestRows2 = 0;
  try {
    const { rows } = scanEnvelopes(corpusRoot);
    const md = generateManifestMd(rows, new Date().toISOString());
    fs.writeFileSync(path.join(corpusRoot, 'MANIFEST.md'), md, 'utf-8');
    manifestRows2 = rows.length;
  } catch (err) {
    process.stderr.write(`manifest update error: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  const summary = { discovered, persisted, skipped_dup: skippedDup, errors, manifest_rows: manifestRows2 };
  console.log(JSON.stringify(summary));
  if (errors > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Subcommand: distill
// ---------------------------------------------------------------------------

async function runDistill(args: Args): Promise<void> {
  const corpusRoot = resolveCorpus(args);

  const baseUrl = flag(args, 'llm-base-url') ?? process.env.OPENAI_BASE_URL;
  if (!baseUrl) {
    console.error('Error: --llm-base-url <url> or OPENAI_BASE_URL env is required');
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY ?? 'local';
  const model = flag(args, 'model') ?? process.env.CAIRN_DISTILL_MODEL ?? undefined;
  const maxStr = flag(args, 'max');
  const max = maxStr ? parseInt(maxStr, 10) : 25;
  const tempStr = flag(args, 'temperature');
  const temperature = tempStr ? parseFloat(tempStr) : 0.2;

  if (!fs.existsSync(corpusRoot) || !fs.statSync(corpusRoot).isDirectory()) {
    console.error(`Error: corpus directory not found: ${corpusRoot}`);
    process.exit(1);
  }

  // Find envelopes without findings
  const { rows } = scanEnvelopes(corpusRoot);
  const allUndistilled = rows.filter((r) => !r.distilled);
  const undistilled = allUndistilled.slice(0, max);

  let distilled = 0;
  let failed = 0;

  const already_distilled = rows.filter((r) => r.distilled).length;
  // Sessions that are undistilled but not processed this run because of --max
  const remaining_undistilled = allUndistilled.length - undistilled.length;

  for (const row of undistilled) {
    try {
      const envJson = fs.readFileSync(row._envelope_path, 'utf-8');
      const envelope = JSON.parse(envJson) as Envelope;

      await distillEnvelope(envelope, {
        corpusRoot,
        baseUrl,
        apiKey,
        model,
        temperature,
      });
      distilled++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`distill error [${row.id}]: ${msg}\n`);
      // Never crash — log and continue
    }
  }

  const summary = { distilled, already_distilled, remaining_undistilled, failed };
  console.log(JSON.stringify(summary));
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Subcommand: status
// ---------------------------------------------------------------------------

async function runStatus(args: Args): Promise<void> {
  const corpusRoot = resolveCorpus(args);
  const status = corpusStatus(corpusRoot);
  console.log(JSON.stringify(status));
  if (status.error) process.exit(1);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.subcommand) {
    case 'gather':
      await runGather(args);
      break;
    case 'distill':
      await runDistill(args);
      break;
    case 'status':
      await runStatus(args);
      break;
    case null:
    case undefined:
    case 'help':
    case '--help':
      console.log(
        [
          'cairn-ingest — session ingestion CLI',
          '',
          'Usage:',
          '  cairn-ingest gather  --corpus <dir> [--roots harness=path,...]',
          '  cairn-ingest distill --corpus <dir> --llm-base-url <url> [--model <name>] [--max <N>] [--temperature <t>]',
          '  cairn-ingest status  --corpus <dir>',
          '',
          'Env: CORPUS_ROOT, OPENAI_BASE_URL, OPENAI_API_KEY, CAIRN_DISTILL_MODEL',
        ].join('\n'),
      );
      break;
    default:
      console.error(`Error: unknown subcommand "${args.subcommand}". Use gather, distill, or status.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
