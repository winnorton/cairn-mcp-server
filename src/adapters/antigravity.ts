/**
 * Antigravity adapter — WS 06 (HIVE_CONTEXT_SESSIONS).
 *
 * Normalizes an Antigravity conversation SQLite database
 * (~/.gemini/antigravity/conversations/<uuid>.db) into the canonical Envelope.
 *
 * FIDELITY: BEST-EFFORT (deferral D1 applies)
 * ─────────────────────────────────────────────
 * Antigravity stores step payloads as binary protobuf without a bundled .proto
 * schema. This adapter uses wire-type-aware generic decoding (no generated
 * code, no schema) to extract text/role/timestamp signal. Field assignments
 * were reverse-engineered from a real session spike (session
 * 01ccc93c-3fba-411d-87f5-2e780175398f) on 2026-06-13.
 *
 * Field map (confirmed by spike):
 *   step_type 14 → user message; payload field[19] re-decoded → field[2] = text
 *   step_type 15 → assistant response; payload field[20] nested → field[1] = text
 *   step_type 5,7,8,9,21 → tool call/result; nested field[2]=name, field[3]=args JSON
 *   step_type 23 → title event (emitted as system message)
 *   step_type 101 → system event with log text in nested field
 *   step_type 98 → context/preamble (skipped)
 *   steps.metadata field[1] nested → field[1]=seconds, field[2]=nanos → ISO timestamp
 *
 * D1 follow-up: SPEC_HIVE_CONTEXT_SESSIONS_06b_ANTIGRAVITY_FULL_DECODE.md should be
 * drafted to recover the complete .proto schema (via the Antigravity CLI binary or
 * gRPC reflection) for full-fidelity token counts and structured tool results.
 *
 * Node built-in SQLite (node:sqlite, available since Node v22.5 / stable in v24)
 * is used — no external sqlite dep required.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

// node:sqlite is available as a built-in since Node v22.5 (stable in v24).
// We import via createRequire so this ESM module works without a top-level
// await and remains synchronous — DatabaseSync is a sync API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _DatabaseSync: any = null;
function getDb(dbPath: string) {
  if (!_DatabaseSync) {
    const req = createRequire(import.meta.url);
    ({ DatabaseSync: _DatabaseSync } = req('node:sqlite') as { DatabaseSync: unknown });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return new (_DatabaseSync as any)(dbPath);
}

import type { Adapter, Envelope, EnvelopeEvent } from './types.js';
import { computeContentHash, validateEnvelope, assertPersistable } from '../helpers/envelope_validator.js';
import { scrubEnvelope } from '../redaction/scrub.js';
import { cwdToSlug } from '../helpers/slug.js';

// ── Fidelity label stamped into the session ──────────────────────────────────
const FIDELITY = 'best-effort' as const;

// ── Step type constants (reverse-engineered) ──────────────────────────────────
const STEP_USER_MSG = 14;
const STEP_ASSISTANT_MSG = 15;
/** Tool call variants: view_file(8), list_dir(9), grep(7), write(5), run_command(21) */
const STEP_TOOL_CALL = new Set([5, 7, 8, 9, 21]);
const STEP_TITLE = 23;
const STEP_SYSTEM = 101;
/** Context / preamble steps — skipped */
const STEP_SKIP = new Set([98]);

// ── Minimal wire-type-aware protobuf decoder (no schema) ─────────────────────

interface ProtoField {
  fn: number;
  wt: 0 | 1 | 2 | 5;
  /** varint value (wt=0) */
  varint?: bigint;
  /** int64 value (wt=1) */
  i64?: bigint;
  /** utf-8 string (wt=2, if cleanly decodable) */
  str?: string;
  /** nested proto fields (wt=2, when not a clean string) */
  nested?: ProtoField[];
  /** raw byte length (wt=2, when too binary to be either) */
  rawLen?: number;
}

