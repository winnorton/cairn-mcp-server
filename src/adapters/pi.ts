/**
 * Pi (pi.dev) session adapter — WS 05 (HIVE_CONTEXT_SESSIONS).
 *
 * Normalizes Pi `.jsonl` session transcripts into the canonical Envelope
 * (§2.1 of SPEC_HIVE_CONTEXT_SESSIONS_00_PROGRAM).
 *
 * Pi JSONL shape (empirically verified 2026-06-13 against a real cwar-engine
 * session — 019ea817-2781-74b8-967f-211d4e8cb5ca, 436 lines, 1 MB):
 *
 *   Line 1  {"type":"session","version":3,"id":"<uuid>","timestamp":"<iso>","cwd":"<path>"}
 *   Line 2  {"type":"model_change","parentId":null,"provider":"spark","modelId":"minimax-m2.7",...}
 *   Line 3  {"type":"thinking_level_change","thinkingLevel":"high",...}
 *   ...
 *   {"type":"message","id":"...","timestamp":"<iso>","message":{
 *     "role":"user"        → content:[{type:"text",text:"..."}]
 *     "role":"assistant"   → content:[{type:"text",...},{type:"toolCall","name":"...","arguments":{}}]
 *                           + usage:{input,output,...} + stopReason:"toolUse"|"endTurn"
 *     "role":"toolResult"  → toolCallId:"...", toolName:"...", content:[{type:"text",text:"..."}],
 *                           isError:true|false
 *   }}
 *   {"type":"compaction","id":"...","timestamp":"<iso>","summary":"<text>"}
 *   {"type":"thinking_level_change",...}  (ignored — no envelope slot)
 *
 * PI PARSER DISCREPANCY RESOLVED:
 *   The existing `src/helpers/transcript.ts` does NOT handle Pi. The `loadTranscript`
 *   function dispatches `.jsonl` files to `parseClaudeCodeJsonl()`, which only recognises
 *   Claude Code's top-level `type:"assistant"` / `type:"user"` objects (with a `message`
 *   field containing `content` blocks). Pi events carry the same outer `type` field names
 *   but the inner shape is entirely different (Pi's events are always `type:"message"` with
 *   a nested `role`; Claude Code events are `type:"assistant"` or `type:"user"` at the top
 *   level). Feeding a Pi `.jsonl` to `parseClaudeCodeJsonl()` produces an empty result
 *   (0 tool_calls, 0 text blocks) — it does not error but is silently wrong.
 *   The `/session-distill` markdown skill's "Pi auto-detect" claim is therefore unverified
 *   at the code level; it worked at best by coincidence or was aspirational.
 *   This adapter is the first working Pi parser in the codebase.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type {
  Adapter,
  Envelope,
  EnvelopeEvent,
  EnvelopeSession,
} from './types.js';
import { computeContentHash, validateEnvelope, assertPersistable } from '../helpers/envelope_validator.js';
import { scrubEnvelope } from '../redaction/scrub.js';
import { cwdToSlug } from '../helpers/slug.js';

// ---------------------------------------------------------------------------
// Internal Pi raw-event types
// ---------------------------------------------------------------------------

interface PiSessionEvent {
  type: 'session';
  version?: number;
  id: string;
  timestamp: string;
  cwd?: string;
}

interface PiModelChangeEvent {
  type: 'model_change';
  id: string;
  timestamp: string;
  provider?: string;
  modelId?: string;
}

interface PiMessageContent {
  type: string; // "text" | "toolCall"
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface PiUserMessage {
  role: 'user';
  content: PiMessageContent[];
  timestamp?: number;
}

interface PiAssistantMessage {
  role: 'assistant';
  content: PiMessageContent[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
  stopReason?: string;
  timestamp?: number;
}

interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId?: string;
  toolName?: string;
  content: PiMessageContent[];
  isError?: boolean;
  timestamp?: number;
}

type PiInnerMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

interface PiMessageEvent {
  type: 'message';
  id: string;
  parentId?: string;
  timestamp: string;
  message: PiInnerMessage;
}

interface PiCompactionEvent {
  type: 'compaction';
  id: string;
  timestamp: string;
  summary?: string;
}

type PiEvent =
  | PiSessionEvent
  | PiModelChangeEvent
  | PiMessageEvent
  | PiCompactionEvent
  | { type: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a provider label from Pi's provider field.
 * Pi uses "spark" as an internal routing name; map it to a human-readable
 * form. When the raw provider is already meaningful, pass it through.
 */
function normalizeProvider(provider: string | undefined): string | null {
  if (!provider) return null;
  // Pi routes through "spark" which proxies e.g. Minimax, OpenAI, Anthropic
  // We keep the raw provider; callers can enrich from modelId if needed.
  return provider;
}

