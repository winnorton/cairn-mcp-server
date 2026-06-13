/**
 * findings_ledger.ts — WS-09 (HIVE_CONTEXT_SESSIONS)
 *
 * Shared helper for writing per-session findings JSON files + updating LEDGER.md.
 * Imported by session_distill (and any future distillation tool that wants to
 * accumulate findings).
 *
 * Schema: §2.4 of SPEC_HIVE_CONTEXT_SESSIONS_00_PROGRAM.md
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Finding schema (§2.4)
// ---------------------------------------------------------------------------

export interface FindingPattern {
  /** Catalog name (from the /session-distill seeded catalog or 'new'). */
  name: string;
  /** How many times this pattern appeared in this session. 0 = prior-seed only. */
  instance_count: number;
  /** Line range (e.g. "L42-L89") or event seq range (e.g. "seq:12-15"). */
  evidence: string;
}

export interface FindingCandidates {
  /** Skill names that could be refined/created based on this session. */
  skills: string[];
  /** Law slugs that should be promoted or reinforced. */
  laws: string[];
  /** Memory entry names suggested. */
  memory: string[];
}

export interface Finding {
  session_id: string;
  distilled_at: string;           // ISO-8601
  distiller: string;              // "<tool|skill>@<version>"
  harness: string;                // harness name for context
  patterns: FindingPattern[];
  candidates: FindingCandidates;
  links: {
    note: string | null;          // path to related /note file
    commit: string | null;        // git commit hash if applied
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function findingsDir(corpusRoot: string): string {
  return path.join(corpusRoot, 'findings');
}

function findingsPath(corpusRoot: string, sessionId: string): string {
  return path.join(findingsDir(corpusRoot), `${sessionId}.findings.json`);
}

function ledgerPath(corpusRoot: string): string {
  return path.join(findingsDir(corpusRoot), 'LEDGER.md');
}

// ---------------------------------------------------------------------------
// Prior-pattern loading (compounding read)
// ---------------------------------------------------------------------------

/**
 * Load pattern names from all existing findings/*.json in the corpus.
 * These are passed into distillation so patterns are *recognized*, not re-derived.
 *
 * Returns a deduplicated, sorted array of pattern names (instance_count > 0 only,
 * so we don't carry forward seed-only placeholder entries).
 */
export function loadPriorPatternNames(corpusRoot: string): string[] {
  const dir = findingsDir(corpusRoot);
  if (!fs.existsSync(dir)) return [];

  const names = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.findings.json'));
  } catch {
    return [];
  }

  for (const fname of entries) {
    const fpath = path.join(dir, fname);
    try {
      const raw = fs.readFileSync(fpath, 'utf-8');
      const finding: Finding = JSON.parse(raw);
      for (const p of finding.patterns ?? []) {
        if (p.name && p.instance_count > 0) {
          names.add(p.name);
        }
      }
    } catch {
      // skip corrupted/partial findings files
    }
  }

  return Array.from(names).sort();
}

// ---------------------------------------------------------------------------
// Ledger LEDGER.md update
// ---------------------------------------------------------------------------

const LEDGER_HEADER = `# Findings Ledger

**Auto-maintained by \`session_distill\` (WS-09).** One row per distilled session.
Human-readable rollup; machine-readable details are in the per-session \`.findings.json\` files.

| session_id | harness | distilled_at | pattern_count | law_candidates | memory_candidates |
|---|---|---|---|---|---|
`;

const LEDGER_FOOTER = `
---
_Updated automatically. Do not edit the table rows by hand._
`;

/**
 * Append or update the LEDGER.md row for this session.
 * If the session already has a row (by session_id), the row is replaced.
 * Otherwise a new row is appended.
 */
function updateLedger(corpusRoot: string, finding: Finding): boolean {
  const lpath = ledgerPath(corpusRoot);
  const patternCount = finding.patterns.filter((p) => p.instance_count > 0).length;
  const lawCount = finding.candidates.laws.length;
  const memCount = finding.candidates.memory.length;
  const shortId = finding.session_id.slice(0, 8);
  const distilledAt = finding.distilled_at.slice(0, 16).replace('T', ' ');
  const newRow = `| ${shortId}… | ${finding.harness} | ${distilledAt} | ${patternCount} | ${lawCount} | ${memCount} |`;

  let existing = '';
  if (fs.existsSync(lpath)) {
    existing = fs.readFileSync(lpath, 'utf-8');
  }

  if (!existing) {
    // Create fresh ledger
    fs.writeFileSync(lpath, LEDGER_HEADER + newRow + '\n' + LEDGER_FOOTER, 'utf-8');
    return true;
  }

  // Replace existing row for this session_id (match on the truncated id prefix)
  const idPrefix = shortId;
  const rowPattern = new RegExp(`^\\| ${idPrefix}[^|]* \\|.*$`, 'm');

  if (rowPattern.test(existing)) {
    const updated = existing.replace(rowPattern, newRow);
    fs.writeFileSync(lpath, updated, 'utf-8');
    return true;
  }

  // Append new row before the footer divider
  const footerIdx = existing.indexOf('\n---\n');
  if (footerIdx >= 0) {
    const updated = existing.slice(0, footerIdx) + '\n' + newRow + existing.slice(footerIdx);
    fs.writeFileSync(lpath, updated, 'utf-8');
  } else {
    // No footer yet — just append
    fs.appendFileSync(lpath, '\n' + newRow, 'utf-8');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main write function
// ---------------------------------------------------------------------------

export interface LedgerWriteResult {
  findingsPath: string;
  ledgerUpdated: boolean;
}

/**
 * Persist a Finding to `<corpus>/findings/<session_id>.findings.json` and
 * update `<corpus>/findings/LEDGER.md`.
 *
 * Idempotent: re-running with the same session_id overwrites the previous file.
 * Creates the findings/ directory if absent.
 *
 * @returns Absolute paths written + ledger-updated flag.
 */
export function writeFindingsLedger(
  corpusRoot: string,
  sessionId: string,
  harness: string,
  finding: Finding,
): LedgerWriteResult {
  const dir = findingsDir(corpusRoot);
  fs.mkdirSync(dir, { recursive: true });

  const fpath = findingsPath(corpusRoot, sessionId);
  fs.writeFileSync(fpath, JSON.stringify(finding, null, 2), 'utf-8');

  const ledgerUpdated = updateLedger(corpusRoot, finding);

  return { findingsPath: fpath, ledgerUpdated };
}
