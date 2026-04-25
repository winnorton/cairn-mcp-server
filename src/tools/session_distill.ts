import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import { execFileSync } from 'child_process';
import { expandTilde, jsonResult } from '../helpers.js';
import { findRecentFiles, loadTranscript, payloadToNormalized, type NormalizedTranscript } from '../helpers/transcript.js';
import { detectClaims, checkVerification } from '../helpers/agent_claims.js';
import { runOverclaimCheck } from './overclaim_check.js';
import { runNamespaceAudit } from './namespace_audit.js';

interface RedundantCallReport {
  tool: string;
  args_repeated_count: number;
  wasted_seconds_estimate: number;
}

interface DecisionPointReport {
  ts: string;
  context: string;
}

interface SuggestedMemoryEntry {
  type: 'feedback' | 'project' | 'reference';
  name: string;
  body_sketch: string;
  rationale: string;
}

interface SuggestedLawCandidate {
  slug: string;
  headline: string;
  why: string;
  empirical_support: string;
}

interface SessionDistillResult {
  session_summary: {
    tool_call_count: number;
    file_change_count: number;
    duration_minutes: number;
    transcript_format: string;
    degraded?: boolean;
    notes?: string[];
  };
  tool_call_breakdown: {
    by_tool: Record<string, number>;
    top_5_consumers: Array<{ tool: string; count: number; total_ms?: number }>;
  };
  redundant_calls: RedundantCallReport[];
  namespace_gaps: ReturnType<typeof runNamespaceAudit>;
  overclaim_findings: ReturnType<typeof runOverclaimCheck>;
  decision_points: DecisionPointReport[];
  suggested_memory_entries: SuggestedMemoryEntry[];
  suggested_law_candidates: SuggestedLawCandidate[];
  human_reviewer_notes: string;
}

const PayloadSchema = z.object({
  tool_calls: z
    .array(
      z.object({
        tool: z.string(),
        args: z.unknown().optional(),
        duration_ms: z.number().optional(),
        ts: z.string(),
      })
    )
    .optional(),
  file_changes: z
    .array(
      z.object({
        path: z.string(),
        change: z.enum(['modify', 'create', 'delete']),
        ts: z.string(),
      })
    )
    .optional(),
  agent_claims: z
    .array(
      z.object({
        text: z.string(),
        ts: z.string(),
      })
    )
    .optional(),
});

function detectRedundantCalls(transcript: NormalizedTranscript): RedundantCallReport[] {
  const sigCounts = new Map<string, { tool: string; count: number; total_ms: number }>();
  for (const c of transcript.tool_calls) {
    let argSig: string;
    try {
      argSig = JSON.stringify(c.args ?? '');
    } catch {
      argSig = String(c.args ?? '');
    }
    if (argSig.length > 500) argSig = argSig.slice(0, 500);
    const key = `${c.tool}::${argSig}`;
    const e = sigCounts.get(key) || { tool: c.tool, count: 0, total_ms: 0 };
    e.count += 1;
    if (c.duration_ms) e.total_ms += c.duration_ms;
    sigCounts.set(key, e);
  }
  const out: RedundantCallReport[] = [];
  for (const [, v] of sigCounts) {
    if (v.count >= 2) {
      // Wasted = (count-1) * average_duration; if no duration data, estimate 1500ms/call
      const avgMs = v.total_ms > 0 ? v.total_ms / v.count : 1500;
      out.push({
        tool: v.tool,
        args_repeated_count: v.count,
        wasted_seconds_estimate: Math.round(((v.count - 1) * avgMs) / 100) / 10,
      });
    }
  }
  out.sort((a, b) => b.wasted_seconds_estimate - a.wasted_seconds_estimate);
  return out.slice(0, 20);
}

/** Spot decision points: agent text containing question marks toward user, or pivots
 *  ("instead", "actually", "wait", "let me reconsider"). */
