/**
 * Claude Code session adapter — WS 04 (HIVE_CONTEXT_SESSIONS).
 *
 * Normalizes a Claude Code `.jsonl` session file into the canonical Envelope.
 * Pure, deterministic function of raw bytes: identical raw → byte-identical envelope.
 *
 * Claude Code JSONL line shapes handled:
 *  - {"type":"queue-operation","operation":"enqueue|dequeue",...}  → ignored (session boundary markers)
 *  - {"type":"user","message":{"role":"user","content":[...]},...}  → user messages + tool_results
 *  - {"type":"assistant","message":{"role":"assistant","content":[...]},...} → assistant messages + tool_use
 *  - {"type":"system","subtype":"stop_hook_summary",...}  → system events
 *  - {"type":"ai-title",...}  → ignored (metadata)
 *  - {"type":"last-prompt",...} → ignored (metadata)
 *  - {"type":"attachment",...} → ignored (sidebar metadata)
 *  - {"type":"mode",...} → ignored (mode switch, no event content)
 *  - {"type":"compaction",...} or {"type":"summary",...} → compaction event
 *
 * Session metadata pulled from: sessionId, cwd, version, model, timestamp fields.
 *
 * Implements §2.5 Adapter interface. Runs scrubEnvelope (§2.6) internally and sets
 * redaction fields. Validates with validateEnvelope + assertPersistable. Returns a
 * fully persistable envelope.
 *
 * DO NOT call registerAdapter() here — that is the orchestrator's job (barrel file).
 */

import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import type {
  Adapter,
  Envelope,
  EnvelopeEvent,
  EnvelopeTool,
  EnvelopeTokens,
} from './types.js';
import { scrubEnvelope } from '../redaction/scrub.js';
import { validateEnvelope, assertPersistable, computeContentHash } from '../helpers/envelope_validator.js';
import { cwdToSlug } from '../helpers/slug.js';

// ---------------------------------------------------------------------------
// Internal raw-line shape types (loosely typed for robustness)
// ---------------------------------------------------------------------------

type RawBlock = {
  type?: string;
  text?: string;
  thinking?: string; // extended thinking block
  name?: string;   // tool_use: tool name
  id?: string;     // tool_use: id
  input?: unknown; // tool_use: args
  tool_use_id?: string; // tool_result: matching id
  is_error?: boolean;
  content?: unknown; // tool_result: result text
};

