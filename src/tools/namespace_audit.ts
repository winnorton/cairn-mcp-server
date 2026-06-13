import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import { expandTilde, jsonResult } from '../helpers.js';
import { loadTranscript, loadEnvelope, payloadToNormalized, type NormalizedTranscript } from '../helpers/transcript.js';

/**
 * Verb dictionary: generic tool name(s) and the regex(es) we expect a verb-matched
 * specialized tool to be named under another namespace prefix.
 */
const VERB_DICTIONARY: Array<{
  verb: string;
  generic: string[];
  alternative_patterns: RegExp[];
}> = [
  {
    verb: 'search',
    generic: ['Grep', 'grep', 'grep_search', 'rg'],
    alternative_patterns: [/search_/i, /find_/i, /_search_/i, /_lexical/i, /_semantic/i, /_structural/i],
  },
  {
    verb: 'read',
    generic: ['Read', 'cat', 'Get-Content'],
    alternative_patterns: [/read_/i, /^get_/i, /fetch_/i, /view_/i],
  },
  {
    verb: 'screenshot',
    generic: ['ManualScreenshot', 'screenshot'],
    alternative_patterns: [/_screenshot/i, /_capture/i, /_snap/i],
  },
  {
    verb: 'eval',
    generic: ['Bash', 'PowerShell', 'shell', 'eval', 'exec'],
    alternative_patterns: [/_exec/i, /_eval/i, /_run/i, /^execute_/i],
  },
  {
    verb: 'audit',
    generic: ['Bash', 'PowerShell'], // generic shells used for audits
    alternative_patterns: [/_audit_/i, /_verify_/i, /_check_/i],
  },
  {
    verb: 'inspect',
    generic: ['Bash', 'PowerShell', 'Read'],
    alternative_patterns: [/_inspect_/i, /_get_signatures/i, /_trace/i],
  },
  {
    verb: 'glob',
    generic: ['Glob', 'find'],
    alternative_patterns: [/_list_/i, /_find_/i, /_glob/i],
  },
];

export interface NamespaceAuditResult {
  source: 'transcript' | 'payload';
  source_path?: string;
  transcript_format?: string;
  notes?: string[];
  generic_tool_uses: Array<{ tool: string; count: number; ts_first: string; ts_last: string }>;
  missed_alternatives: Array<{
    used: string;
    available_alternatives: string[];
    occurrences: number;
    suggestion: string;
  }>;
  namespace_bias_score: number;
  summary: string;
  available_tools_observed: string[];
}

/** Find tools in the available pool that match any alternative pattern. */
function matchAlternatives(available: string[], patterns: RegExp[]): string[] {
  return available.filter((t) => patterns.some((re) => re.test(t)));
}

export function runNamespaceAudit(
  transcript: NormalizedTranscript,
  availableTools: string[] | undefined
): NamespaceAuditResult {
  const calls = transcript.tool_calls;
  // Tally usage per tool
  const useStats = new Map<string, { count: number; ts_first: string; ts_last: string }>();
  for (const c of calls) {
    const e = useStats.get(c.tool) || { count: 0, ts_first: c.ts, ts_last: c.ts };
    e.count += 1;
    if (Date.parse(c.ts) < Date.parse(e.ts_first)) e.ts_first = c.ts;
    if (Date.parse(c.ts) > Date.parse(e.ts_last)) e.ts_last = c.ts;
    useStats.set(c.tool, e);
  }

  // If available_tools not provided, infer from observed tool calls (a weak proxy)
  const observed = Array.from(useStats.keys());
  const pool = availableTools && availableTools.length > 0 ? availableTools : observed;

  const generic_tool_uses: NamespaceAuditResult['generic_tool_uses'] = [];
  const missed: NamespaceAuditResult['missed_alternatives'] = [];
  let totalGenericUses = 0;
  let genericUsesWithAlternative = 0;

  for (const [tool, stats] of useStats) {
    for (const entry of VERB_DICTIONARY) {
      if (!entry.generic.includes(tool)) continue;
      generic_tool_uses.push({
        tool,
        count: stats.count,
        ts_first: stats.ts_first,
        ts_last: stats.ts_last,
      });
      totalGenericUses += stats.count;
      const alternatives = matchAlternatives(pool, entry.alternative_patterns).filter((t) => t !== tool);
      if (alternatives.length > 0) {
        genericUsesWithAlternative += stats.count;
        missed.push({
          used: tool,
          available_alternatives: alternatives,
          occurrences: stats.count,
          suggestion: `Consider ${entry.verb}-prefixed alternatives (${alternatives.slice(0, 3).join(', ')}${alternatives.length > 3 ? ', ...' : ''}) instead of the generic ${tool} for ${entry.verb} operations.`,
        });
      }
      break; // a tool maps to at most one verb in this dictionary
    }
  }

  const bias = totalGenericUses === 0 ? 0 : genericUsesWithAlternative / totalGenericUses;
  let summary: string;
  if (totalGenericUses === 0) {
    summary = 'No generic tool calls detected. Agent appears to be using namespace-specialized tools.';
  } else if (missed.length === 0) {
    summary = `${totalGenericUses} generic tool calls detected, but no specialized alternatives appear available in the observed pool.`;
  } else {
    summary = `${missed.length} verb categories had unused namespace-specialized alternatives. Bias score: ${(bias * 100).toFixed(0)}% of generic uses had a non-generic alternative.`;
  }

  return {
    source: 'transcript',
    generic_tool_uses,
    missed_alternatives: missed,
    namespace_bias_score: Number(bias.toFixed(3)),
    summary,
    available_tools_observed: observed,
  };
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

export function register(server: McpServer): void {
  server.tool(
    'namespace_audit',
    'Detect Law-8 violations (survey-tools-by-verb): moments where the agent reached for generic tools (Read, grep, Bash) when verb-matching specialized tools existed under another namespace prefix (e.g. cwar_search_lexical, *_screenshot). Returns generic tool usage tally, missed alternatives per verb, and a namespace_bias_score (0-1). If available_tools is omitted, infers the pool from observed tool calls.',
    {
      transcript_path: z
        .string()
        .optional()
        .describe('Absolute path to a session transcript file (.jsonl preferred).'),
      payload: PayloadSchema.optional().describe('Pre-parsed payload as an alternative to transcript_path.'),
      available_tools: z
        .array(z.string())
        .optional()
        .describe('List of tool names available in the session. If omitted, inferred from observed tool calls.'),
      envelope_path: z
        .string()
        .optional()
        .describe('[WS-09] Absolute path to a canonical .envelope.json file. Analysed instead of transcript_path/payload when provided.'),
    },
    async ({ transcript_path, payload, available_tools, envelope_path }) => {
      let transcript: NormalizedTranscript;
      let source: 'transcript' | 'payload' = 'transcript';
      let sourcePath: string | undefined;
      const notes: string[] = [];

      if (envelope_path) {
        // WS-09 envelope branch (additive)
        sourcePath = path.resolve(expandTilde(envelope_path));
        transcript = loadEnvelope(sourcePath);
        source = 'transcript'; // compatible label
        if (transcript.notes) notes.push(...transcript.notes);
      } else if (transcript_path) {
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
          generic_tool_uses: [],
          missed_alternatives: [],
          namespace_bias_score: 0,
          summary: '',
          available_tools_observed: [],
        });
      }

      const result = runNamespaceAudit(transcript, available_tools);
      result.source = source;
      if (sourcePath) result.source_path = sourcePath;
      result.transcript_format = transcript.format;
      if (notes.length) result.notes = notes;
      return jsonResult(result);
    }
  );
}