function detectDecisionPoints(transcript: NormalizedTranscript): DecisionPointReport[] {
  const out: DecisionPointReport[] = [];
  const PIVOT = /\b(instead|actually|wait[,.]|let me reconsider|on second thought|hmm|reconsidering|switching|pivoting)\b/i;
  const QUESTION = /\?\s*$/;
  for (const b of transcript.agent_text_blocks) {
    const lines = b.text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (PIVOT.test(line)) {
        out.push({ ts: b.ts, context: `pivot/reconsider: ${line.slice(0, 200)}` });
        break; // one per block
      } else if (QUESTION.test(line) && line.length < 400) {
        out.push({ ts: b.ts, context: `agent question: ${line.slice(0, 200)}` });
        break;
      }
    }
  }
  return out.slice(0, 30);
}

function summarizeToolBreakdown(transcript: NormalizedTranscript) {
  const counts: Record<string, number> = {};
  const totals: Record<string, number> = {};
  for (const c of transcript.tool_calls) {
    counts[c.tool] = (counts[c.tool] || 0) + 1;
    if (c.duration_ms) totals[c.tool] = (totals[c.tool] || 0) + c.duration_ms;
  }
  const top5 = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tool, count]) => ({ tool, count, ...(totals[tool] ? { total_ms: totals[tool] } : {}) }));
  return { by_tool: counts, top_5_consumers: top5 };
}