type RawMessage = {
  role?: string;
  content?: RawBlock[] | string;
  model?: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

type RawLine = {
  type?: string;
  operation?: string; // queue-operation
  timestamp?: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  cwd?: string;
  version?: string;
  message?: RawMessage;
  subtype?: string; // system subtype
  // compaction / summary
  leafUuid?: string;
  summary?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a tool_use input object into a short digest for the envelope.
 * We hash the JSON representation so the adapter stays deterministic and secrets
 * in args are scrubbed by scrubEnvelope rather than stored verbatim.
 */
function argsDigest(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  try {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return createHash('sha256').update(str).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Extract text content from a tool_result content field.
 * Content can be a string or an array of blocks.
 */
function extractToolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content as RawBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
    return texts.join('\n') || null;
  }
  return null;
}

/** Normalize a potentially non-ISO timestamp to ISO 8601, or return as-is if already ISO. */
function normalizeTimestamp(ts: string | null | undefined): string | null {
  if (!ts) return null;
  // Already ISO 8601 (contains T and Z or timezone offset)
  if (ts.includes('T') && (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts))) return ts;
  // Try parsing "M/D/YYYY H:MM:SS" or other Date.parse-able strings
  const ms = Date.parse(ts);
  if (!isNaN(ms)) return new Date(ms).toISOString();
  return ts; // Return as-is if we cannot parse
}

// ---------------------------------------------------------------------------
// Core normalize function
// ---------------------------------------------------------------------------

function normalize(rawPath: string): Envelope {
  // content_hash is over RAW file bytes (idempotence key — §2.1)
  const content_hash = computeContentHash(rawPath);
  const rawBytes = fs.readFileSync(rawPath);
  const text = rawBytes.toString('utf-8');
  const lines = text.split(/\r?\n/);

  const events: EnvelopeEvent[] = [];
  let seq = 0;

  // Session metadata — populated from first lines we encounter
  let sessionId: string | null = null;
  let harness_version: string | null = null;
  let model: string | null = null;
  let provider: string | null = null;
  let cwd: string | null = null;
  let started_at: string | null = null;
  let ended_at: string | null = null;

  // Map tool_use_id → { toolName, startedTs, eventIndex } for duration tracking
  const pendingToolUses = new Map<string, { toolName: string; startedMs: number; eventIndex: number }>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: RawLine;
    try {
      obj = JSON.parse(line) as RawLine;
    } catch {
      continue; // Unparseable line — skip silently
    }

    const type = obj.type;
    if (!type) continue;

    // Update session metadata from any line that carries it
    if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
    if (obj.cwd && !cwd) cwd = obj.cwd;
    if (obj.version && !harness_version) harness_version = obj.version;

    const ts = normalizeTimestamp(obj.timestamp as string | undefined);

    // Track started_at / ended_at from any timestamped line
    if (ts) {
      if (!started_at) started_at = ts;
      ended_at = ts;
    }

    // ── Route by type ──────────────────────────────────────────────────────

    if (type === 'queue-operation' || type === 'mode' || type === 'ai-title' ||
        type === 'last-prompt' || type === 'attachment') {
      // Pure metadata lines — contribute to session metadata above but no event emitted
      continue;
    }

    if (type === 'user') {
      const msg = obj.message;
      if (!msg) continue;
      const content = msg.content;

      if (Array.isArray(content)) {
        for (const block of content as RawBlock[]) {
          const btype = block.type;

          if (btype === 'text' && typeof block.text === 'string') {
            // User text message
            events.push({
              seq: seq++,
              ts,
              role: 'user',
              type: 'message',
              text: block.text || null,
              tool: null,
              stop_reason: null,
              tokens: null,
            });
          } else if (btype === 'tool_result') {
            const toolUseId = block.tool_use_id;
            const isError = block.is_error === true;
            const resultText = extractToolResultText(block.content);

            // Look up the corresponding tool name for the tool field
            const pending = toolUseId ? pendingToolUses.get(toolUseId) : undefined;
            const toolName = pending ? pending.toolName : 'unknown';

            // Compute duration if we have the start
            let duration_ms: number | null = null;
            if (pending && ts) {
              const endMs = Date.parse(ts);
              if (!isNaN(endMs) && pending.startedMs > 0) {
                duration_ms = endMs - pending.startedMs;
                if (duration_ms < 0) duration_ms = null; // Clock skew guard
              }
              // Patch the duration onto the corresponding tool_call event
              if (duration_ms !== null && events[pending.eventIndex]) {
                const callEvent = events[pending.eventIndex];
                if (callEvent.tool) {
                  callEvent.tool = { ...callEvent.tool, duration_ms };
                }
              }
              pendingToolUses.delete(toolUseId!);
            }

            const toolField: EnvelopeTool = {
              name: toolName,
              args_digest: null,
              duration_ms,
              is_error: isError,
            };

            events.push({
              seq: seq++,
              ts,
              role: 'tool',
              type: 'tool_result',
              text: resultText,
              tool: toolField,
              stop_reason: null,
              tokens: null,
            });
          }
          // Skip: image, document, and other block types
        }
      } else if (typeof content === 'string' && content) {
        events.push({
          seq: seq++,
          ts,
          role: 'user',
          type: 'message',
          text: content,
          tool: null,
          stop_reason: null,
          tokens: null,
        });
      }
      continue;
    }

    if (type === 'assistant') {
      const msg = obj.message;
      if (!msg) continue;

      // Extract model from first assistant message
      if (msg.model && !model) {
        model = msg.model;
        // Heuristic: Anthropic models start with 'claude-'
        if (!provider && model.startsWith('claude-')) {
          provider = 'anthropic';
        }
      }

      const stop_reason = msg.stop_reason ?? null;
      const usage = msg.usage;
      const tokens: EnvelopeTokens | null = (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined))
        ? { in: usage.input_tokens ?? null, out: usage.output_tokens ?? null }
        : null;

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content as RawBlock[]) {
        const btype = block.type;

        if (btype === 'text' && typeof block.text === 'string') {
          events.push({
            seq: seq++,
            ts,
            role: 'assistant',
            type: 'message',
            text: block.text || null,
            tool: null,
            stop_reason,
            tokens,
          });
        } else if (btype === 'tool_use') {
          const toolName = block.name ?? 'unknown';
          const toolUseId = block.id;
          const digest = argsDigest(block.input);

          const startMs = ts ? (Date.parse(ts) || 0) : 0;
          const eventIndex = seq; // index this event will occupy

          const toolField: EnvelopeTool = {
            name: toolName,
            args_digest: digest,
            duration_ms: null, // filled in when tool_result arrives
            is_error: false,
          };

          events.push({
            seq: seq++,
            ts,
            role: 'assistant',
            type: 'tool_call',
            text: null,
            tool: toolField,
            stop_reason,
            tokens,
          });

          // Register pending so tool_result can fill duration
          if (toolUseId) {
            pendingToolUses.set(toolUseId, { toolName, startedMs: startMs, eventIndex });
          }
        } else if (btype === 'thinking') {
          // Extended thinking block — emit as assistant message with text
          if (typeof block.thinking === 'string') {
            events.push({
              seq: seq++,
              ts,
              role: 'assistant',
              type: 'message',
              text: null, // thinking content is internal; omit to avoid verbosity / secret leakage
              tool: null,
              stop_reason,
              tokens,
            });
          }
          // Skip if no text
        }
        // Skip: image, document, redacted_thinking, etc.
      }
      continue;
    }

    if (type === 'system') {
      // system events (hook summaries, stop reasons, etc.)
      const subtype = obj.subtype as string | undefined;
      const stopReason = obj.stopReason as string | undefined;
      events.push({
        seq: seq++,
        ts,
        role: 'system',
        type: 'message',
        text: subtype ? `subtype:${subtype}` : null,
        tool: null,
        stop_reason: stopReason ?? null,
        tokens: null,
      });
      continue;
    }

    if (type === 'compaction' || type === 'summary') {
      // Compaction / context-window collapse events
      const summaryText = obj.summary as string | undefined;
      events.push({
        seq: seq++,
        ts,
        role: 'system',
        type: 'compaction',
        text: summaryText ?? null,
        tool: null,
        stop_reason: null,
        tokens: null,
      });
      continue;
    }

    // Any other type: skip (future-proof)
  }

  // ── Build session block ────────────────────────────────────────────────────

  // Derive project slug from cwd
  const project_slug = cwdToSlug(cwd);

  // Session id: from JSONL, or fall back to the filename stem
  const derivedId = sessionId ?? path.basename(rawPath, path.extname(rawPath));

  const envelope: Envelope = {
    schema_version: '1.0',
    content_hash,
    session: {
      id: derivedId,
      harness: 'claude-code',
      harness_version,
      model,
      provider,
      project_slug,
      cwd,
      started_at,
      ended_at,
      redaction: {
        scrubbed: false, // filled by scrubEnvelope below
        rules_version: '',
        hits: 0,
      },
    },
    events,
  };

  // ── Redaction gate (§2.6 / §4) ────────────────────────────────────────────
  const scrubbed = scrubEnvelope(envelope);

  // ── Schema validation ─────────────────────────────────────────────────────
  const result = validateEnvelope(scrubbed);
  if (!result.valid) {
    const detail = result.errors.map((e) => `  ${e.instancePath}: ${e.message}`).join('\n');
    throw new Error(`[WS04] Envelope schema validation failed for ${rawPath}:\n${detail}`);
  }

  // ── Persistence guard (§4 hard contract) ─────────────────────────────────
  assertPersistable(scrubbed);

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Exported adapter object
// ---------------------------------------------------------------------------

export const claudeCodeAdapter: Adapter = {
  harness: 'claude-code',
  normalize,
};