const MAX_DECODE_DEPTH = 5;
const MAX_STRING_LEN = 65536; // 64 KB – skip absurdly large strings

function decodeProto(buf: Buffer, depth = 0): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = 0;

  while (pos < buf.length) {
    // ── Read tag varint ──
    let tag = 0n, shift = 0;
    let b: number;
    try {
      do {
        if (pos >= buf.length) return fields;
        b = buf[pos++]!;
        tag |= BigInt(b & 0x7f) << BigInt(shift);
        shift += 7;
      } while (b & 0x80);
    } catch {
      return fields;
    }

    const fn = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (fn === 0 || fn > 10_000) return fields; // sentinel / garbage

    if (wt === 0) {
      // varint
      let val = 0n; shift = 0;
      do {
        if (pos >= buf.length) return fields;
        b = buf[pos++]!;
        val |= BigInt(b & 0x7f) << BigInt(shift);
        shift += 7;
      } while (b & 0x80);
      fields.push({ fn, wt: 0, varint: val });
    } else if (wt === 2) {
      // length-delimited
      let len = 0; shift = 0;
      do {
        if (pos >= buf.length) return fields;
        b = buf[pos++]!;
        len |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      if (len < 0 || pos + len > buf.length) return fields;
      const data = buf.subarray(pos, pos + len);
      pos += len;

      // Try UTF-8 string
      let str: string | null = null;
      if (len <= MAX_STRING_LEN) {
        try {
          const s = data.toString('utf-8');
          const nonPrint = (s.match(/[^\x09\x0a\x0d\x20-\x7e]/g) ?? []).length;
          if (nonPrint / Math.max(s.length, 1) < 0.1) str = s;
        } catch {
          // not utf-8
        }
      }
      if (str !== null) {
        fields.push({ fn, wt: 2, str });
      } else if (depth < MAX_DECODE_DEPTH && len >= 2) {
        const nested = decodeProto(data, depth + 1);
        fields.push({ fn, wt: 2, nested });
      } else {
        fields.push({ fn, wt: 2, rawLen: len });
      }
    } else if (wt === 1) {
      // 64-bit
      if (pos + 8 > buf.length) return fields;
      const lo = buf.readUInt32LE(pos);
      const hi = buf.readUInt32LE(pos + 4);
      fields.push({ fn, wt: 1, i64: BigInt(lo) | (BigInt(hi) << 32n) });
      pos += 8;
    } else if (wt === 5) {
      // 32-bit
      pos += 4;
    } else {
      return fields; // unknown wire type — stop
    }
  }
  return fields;
}

/** Recursively re-decode a proto-encoded string value. */
function reDecodeStr(s: string): ProtoField[] {
  return decodeProto(Buffer.from(s, 'utf-8'));
}

/** Get the first field with the given field number and a string value. */
function getStr(fields: ProtoField[], fn: number): string | null {
  for (const f of fields) {
    if (f.fn === fn && f.str !== undefined) return f.str;
  }
  return null;
}

/** Get the first nested field-list for a given field number. */
function getNested(fields: ProtoField[], fn: number): ProtoField[] | null {
  for (const f of fields) {
    if (f.fn === fn && f.nested !== undefined) return f.nested;
  }
  return null;
}

/** Get the first varint value for a given field number. */
function getVarint(fields: ProtoField[], fn: number): bigint | null {
  for (const f of fields) {
    if (f.fn === fn && f.varint !== undefined) return f.varint;
  }
  return null;
}

// ── Timestamp extraction ──────────────────────────────────────────────────────

/**
 * Extract an ISO-8601 timestamp from a step's `metadata` BLOB.
 *
 * The metadata proto has a top-level field[1] (nested) containing:
 *   field[1] = seconds (varint), field[2] = nanos (varint)
 */
