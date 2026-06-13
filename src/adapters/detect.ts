/**
 * Format detection for session transcript files — WS 01 (HIVE_CONTEXT_SESSIONS).
 *
 * Sniffs the first N lines of a JSONL file (or checks path/magic bytes for
 * binary formats) and returns the harness name.
 *
 * Disambiguation rules (in priority order, matching code execution):
 *  1. `.pb` extension OR `.protobuf` OR `.antigravity` extension → antigravity
 *  2. File is inside a `brain/` directory component → antigravity
 *  3. SQLite magic header ("SQLite format 3") OR protobuf first byte (0x0A) → antigravity.
 *     SQLite detection is the REAL signal for Antigravity sessions:
 *     `~/.gemini/antigravity/conversations/<uuid>.db` — a SQLite DB whose
 *     `steps.step_payload` cells are protobuf (WS 06 finding).
 *  4. JSONL sniff: first line is `{"type":"queue-operation",...}` → claude-code
 *  5. JSONL sniff: first line has `"type":"session"` AND (second has `"model_change"` OR first has `"model_slug"`) → pi
 *  6. JSONL sniff: any line among first N has `type:"message"/"assistant"/"user"` with a `"uuid"` key → claude-code
 *  7. JSONL sniff: any line has `"type":"summary"` with `"leafUuid"` key → claude-code (compaction)
 *  8. Unknown
 */

import fs from 'fs';
import path from 'path';
import type { Envelope } from './types.js';

export type HarnessName = Envelope['session']['harness'];
export type DetectResult = HarnessName | 'unknown';

/** Number of lines to read for JSONL sniffing. */
const SNIFF_LINES = 20;

/** Bytes to read for binary magic-byte sniff. */
const MAGIC_BYTES_READ = 16;

/**
 * Detect the harness format of a session transcript file.
 *
 * @param filePath Absolute path to the raw transcript.
 * @returns The harness name, or `'unknown'` if it cannot be determined.
 */
export function detect(filePath: string): DetectResult {
  const normalized = path.normalize(filePath);
  const ext = path.extname(normalized).toLowerCase();

  // ── 1. Extension check for known binary formats ──
  if (ext === '.pb' || ext === '.protobuf' || ext === '.antigravity') {
    return 'antigravity';
  }

  // ── 2. Path component check — inside a brain/ directory ──
  const parts = normalized.split(path.sep);
  if (parts.some((p) => p.toLowerCase() === 'brain')) {
    return 'antigravity';
  }

  // ── 3. Magic-byte check — protobuf wire type (0x0A = field 1, length-delimited) ──
  try {
    const fd = fs.openSync(normalized, 'r');
    const buf = Buffer.alloc(MAGIC_BYTES_READ);
    const bytesRead = fs.readSync(fd, buf, 0, MAGIC_BYTES_READ, 0);
    fs.closeSync(fd);
    if (bytesRead > 0) {
      // SQLite magic header → Antigravity (sessions are SQLite .db files under
      // ~/.gemini/antigravity/conversations/; step payloads are protobuf). WS 06.
      if (buf.slice(0, 15).toString('latin1') === 'SQLite format 3') {
        return 'antigravity';
      }
      // If first byte is 0x0A and file is not valid UTF-8 JSON → protobuf
      const firstByte = buf[0];
      if (firstByte === 0x0a) {
        // Could also be a JSON object starting with `\n` (rare). Verify not text.
        const snippet = buf.slice(0, bytesRead).toString('utf-8', 0, Math.min(bytesRead, 4));
        if (!snippet.trim().startsWith('{') && !snippet.trim().startsWith('[')) {
          return 'antigravity';
        }
      }
    }
  } catch {
    // Unreadable — fall through to unknown
    return 'unknown';
  }

  // ── 4. JSONL sniff ──
  let lines: string[];
  try {
    const raw = fs.readFileSync(normalized, { encoding: 'utf-8' });
    lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, SNIFF_LINES);
  } catch {
    return 'unknown';
  }

  if (lines.length === 0) return 'unknown';

  // Parse first N lines as JSON objects (best-effort)
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      parsed.push(obj);
    } catch {
      // ignore unparseable lines
    }
  }

  if (parsed.length === 0) return 'unknown';

  const first = parsed[0];
  const second = parsed[1];

  // ── 5. Claude Code: queue-operation as first event ──
  if (first['type'] === 'queue-operation') {
    return 'claude-code';
  }

  // ── 6. Pi: type:session in first object, corroborated by model_change or model_slug ──
  //     WS 05 has not empirically verified that type:session alone is Pi-specific.
  //     Require at least one corroborating signal before returning 'pi'; otherwise
  //     fall through to 'unknown' so a misidentified format doesn't silently corrupt
  //     normalization.
  if (first['type'] === 'session') {
    // Pi sessions typically open with a session metadata object followed by model_change
    if (second && typeof second['type'] === 'string' && second['type'] === 'model_change') {
      return 'pi';
    }
    // Also accept if the first object has a `model_slug` key (Pi-specific field)
    if (typeof first['model_slug'] === 'string') {
      return 'pi';
    }
    // type:session without corroboration — fall through to unknown
    return 'unknown';
  }

  // ── 7. Claude Code: any line has type:message with uuid key ──
  for (const obj of parsed) {
    const t = obj['type'];
    if ((t === 'message' || t === 'assistant' || t === 'user') && typeof obj['uuid'] === 'string') {
      return 'claude-code';
    }
    // Claude Code compaction: type:summary with leafUuid
    if (t === 'summary' && typeof obj['leafUuid'] === 'string') {
      return 'claude-code';
    }
  }

  return 'unknown';
}
