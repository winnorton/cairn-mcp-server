import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { expandTilde, jsonResult } from '../helpers.js';
import { loadTranscript, payloadToNormalized, type NormalizedTranscript } from '../helpers/transcript.js';
import { detectClaims, checkVerification } from '../helpers/agent_claims.js';

export interface OverclaimResult {
  source: 'transcript' | 'payload' | 'none';
  source_path?: string;
  transcript_format?: string;
  notes?: string[];
  total_claims: number;
  verified_claims: Array<{ ts: string; text: string; verification: string }>;
  unverified_claims: Array<{ ts: string; text: string; suggestion: string }>;
  pattern_summary: string;
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

export function runOverclaimCheck(transcript: NormalizedTranscript): OverclaimResult {
  const claims = detectClaims(transcript.agent_text_blocks);
  const verified: OverclaimResult['verified_claims'] = [];
  const unverified: OverclaimResult['unverified_claims'] = [];

  for (const c of claims) {
    const v = checkVerification(c, transcript.tool_calls, transcript.user_text_blocks);
    if (v.verified) {
      verified.push({ ts: c.ts, text: c.text, verification: v.via || 'verified' });
    } else {
      unverified.push({
        ts: c.ts,
        text: c.text,
        suggestion: suggestionFor(c.kind),
      });
    }
  }

  const ratio = claims.length === 0 ? 1 : verified.length / claims.length;
  const summary =
    claims.length === 0
      ? 'No completion claims detected in transcript.'
      : `${verified.length}/${claims.length} claims verified (${(ratio * 100).toFixed(0)}%). ${unverified.length === 0 ? 'No overclaim risk.' : `${unverified.length} unverified — agent may be declaring done before evidence lands.`}`;

  return {
    source: 'none',
    total_claims: claims.length,
    verified_claims: verified,
    unverified_claims: unverified,
    pattern_summary: summary,
  };
}

function suggestionFor(kind: string): string {
  switch (kind) {
    case 'test-pass':
      return 'Run the test command and quote its exit code before declaring "tests pass".';
    case 'build-clean':
      return 'Invoke the build tool (e.g. npm run build, tsc, cargo check) and quote its output.';
    case 'should-work':
      return 'Replace "should now work" with a verification step — execute the changed code path or write a smoke test.';
    case 'ready':
      return 'Add an explicit verification: build + targeted test + dependency-impact check before declaring readiness.';
    case 'fixed':
    case 'completed':
    case 'done':
      return 'Quote evidence: tool output, test result, or downstream consumer call that exercises the change.';
    default:
      return 'Add an explicit verification step before declaring completion.';
  }
}

export function register(server: McpServer): void {
  server.tool(
    'overclaim_check',
    'Scan agent text in a session transcript for completion declarations ("done", "fixed", "should now work", "tests pass", etc.) and check whether subsequent build/test tool calls or user acknowledgements verify them. Returns verified vs unverified claims with suggestions for what evidence the agent should have produced. Accepts a transcript path (.jsonl Claude Code) or a structured payload.',
    {
      transcript_path: z
        .string()
        .optional()
        .describe('Absolute path to a session transcript file (.jsonl preferred).'),
      payload: PayloadSchema.optional().describe('Pre-parsed payload as an alternative to transcript_path.'),
    },
    async ({ transcript_path, payload }) => {
      let transcript: NormalizedTranscript;
      let source: OverclaimResult['source'] = 'none';
      let sourcePath: string | undefined;
      const notes: string[] = [];

      if (transcript_path) {
        sourcePath = expandTilde(transcript_path);
        transcript = loadTranscript(sourcePath);
        source = 'transcript';
        if (transcript.notes) notes.push(...transcript.notes);
      } else if (payload) {
        transcript = payloadToNormalized(payload);
        source = 'payload';
      } else {
        return jsonResult({
          error: 'either transcript_path or payload is required',
          total_claims: 0,
          verified_claims: [],
          unverified_claims: [],
          pattern_summary: '',
        });
      }

      const result = runOverclaimCheck(transcript);
      result.source = source;
      if (sourcePath) result.source_path = sourcePath;
      result.transcript_format = transcript.format;
      if (notes.length) result.notes = notes;
      return jsonResult(result);
    }
  );
}