function extractTimestamp(metaBlob: Buffer | Uint8Array | null): string | null {
  if (!metaBlob) return null;
  try {
    const top = decodeProto(Buffer.from(metaBlob));
    const inner = getNested(top, 1);
    if (!inner) return null;
    const secs = getVarint(inner, 1);
    if (secs === null) return null;
    const nanos = getVarint(inner, 2) ?? 0n;
    const ms = Number(secs) * 1000 + Math.round(Number(nanos) / 1_000_000);
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

// ── Text extraction helpers ───────────────────────────────────────────────────

/**
 * Extract the user message text from a step_type=14 payload.
 *
 * Structure: payload → field[19] (proto-encoded string) re-decoded → field[2] = text
 */
function extractUserText(payload: Buffer): string | null {
  const top = decodeProto(payload);
  const f19 = top.find((f) => f.fn === 19);
  if (!f19) return null;

  // field 19 may come back as a "string" value that is itself proto-encoded
  if (f19.str !== undefined) {
    const sub = reDecodeStr(f19.str);
    const text = getStr(sub, 2);
    if (text) return text.replace(/^\//u, '').trim(); // strip leading '/'
  }
  // OR as nested
  if (f19.nested) {
    const text = getStr(f19.nested, 2);
    if (text) return text.replace(/^\//u, '').trim();
  }
  return null;
}

/**
 * Extract the assistant message text from a step_type=15 payload.
 *
 * Structure: payload → field[20] (nested) → field[1] = text
 * Falls back to field[8] (same message, echoed in a second slot).
 */
function extractAssistantText(payload: Buffer): string | null {
  const top = decodeProto(payload);
  // field 20 is the message content wrapper
  const f20 = getNested(top, 20);
  if (f20) {
    const t1 = getStr(f20, 1);
    if (t1 && t1.length > 0) return t1.trim();
    const t8 = getStr(f20, 8);
    if (t8 && t8.length > 0) return t8.trim();
  }
  return null;
}

/**
 * Extract tool name + args JSON from a tool-call step payload.
 *
 * Structure: payload → nested (one level in) → field[2]=name, field[3]=args
 */
function extractToolCall(payload: Buffer): { name: string; argsJson: string | null } | null {
  const top = decodeProto(payload);
  // Tool info is in a nested sub-message; scan all nested fields for name+args
  for (const f of top) {
    if (f.nested) {
      const name = getStr(f.nested, 2);
      const args = getStr(f.nested, 3);
      if (name && /^[a-zA-Z_][\w_]*$/.test(name)) {
        return { name, argsJson: args ?? null };
      }
    }
  }
  // Fallback: try top-level
  for (const f of top) {
    if (f.str && /^[a-zA-Z_][\w_]*$/.test(f.str) && f.str.length < 60) {
      return { name: f.str, argsJson: null };
    }
  }
  return null;
}

/**
 * Extract a title/label string from a step_type=23 payload.
 */
function extractTitleText(payload: Buffer): string | null {
  const top = decodeProto(payload);
  const f20 = getNested(top, 20);
  if (f20) {
    // Look for field 'c' (field 3) which was "Minimizing Gamemode Feature Coverage" in spike
    const t = getStr(f20, 3) ?? getStr(f20, 2) ?? getStr(f20, 1);
    if (t && t.length > 0) return t.trim();
  }
  return null;
}

/**
 * Extract system log text from a step_type=101 payload.
 * The spike found: deeply nested string containing "[Message] timestamp=..."
 */
function extractSystemText(payload: Buffer): string | null {
  // Do a flat string sweep
  const flat = flatStrings(decodeProto(payload));
  const logLine = flat.find((s) => s.includes('[Message]') || s.includes('timestamp='));
  return logLine ?? flat.find((s) => s.length > 20) ?? null;
}

/** Flatten all string values out of a proto field tree. */
function flatStrings(fields: ProtoField[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (f.str !== undefined) out.push(f.str);
    if (f.nested) out.push(...flatStrings(f.nested));
  }
  return out;
}

// ── SHA-256 of args JSON (deterministic args_digest) ─────────────────────────

function digestArgs(argsJson: string | null): string | null {
  if (!argsJson) return null;
  return createHash('sha256').update(argsJson).digest('hex').slice(0, 16);
}

// ── Metadata extraction from trajectory_metadata_blob ────────────────────────

interface SessionMeta {
  /** Decoded filesystem path (file:// prefix stripped, percent-decoded). */
  cwd: string | null;
  /**
   * Raw cwd value as stored in the proto blob (field[7], typically a file://
   * URL). Passed to cwdToSlug() so the slug uses the canonical helper and
   * matches the slugs produced by the CC and Pi adapters.
   */
  rawCwd: string | null;
  // sessionUuid is always the cascade_id (DB filename UUID) — field[18] in the
  // metadata blob is the user/installation UUID, shared across all sessions.
}

function extractSessionMeta(
  metaBlob: Buffer | Uint8Array | null,
  _cascadeId: string,
): SessionMeta {
  let rawCwd: string | null = null;
  let cwd: string | null = null;

  if (metaBlob) {
    try {
      const top = decodeProto(Buffer.from(metaBlob));
      // field 7 = file:// URL of cwd (may be percent-encoded)
      rawCwd = getStr(top, 7) ?? null;
      if (rawCwd) {
        // Decode for the human-readable cwd field: strip file:// and percent-decode
        try { cwd = decodeURIComponent(rawCwd.replace(/^file:\/\/\//u, '')); } catch { cwd = rawCwd; }
      }
    } catch {
      // ignore decode errors
    }
  }

  return { cwd, rawCwd };
}

// ── Model extraction from gen_metadata ───────────────────────────────────────

function extractModel(db: ReturnType<typeof getDb>): string | null {
  try {
    const row = db.prepare('SELECT data FROM gen_metadata WHERE idx=0').get() as
      | { data: Uint8Array }
      | undefined;
    if (!row?.data) return null;
    const fields = decodeProto(Buffer.from(row.data));
    // field 19 = model string (confirmed: "gemini-3-flash-b")
    const model = getStr(fields, 19);
    if (model) return model;
    // Fallback: sweep all strings for something that looks like a model name
    const flat = flatStrings(fields);
    return flat.find((s) => s.startsWith('gemini-') || s.startsWith('claude-')) ?? null;
  } catch {
    return null;
  }
}

// ── normalize() — the public adapter entry point ──────────────────────────────

function normalize(rawPath: string): Envelope {
  const absPath = path.resolve(rawPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`[antigravity adapter] File not found: ${absPath}`);
  }

  // Content hash of the raw DB file
  const content_hash = computeContentHash(absPath);

  // Open the SQLite database
  const db = getDb(absPath);

  // ── Trajectory metadata ──────────────────────────────────────────────────
  const trajMeta = db
    .prepare('SELECT trajectory_id, cascade_id, trajectory_type, source FROM trajectory_meta')
    .get() as
    | { trajectory_id: string; cascade_id: string; trajectory_type: number; source: number }
    | undefined;

  const cascadeId: string = trajMeta?.cascade_id ?? path.basename(absPath, '.db');

  // ── Trajectory metadata blob (cwd, project_slug, extra UUID) ─────────────
  const metaBlobRow = db
    .prepare("SELECT data FROM trajectory_metadata_blob WHERE id='main'")
    .get() as { data: Uint8Array } | undefined;

  const { cwd, rawCwd } = extractSessionMeta(
    metaBlobRow?.data ?? null,
    cascadeId,
  );
  // Derive project_slug using the canonical shared helper (N5 — cross-harness
  // consistency). Pass rawCwd (the file:// URL) so cwdToSlug can strip the
  // prefix using its own logic, matching what Pi and CC produce from the same
  // decoded path.
  const projectSlug = cwdToSlug(rawCwd ?? cwd);

  // ── Model ────────────────────────────────────────────────────────────────
  const model = extractModel(db);

  // ── Steps ────────────────────────────────────────────────────────────────
  const steps = db
    .prepare('SELECT idx, step_type, step_payload, metadata FROM steps ORDER BY idx')
    .all() as Array<{
    idx: number;
    step_type: number;
    step_payload: Uint8Array;
    metadata: Uint8Array | null;
  }>;

  const events: EnvelopeEvent[] = [];
  let seq = 0;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  for (const step of steps) {
    if (STEP_SKIP.has(step.step_type)) continue;

    const payload = Buffer.from(step.step_payload);
    const ts = extractTimestamp(step.metadata ?? null);

    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }

    if (step.step_type === STEP_USER_MSG) {
      const text = extractUserText(payload);
      if (text === null) continue; // empty user turns (uncommon) — skip
      events.push({
        seq: seq++,
        ts,
        role: 'user',
        type: 'message',
        text,
        tool: null,
        stop_reason: null,
        tokens: null,
      });
    } else if (step.step_type === STEP_ASSISTANT_MSG) {
      const text = extractAssistantText(payload);
      // Include even if text is null — the turn happened
      events.push({
        seq: seq++,
        ts,
        role: 'assistant',
        type: 'message',
        text: text ?? null,
        tool: null,
        stop_reason: null,
        tokens: null,
      });
    } else if (STEP_TOOL_CALL.has(step.step_type)) {
      const tc = extractToolCall(payload);
      events.push({
        seq: seq++,
        ts,
        role: 'assistant',
        type: 'tool_call',
        text: null,
        tool: tc
          ? {
              name: tc.name,
              args_digest: digestArgs(tc.argsJson),
              duration_ms: null,
              is_error: false,
            }
          : { name: 'unknown', args_digest: null, duration_ms: null, is_error: false },
        stop_reason: null,
        tokens: null,
      });
    } else if (step.step_type === STEP_TITLE) {
      const title = extractTitleText(payload);
      if (title) {
        events.push({
          seq: seq++,
          ts,
          role: 'system',
          type: 'message',
          text: `[title] ${title}`,
          tool: null,
          stop_reason: null,
          tokens: null,
        });
      }
    } else if (step.step_type === STEP_SYSTEM) {
      const sysText = extractSystemText(payload);
      events.push({
        seq: seq++,
        ts,
        role: 'system',
        type: 'message',
        text: sysText ?? '[system event]',
        tool: null,
        stop_reason: null,
        tokens: null,
      });
    }
    // All other step types: skip (unknown — D1 follow-up)
  }

  db.close();

  const envelope: Envelope = {
    schema_version: '1.0',
    content_hash,
    session: {
      id: cascadeId,
      harness: 'antigravity',
      harness_version: null,
      model: model ?? null,
      provider: 'google',
      project_slug: projectSlug,
      cwd: cwd ?? null,
      started_at: startedAt,
      ended_at: endedAt,
      redaction: {
        scrubbed: false,
        rules_version: '',
        hits: 0,
      },
    },
    events,
  };

  // ── Apply redaction (§4 gate) ─────────────────────────────────────────────
  const scrubbed = scrubEnvelope(envelope);

  // ── Schema validation ─────────────────────────────────────────────────────
  const result = validateEnvelope(scrubbed);
  if (!result.valid) {
    const detail = result.errors.map((e) => `  ${e.instancePath}: ${e.message}`).join('\n');
    throw new Error(`[WS06] Envelope schema validation failed for ${absPath}:\n${detail}`);
  }

  // ── Persistence guard (§4 hard contract) ─────────────────────────────────
  assertPersistable(scrubbed);

  return scrubbed;
}

// ── Adapter export ────────────────────────────────────────────────────────────

export const antigravityAdapter: Adapter = {
  harness: 'antigravity',
  normalize,
};

export { FIDELITY };
