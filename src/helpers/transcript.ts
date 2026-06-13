import fs from 'fs';
import path from 'path';
import { safeReadText } from '../helpers.js';

/** A normalized tool call extracted from a transcript. */
export interface NormalizedToolCall {
  ts: string; // ISO or best-effort
  tool: string;
  args?: unknown;
  duration_ms?: number | undefined;
}

/** A file-system mutation observed in the transcript (best-effort). */
export interface NormalizedFileChange {
  ts: string;
  path: string;
  change: 'modify' | 'create' | 'delete';
}

/** A block of agent-authored text (assistant message text content). */
export interface NormalizedAgentText {
  ts: string;
  text: string;
}

/** A user-authored message block (for decision-point detection). */
export interface NormalizedUserText {
  ts: string;
  text: string;
}

export interface NormalizedTranscript {
  format: 'jsonl-claude-code' | 'protobuf-antigravity' | 'payload' | 'unknown'
        | 'envelope-claude-code' | 'envelope-pi' | 'envelope-antigravity';
  notes?: string[];
  tool_calls: NormalizedToolCall[];
  file_changes: NormalizedFileChange[];
  agent_text_blocks: NormalizedAgentText[];
  user_text_blocks: NormalizedUserText[];
}

const FILE_TOOLS_WRITE = new Set(['Write', 'Edit', 'NotebookEdit']);
const FILE_TOOLS_DELETE = new Set<string>(); // Claude Code surfaces deletes via Bash; we don't infer here

/** Parse a Claude Code .jsonl transcript file into a normalized shape. */
export function parseClaudeCodeJsonl(filePath: string): NormalizedTranscript {
  const text = safeReadText(filePath);
  if (text === null) {
    return {
      format: 'unknown',
      notes: [`could not read ${filePath}`],
      tool_calls: [],
      file_changes: [],
      agent_text_blocks: [],
      user_text_blocks: [],
    };
  }
  const out: NormalizedTranscript = {
    format: 'jsonl-claude-code',
    tool_calls: [],
    file_changes: [],
    agent_text_blocks: [],
    user_text_blocks: [],
  };
  const lines = text.split(/\r?\n/);
  // Track tool_use_id -> { tool, ts, started_ts } so we can match tool_result for duration estimate.
  const pendingToolUses = new Map<string, { tool: string; startedAtMs: number; ts: string }>();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const type = obj.type as string | undefined;
    const ts = (obj.timestamp as string) || (obj.ts as string) || new Date(0).toISOString();
    const tsMs = Date.parse(ts) || 0;

    // Claude Code .jsonl: top-level objects with a `message` field that has `content` blocks.
    const message = obj.message as { role?: string; content?: unknown } | undefined;

    if (type === 'assistant' && message && Array.isArray(message.content)) {
      for (const block of message.content as Array<Record<string, unknown>>) {
        const btype = block.type;
        if (btype === 'text' && typeof block.text === 'string') {
          out.agent_text_blocks.push({ ts, text: block.text });
        } else if (btype === 'tool_use') {
          const toolName = (block.name as string) || 'unknown';
          const toolUseId = (block.id as string) || `auto-${out.tool_calls.length}`;
          const input = block.input;
          out.tool_calls.push({ ts, tool: toolName, args: input });
          pendingToolUses.set(toolUseId, { tool: toolName, startedAtMs: tsMs, ts });

          // File-change inference for Write/Edit/NotebookEdit
          if (FILE_TOOLS_WRITE.has(toolName) && input && typeof input === 'object') {
            const inObj = input as Record<string, unknown>;
            const fp = (inObj.file_path as string) || (inObj.path as string);
            if (typeof fp === 'string') {
              const change: 'modify' | 'create' = toolName === 'Write' ? 'create' : 'modify';
              out.file_changes.push({ ts, path: fp, change });
            }
          }
          if (FILE_TOOLS_DELETE.has(toolName) && input && typeof input === 'object') {
            const inObj = input as Record<string, unknown>;
            const fp = (inObj.file_path as string) || (inObj.path as string);
            if (typeof fp === 'string') {
              out.file_changes.push({ ts, path: fp, change: 'delete' });
            }
          }
        }
      }
    } else if (type === 'user' && message && message.content) {
      // Content can be a string OR an array of blocks; tool_result blocks live here.
      const content = message.content;
      if (typeof content === 'string') {
        out.user_text_blocks.push({ ts, text: content });
      } else if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          const btype = block.type;
          if (btype === 'text' && typeof block.text === 'string') {
            out.user_text_blocks.push({ ts, text: block.text });
          } else if (btype === 'tool_result') {
            const useId = block.tool_use_id as string | undefined;
            if (useId && pendingToolUses.has(useId)) {
              const pending = pendingToolUses.get(useId)!;
              const elapsed = tsMs > 0 ? tsMs - pending.startedAtMs : 0;
              if (elapsed > 0) {
                // Annotate the matching tool call with duration by index
                for (let i = out.tool_calls.length - 1; i >= 0; i--) {
                  const tc = out.tool_calls[i];
                  if (tc.ts === pending.ts && tc.tool === pending.tool && tc.duration_ms === undefined) {
                    tc.duration_ms = elapsed;
                    break;
                  }
                }
              }
              pendingToolUses.delete(useId);
            }
          }
        }
      }
    }
  }
  return out;
}