function buildSuggestions(
  transcript: NormalizedTranscript,
  redundant: RedundantCallReport[],
  namespace: ReturnType<typeof runNamespaceAudit>,
  overclaim: ReturnType<typeof runOverclaimCheck>
): { memory: SuggestedMemoryEntry[]; laws: SuggestedLawCandidate[] } {
  const memory: SuggestedMemoryEntry[] = [];
  const laws: SuggestedLawCandidate[] = [];

  // Suggestion 1: redundant tool calls -> feedback memory
  if (redundant.length > 0) {
    const worst = redundant[0];
    memory.push({
      type: 'feedback',
      name: `cache_repeated_${worst.tool.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_calls`,
      body_sketch: `Agent called \`${worst.tool}\` with identical args ${worst.args_repeated_count} times in a single session, wasting ~${worst.wasted_seconds_estimate}s. Cache results within a turn or batch the operation.`,
      rationale: `Detected ${redundant.length} repeated call signature(s); top waster: ${worst.tool} x${worst.args_repeated_count}.`,
    });
  }

  // Suggestion 2: namespace bias -> feedback (or law candidate if score is high)
  if (namespace.namespace_bias_score >= 0.5 && namespace.missed_alternatives.length > 0) {
    const worst = namespace.missed_alternatives[0];
    memory.push({
      type: 'feedback',
      name: 'survey_tools_by_verb_first',
      body_sketch: `Before reaching for generic ${worst.used}, scan available tools for verb-matched alternatives (${worst.available_alternatives.slice(0, 3).join(', ')}). Bias score ${(namespace.namespace_bias_score * 100).toFixed(0)}% this session.`,
      rationale: `Namespace bias score ${(namespace.namespace_bias_score * 100).toFixed(0)}% indicates systematic generic-tool preference.`,
    });
    if (namespace.namespace_bias_score >= 0.75) {
      laws.push({
        slug: 'survey-tools-by-verb',
        headline: 'Survey available tools by verb before reaching for the generic shell.',
        why: 'When namespace-prefixed tools exist for the verb (search/read/eval/audit), use them — they return structured output and live under permissions you have already accepted.',
        empirical_support: `${namespace.missed_alternatives.length} verb categories had unused alternatives in this session.`,
      });
    }
  }

  // Suggestion 3: overclaim pattern -> feedback (or law candidate if pervasive)
  if (overclaim.unverified_claims.length > 0) {
    memory.push({
      type: 'feedback',
      name: 'verify_before_claiming_done',
      body_sketch: `Agent declared completion ${overclaim.unverified_claims.length} time(s) without subsequent verification (build/test/downstream tool call). Cite evidence in the same turn as the claim, or hold the claim.`,
      rationale: `${overclaim.unverified_claims.length} unverified completion claim(s) detected.`,
    });
    if (overclaim.unverified_claims.length >= 3 && overclaim.total_claims >= 4) {
      laws.push({
        slug: 'evidence-with-claim',
        headline: 'Every "done"/"fixed"/"works" claim ships with evidence in the same turn.',
        why: 'Unverified completion claims compound: the user moves on, the bug returns, the agent loses credibility.',
        empirical_support: `${overclaim.unverified_claims.length} of ${overclaim.total_claims} claims unverified in this session.`,
      });
    }
  }

  // Suggestion 4: heavy file activity in a project area -> project memory
  if (transcript.file_changes.length >= 5) {
    const dirCounts = new Map<string, number>();
    for (const fc of transcript.file_changes) {
      const dir = path.dirname(fc.path);
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
    }
    const topDir = Array.from(dirCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (topDir && topDir[1] >= 3) {
      memory.push({
        type: 'project',
        name: `recent_activity_${path.basename(topDir[0]).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase() || 'root'}`,
        body_sketch: `Active editing area this session: ${topDir[0]} (${topDir[1]} file changes). If this becomes a recurring focus, document the architecture/conventions for future sessions.`,
        rationale: `High file-change density in ${topDir[0]} suggests an emerging hot zone worth documenting.`,
      });
    }
  }

  return { memory, laws };
}

/** Compute session duration from min/max timestamps. */
function computeDurationMinutes(transcript: NormalizedTranscript): number {
  let minMs = Infinity;
  let maxMs = 0;
  const tsBuckets = [
    ...transcript.tool_calls.map((c) => c.ts),
    ...transcript.agent_text_blocks.map((b) => b.ts),
    ...transcript.user_text_blocks.map((b) => b.ts),
    ...transcript.file_changes.map((c) => c.ts),
  ];
  for (const t of tsBuckets) {
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) continue;
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  if (!Number.isFinite(minMs) || maxMs === 0) return 0;
  return Math.round((maxMs - minMs) / 60000);
}

function safeGitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function buildDegradedTranscriptFromActivity(
  projectPath: string,
  windowMinutes: number
): NormalizedTranscript {
  const sinceMs = Date.now() - windowMinutes * 60 * 1000;
  // Fake-tool-calls from git log; not really tool calls but we surface them as a degraded signal.
  const sinceIso = new Date(sinceMs).toISOString();
  const gitOut = safeGitOutput(projectPath, [
    'log',
    `--since=${sinceIso}`,
    '--name-status',
    '--format=COMMIT::%H::%cI::%s',
  ]);
  const fileChanges: NormalizedTranscript['file_changes'] = [];
  let currentTs = new Date().toISOString();
  if (gitOut) {
    for (const line of gitOut.split(/\r?\n/)) {
      if (line.startsWith('COMMIT::')) {
        const parts = line.split('::');
        if (parts.length >= 3) currentTs = parts[2];
      } else if (line.length >= 3 && /^[AMDR]\t/.test(line)) {
        const [code, ...rest] = line.split('\t');
        const filePath = rest.join('\t');
        const change: 'create' | 'modify' | 'delete' =
          code === 'A' ? 'create' : code === 'D' ? 'delete' : 'modify';
        fileChanges.push({ ts: currentTs, path: filePath, change });
      }
    }
  }
  // Also surface recent memory writes as a soft signal
  const memFiles = findRecentFiles(path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude'), ['.md'], sinceMs, 50);
  for (const f of memFiles) {
    fileChanges.push({ ts: new Date().toISOString(), path: f, change: 'modify' });
  }
  return {
    format: 'unknown',
    notes: [
      `degraded mode: no transcript provided — synthesized from git log within ${windowMinutes}min window and recent ~/.claude/*.md mtimes`,
    ],
    tool_calls: [],
    file_changes: fileChanges,
    agent_text_blocks: [],
    user_text_blocks: [],
  };
}

export function register(server: McpServer): void {
  server.tool(
    'session_distill',
    'Umbrella session-learning tool. Parses a Claude Code .jsonl transcript (or accepts a structured payload, or scans recent file activity in degraded mode) and returns: tool-call breakdown + top-5, redundant-call detection, namespace-gap audit (Law 8), overclaim findings (verified vs unverified completion claims), decision-point excerpts, and suggested cairn-typed memory + law candidates the human can promote.',
    {
      transcript_path: z
        .string()
        .optional()
        .describe('Absolute path to a session transcript. .jsonl preferred; .pb returns a deferred note.'),
      payload: PayloadSchema.optional().describe('Pre-parsed session payload (alternative to transcript_path).'),
      project_path: z
        .string()
        .optional()
        .describe('Project directory for context. Defaults to cwd.'),
      recent_window_minutes: z
        .number()
        .optional()
        .default(120)
        .describe('If neither transcript nor payload is given, scan recent activity within this window (degraded mode).'),
    },
    async ({ transcript_path, payload, project_path, recent_window_minutes }) => {
      const projectPath = project_path ? path.resolve(expandTilde(project_path)) : process.cwd();
      let transcript: NormalizedTranscript;
      let degraded = false;
      const notes: string[] = [];

      if (transcript_path) {
        transcript = loadTranscript(expandTilde(transcript_path));
        if (transcript.notes) notes.push(...transcript.notes);
      } else if (payload) {
        transcript = payloadToNormalized(payload);
      } else {
        transcript = buildDegradedTranscriptFromActivity(projectPath, recent_window_minutes ?? 120);
        degraded = true;
        if (transcript.notes) notes.push(...transcript.notes);
      }

      const breakdown = summarizeToolBreakdown(transcript);
      const redundant = detectRedundantCalls(transcript);
      const namespace = runNamespaceAudit(transcript, undefined);
      const overclaim = runOverclaimCheck(transcript);
      const decisions = detectDecisionPoints(transcript);
      const { memory: suggestedMem, laws: suggestedLaws } = buildSuggestions(transcript, redundant, namespace, overclaim);

      const reviewerBits: string[] = [];
      reviewerBits.push(
        `${transcript.tool_calls.length} tool calls, ${transcript.file_changes.length} file changes, ~${computeDurationMinutes(transcript)}min span.`
      );
      if (degraded) reviewerBits.push('Degraded mode (no transcript) — findings are inferred from git + memory mtimes only.');
      if (redundant.length > 0)
        reviewerBits.push(`${redundant.length} redundant call signature(s); top waster ${redundant[0].tool} x${redundant[0].args_repeated_count}.`);
      if (overclaim.unverified_claims.length > 0)
        reviewerBits.push(`${overclaim.unverified_claims.length} unverified completion claim(s).`);
      if (namespace.missed_alternatives.length > 0)
        reviewerBits.push(`${namespace.missed_alternatives.length} verb category(ies) with missed namespace-specialized alternatives.`);
      if (suggestedMem.length === 0 && suggestedLaws.length === 0)
        reviewerBits.push('No memory/law candidates surfaced — clean session or insufficient signal.');

      const result: SessionDistillResult = {
        session_summary: {
          tool_call_count: transcript.tool_calls.length,
          file_change_count: transcript.file_changes.length,
          duration_minutes: computeDurationMinutes(transcript),
          transcript_format: transcript.format,
          ...(degraded ? { degraded: true } : {}),
          ...(notes.length ? { notes } : {}),
        },
        tool_call_breakdown: breakdown,
        redundant_calls: redundant,
        namespace_gaps: namespace,
        overclaim_findings: overclaim,
        decision_points: decisions,
        suggested_memory_entries: suggestedMem,
        suggested_law_candidates: suggestedLaws,
        human_reviewer_notes: reviewerBits.join(' '),
      };
      return jsonResult(result);
    }
  );
}