/**
 * SHA-256 digest of a string value — used for args_digest on tool calls.
 * Truncated to 16 hex chars for compactness.
 */
function digestArgs(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  const s = typeof args === 'string' ? args : JSON.stringify(args);
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Extract the ISO-8601 timestamp from a Pi event outer object.
 * Pi always stores timestamps on the outer envelope as ISO strings.
 */
function ts(event: { timestamp?: string }): string | null {
  return event.timestamp ?? null;
}

// ---------------------------------------------------------------------------
// Core normalizer
// ---------------------------------------------------------------------------

/**
 * Parse a Pi `.jsonl` session file into a canonical Envelope.
 *
 * Pure / deterministic: identical raw bytes → identical envelope.
 * Calls scrubEnvelope(), validateEnvelope(), and assertPersistable() internally.
 * Returns a fully-scrubbed, schema-valid envelope ready for persistence (§4).
 */
function normalize(rawPath: string): Envelope {
  // ── Read raw bytes ──
  const raw = fs.readFileSync(rawPath, 'utf-8');
  const content_hash = computeContentHash(rawPath);

  // ── Parse JSONL ──
  const rawLines = raw.split(/\r?\n/);
  const piEvents: PiEvent[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      piEvents.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      // Skip malformed lines — Pi sessions occasionally have trailing garbage
    }
  }

  // ── Extract session metadata from header events ──
  let sessionId = path.basename(rawPath, '.jsonl').split('_').slice(1).join('_');
  let sessionCwd: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let model: string | null = null;
  let provider: string | null = null;
  let harness_version: string | null = null;

  // First pass: pick up session header + first model_change
  for (const evt of piEvents) {
    if (evt.type === 'session') {
      const s = evt as PiSessionEvent;
      sessionId = s.id || sessionId;
      sessionCwd = s.cwd ?? null;
      startedAt = s.timestamp ?? null;
      if (s.version !== undefined) {
        harness_version = String(s.version);
      }
    } else if (evt.type === 'model_change' && !model) {
      const mc = evt as PiModelChangeEvent;
      model = mc.modelId ?? null;
      provider = normalizeProvider(mc.provider);
    }
  }

  // ended_at = timestamp of the last event that has a timestamp
  for (let i = piEvents.length - 1; i >= 0; i--) {
    const evt = piEvents[i] as { timestamp?: string };
    if (evt.timestamp) {
      endedAt = evt.timestamp;
      break;
    }
  }

  const project_slug = cwdToSlug(sessionCwd);

  // ── Build envelope events array ──
  const events: EnvelopeEvent[] = [];
  let seq = 0;

  // Track tool call durations: toolCallId → timestamp of the corresponding
  // assistant message that emitted the toolCall
  const toolCallStartMs = new Map<string, number>();
  // Track tool call names for tool results
  const toolCallNames = new Map<string, string>();

  for (const evt of piEvents) {
    const evtType = evt.type;

    // session header → already consumed above, skip as event
    if (evtType === 'session') continue;

    if (evtType === 'model_change') {
      const mc = evt as PiModelChangeEvent;
      events.push({
        seq: seq++,
        ts: ts(mc),
        role: 'system',
        type: 'model_change',
        text: mc.modelId ? `model_change → ${mc.provider ?? ''}/${mc.modelId}` : 'model_change',
        tool: null,
        stop_reason: null,
        tokens: null,
      });
      continue;
    }

    if (evtType === 'compaction') {
      const comp = evt as PiCompactionEvent;
      events.push({
        seq: seq++,
        ts: ts(comp),
        role: 'system',
        type: 'compaction',
        text: comp.summary ?? null,
        tool: null,
        stop_reason: null,
        tokens: null,
      });
      continue;
    }

    if (evtType === 'thinking_level_change') {
      // No envelope slot for thinking-level changes; skip silently.
      continue;
    }

    if (evtType === 'message') {
      const msgEvt = evt as PiMessageEvent;
      const msg = msgEvt.message;
      const role = msg.role;
      const eventTs = ts(msgEvt);
      const eventTsMs = eventTs ? Date.parse(eventTs) : 0;

      if (role === 'user') {
        const userMsg = msg as PiUserMessage;
        // Collect all text blocks into one event
        const texts: string[] = [];
        for (const block of userMsg.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text);
          }
        }
        events.push({
          seq: seq++,
          ts: eventTs,
          role: 'user',
          type: 'message',
          text: texts.join('\n') || null,
          tool: null,
          stop_reason: null,
          tokens: null,
        });

      } else if (role === 'assistant') {
        const asstMsg = msg as PiAssistantMessage;
        const usage = asstMsg.usage;
        const tokens = usage
          ? { in: usage.input ?? null, out: usage.output ?? null }
          : null;
        const stopReason = asstMsg.stopReason ?? null;

        // Collect text blocks and tool calls
        const texts: string[] = [];
        const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
        for (const block of asstMsg.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            texts.push(block.text);
          } else if (block.type === 'toolCall') {
            toolCalls.push({
              id: block.id ?? '',
              name: block.name ?? 'unknown',
              args: block.arguments,
            });
          }
        }

        // If no tool calls, emit one message event with text
        if (toolCalls.length === 0) {
          events.push({
            seq: seq++,
            ts: eventTs,
            role: 'assistant',
            type: 'message',
            text: texts.join('\n') || null,
            tool: null,
            stop_reason: stopReason,
            tokens: tokens,
          });
        } else {
          // Emit one tool_call event per tool call.
          // If there's also text, emit it as a preceding message event.
          const combinedText = texts.join('\n') || null;
          if (combinedText) {
            events.push({
              seq: seq++,
              ts: eventTs,
              role: 'assistant',
              type: 'message',
              text: combinedText,
              tool: null,
              stop_reason: null,
              tokens: null,
            });
          }
          for (const tc of toolCalls) {
            // Record start time and name for duration calculation in tool results
            if (tc.id && eventTsMs) {
              toolCallStartMs.set(tc.id, eventTsMs);
            }
            if (tc.id && tc.name) {
              toolCallNames.set(tc.id, tc.name);
            }
            events.push({
              seq: seq++,
              ts: eventTs,
              role: 'assistant',
              type: 'tool_call',
              text: null,
              tool: {
                name: tc.name,
                args_digest: digestArgs(tc.args),
                duration_ms: null, // filled below when we see the result
                is_error: false,
              },
              stop_reason: stopReason,
              // Tokens on the first tool call; null for subsequent
              tokens: tokens,
            });
          }
        }

      } else if (role === 'toolResult') {
        const trMsg = msg as PiToolResultMessage;
        const toolCallId = trMsg.toolCallId ?? '';
        const toolName = trMsg.toolName ?? toolCallNames.get(toolCallId) ?? 'unknown';
        const isError = trMsg.isError ?? false;

        // Compute duration if we have a matching start time
        let duration_ms: number | null = null;
        if (toolCallId && toolCallStartMs.has(toolCallId) && eventTsMs) {
          const startMs = toolCallStartMs.get(toolCallId)!;
          const elapsed = eventTsMs - startMs;
          if (elapsed >= 0) duration_ms = elapsed;
          toolCallStartMs.delete(toolCallId);
        }

        const texts: string[] = [];
        for (const block of trMsg.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text);
          }
        }

        events.push({
          seq: seq++,
          ts: eventTs,
          role: 'tool',
          type: 'tool_result',
          text: texts.join('\n') || null,
          tool: {
            name: toolName,
            args_digest: null,
            duration_ms,
            is_error: isError,
          },
          stop_reason: null,
          tokens: null,
        });
      }
      // Other message roles (if any future Pi version adds them) fall through.
      continue;
    }

    // Unknown event types — emit as system/message with raw JSON text
    // so they're not silently dropped and the envelope remains complete.
    const unknown = evt as { timestamp?: string };
    events.push({
      seq: seq++,
      ts: ts(unknown),
      role: 'system',
      type: 'message',
      text: JSON.stringify(evt),
      tool: null,
      stop_reason: null,
      tokens: null,
    });
  }

  // ── Assemble session block ──
  const session: EnvelopeSession = {
    id: sessionId,
    harness: 'pi',
    harness_version,
    model,
    provider,
    project_slug,
    cwd: sessionCwd,
    started_at: startedAt,
    ended_at: endedAt,
    // Placeholder — scrubEnvelope() below replaces this with the real values.
    redaction: {
      scrubbed: false,
      rules_version: '',
      hits: 0,
    },
  };

  const envelope: Envelope = {
    schema_version: '1.0',
    content_hash,
    session,
    events,
  };

  // ── Apply redaction (§4 gate — in-normalization) ──
  const scrubbed = scrubEnvelope(envelope);

  // ── Schema validation ─────────────────────────────────────────────────────
  const result = validateEnvelope(scrubbed);
  if (!result.valid) {
    const detail = result.errors.map((e) => `  ${e.instancePath}: ${e.message}`).join('\n');
    throw new Error(`[WS05] Envelope schema validation failed for ${rawPath}:\n${detail}`);
  }

  // ── Persistence guard (§4 hard contract) ─────────────────────────────────
  assertPersistable(scrubbed);

  return scrubbed;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const piAdapter: Adapter = {
  harness: 'pi',
  normalize,
};