/** Detect format and dispatch to a parser; or return a "deferred" stub for protobuf. */
export function loadTranscript(filePath: string): NormalizedTranscript {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pb' || ext === '.protobuf' || ext === '.antigravity') {
    return {
      format: 'protobuf-antigravity',
      notes: ['protobuf parsing not implemented in v0.2'],
      tool_calls: [],
      file_changes: [],
      agent_text_blocks: [],
      user_text_blocks: [],
    };
  }
  if (ext === '.jsonl' || ext === '.ndjson') {
    return parseClaudeCodeJsonl(filePath);
  }
  // Sniff content for JSONL fallback
  const text = safeReadText(filePath);
  if (text === null) {
    return {
      format: 'unknown',
      notes: [`file not readable: ${filePath}`],
      tool_calls: [],
      file_changes: [],
      agent_text_blocks: [],
      user_text_blocks: [],
    };
  }
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine && firstLine.startsWith('{') && firstLine.endsWith('}')) {
    try {
      JSON.parse(firstLine);
      return parseClaudeCodeJsonl(filePath);
    } catch {
      // fall through
    }
  }
  return {
    format: 'unknown',
    notes: [`unrecognized transcript format for ${filePath}; expected .jsonl Claude Code or .pb Antigravity`],
    tool_calls: [],
    file_changes: [],
    agent_text_blocks: [],
    user_text_blocks: [],
  };
}

/** Convert a structured payload (as accepted by session_distill) into the normalized shape. */
export function payloadToNormalized(payload: {
  tool_calls?: Array<{ tool: string; args?: unknown; duration_ms?: number; ts: string }>;
  file_changes?: Array<{ path: string; change: 'modify' | 'create' | 'delete'; ts: string }>;
  agent_claims?: Array<{ text: string; ts: string }>;
}): NormalizedTranscript {
  return {
    format: 'payload',
    tool_calls: (payload.tool_calls ?? []).map((c) => ({
      ts: c.ts,
      tool: c.tool,
      args: c.args,
      duration_ms: c.duration_ms,
    })),
    file_changes: (payload.file_changes ?? []).map((c) => ({ ts: c.ts, path: c.path, change: c.change })),
    agent_text_blocks: (payload.agent_claims ?? []).map((c) => ({ ts: c.ts, text: c.text })),
    user_text_blocks: [],
  };
}

// ---------------------------------------------------------------------------
// Envelope → NormalizedTranscript bridge  (WS 09)
// ---------------------------------------------------------------------------

/**
 * Convert a canonical session Envelope into the NormalizedTranscript shape
 * consumed by all existing analysis helpers (detectRedundantCalls,
 * runOverclaimCheck, runNamespaceAudit, etc.).
 *
 * This is a LOSSLESS projection for what the analysis tools need:
 *  - tool_call events  → tool_calls
 *  - assistant message events → agent_text_blocks
 *  - user message events → user_text_blocks
 *  - tool_result / error events → (duration annotated back onto matching tool_call)
 *  - file_changes: inferred from Write/Edit/NotebookEdit tool args_digest names
 *    (best-effort; envelopes don't store full args, only digest)
 *
 * The returned format tag is 'envelope-<harness>' so callers can distinguish.
 */
