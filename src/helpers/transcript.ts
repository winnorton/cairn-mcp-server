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
  format: 'jsonl-claude-code' | 'protobuf-antigravity' | 'payload' | 'unknown';
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