export function envelopeToNormalized(envelope: import('../adapters/types.js').Envelope): NormalizedTranscript {
  const { session, events } = envelope;
  const format = `envelope-${session.harness}` as NormalizedTranscript['format'];

  const tool_calls: NormalizedToolCall[] = [];
  const file_changes: NormalizedFileChange[] = [];
  const agent_text_blocks: NormalizedAgentText[] = [];
  const user_text_blocks: NormalizedUserText[] = [];

  // Index tool_call events by seq so tool_result can annotate duration.
  const pendingBySeq = new Map<number, number>(); // seq → index in tool_calls

  for (const ev of events) {
    const ts = ev.ts ?? new Date(0).toISOString();

    if (ev.type === 'tool_call' && ev.tool) {
      const idx = tool_calls.length;
      tool_calls.push({
        ts,
        tool: ev.tool.name,
        // args_digest is a hash, not the real args — pass it as an opaque string
        args: ev.tool.args_digest ? { _digest: ev.tool.args_digest } : undefined,
        duration_ms: ev.tool.duration_ms ?? undefined,
      });
      pendingBySeq.set(ev.seq, idx);

      // Best-effort file-change inference from tool name (no full args in envelope)
      if (['Write', 'Edit', 'NotebookEdit'].includes(ev.tool.name)) {
        file_changes.push({ ts, path: `<redacted-digest:${ev.tool.args_digest ?? '?'}>`, change: ev.tool.name === 'Write' ? 'create' : 'modify' });
      }
    } else if (ev.type === 'tool_result' && ev.tool) {
      // Annotate duration onto the matching tool_call (if not already set)
      const matchSeq = ev.seq - 1; // heuristic: result immediately follows call
      // Walk backward to find a matching tool call by name
      for (let i = tool_calls.length - 1; i >= 0; i--) {
        const tc = tool_calls[i];
        if (tc.tool === ev.tool.name && tc.duration_ms === undefined && ev.tool.duration_ms !== null) {
          tc.duration_ms = ev.tool.duration_ms ?? undefined;
          break;
        }
      }
      void matchSeq; // suppress unused-variable lint
    } else if (ev.type === 'message') {
      if (ev.role === 'assistant' && ev.text) {
        agent_text_blocks.push({ ts, text: ev.text });
      } else if ((ev.role === 'user' || ev.role === 'system') && ev.text) {
        user_text_blocks.push({ ts, text: ev.text });
      }
    } else if (ev.type === 'error' && ev.text) {
      // Surface errors as agent text so overclaim/decision detectors can see them
      agent_text_blocks.push({ ts, text: `[ERROR] ${ev.text}` });
    }
  }

  return { format, tool_calls, file_changes, agent_text_blocks, user_text_blocks };
}

/**
 * Load an envelope JSON file and convert it to NormalizedTranscript.
 * Returns an 'unknown' transcript with a note on read/parse failure.
 */
export function loadEnvelope(envelopePath: string): NormalizedTranscript {
  const text = safeReadText(envelopePath);
  if (text === null) {
    return {
      format: 'unknown',
      notes: [`could not read envelope: ${envelopePath}`],
      tool_calls: [], file_changes: [], agent_text_blocks: [], user_text_blocks: [],
    };
  }
  let envelope: import('../adapters/types.js').Envelope;
  try {
    envelope = JSON.parse(text);
  } catch (e) {
    return {
      format: 'unknown',
      notes: [`could not parse envelope JSON at ${envelopePath}: ${e}`],
      tool_calls: [], file_changes: [], agent_text_blocks: [], user_text_blocks: [],
    };
  }
  if (!envelope || typeof envelope !== 'object' || !envelope.session || !Array.isArray(envelope.events)) {
    return {
      format: 'unknown',
      notes: [`not a valid envelope at ${envelopePath}: missing session or events`],
      tool_calls: [], file_changes: [], agent_text_blocks: [], user_text_blocks: [],
    };
  }
  return envelopeToNormalized(envelope);
}

/** Walk a directory for files with a given extension, with optional mtime cutoff. */
export function findRecentFiles(root: string, exts: string[], sinceMs: number, maxFiles = 1000): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  function recur(dir: string, depth: number) {
    if (depth > 6 || out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        recur(full, depth + 1);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (!exts.some((e) => lower.endsWith(e))) continue;
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= sinceMs) out.push(full);
        } catch {
          // ignore
        }
      }
    }
  }
  recur(root, 0);
  return out;
}
