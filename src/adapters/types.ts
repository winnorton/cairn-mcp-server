/**
 * Canonical session envelope — WS 01 (HIVE_CONTEXT_SESSIONS).
 *
 * One document per session, shape frozen per §2.1 of SPEC_HIVE_CONTEXT_SESSIONS_00_PROGRAM.
 * Validated at runtime against schema/envelope.schema.json via validateEnvelope().
 */

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

export interface EnvelopeRedaction {
  /** MUST be true for a persisted envelope (§4 gate). */
  scrubbed: boolean;
  /** Version string from scrubber's RULES_VERSION constant. */
  rules_version: string;
  /** Number of secrets redacted from this session. */
  hits: number;
}

export interface EnvelopeSession {
  /** Session UUID (from harness or derived). */
  id: string;
  harness: 'claude-code' | 'pi' | 'antigravity';
  harness_version: string | null;
  model: string | null;
  provider: string | null;
  project_slug: string;
  cwd: string | null;
  started_at: string | null;
  ended_at: string | null;
  redaction: EnvelopeRedaction;
}

export interface EnvelopeTool {
  name: string;
  args_digest: string | null;
  duration_ms: number | null;
  is_error: boolean;
}

export interface EnvelopeTokens {
  in: number | null;
  out: number | null;
}

export interface EnvelopeEvent {
  /** Zero-based monotonically increasing sequence index. */
  seq: number;
  /** ISO-8601 timestamp from raw data, or null if absent. */
  ts: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  type: 'message' | 'tool_call' | 'tool_result' | 'error' | 'compaction' | 'model_change';
  /** Human-readable text payload (already redacted). */
  text: string | null;
  tool: EnvelopeTool | null;
  stop_reason: string | null;
  tokens: EnvelopeTokens | null;
}

// ---------------------------------------------------------------------------
// Root envelope
// ---------------------------------------------------------------------------

export interface Envelope {
  schema_version: '1.0';
  /** SHA-256 hex digest of the raw input file. Idempotence key. */
  content_hash: string;
  session: EnvelopeSession;
  events: EnvelopeEvent[];
}

// ---------------------------------------------------------------------------
// Adapter interface  (§2.5)
// ---------------------------------------------------------------------------

/**
 * A pure, deterministic, network-free adapter that normalizes a raw transcript
 * file into a canonical Envelope.
 *
 * Invariants:
 *  - Identical raw input → byte-identical envelope (no processing timestamps,
 *    no machine-specific paths, no random ordering inside).
 *  - Adapters MUST call scrubEnvelope() internally before returning. The
 *    returned envelope has `session.redaction.scrubbed = true` and satisfies
 *    assertPersistable(). Callers do NOT need to invoke the scrubber again.
 *  - The adapter itself does NOT write to disk.
 */
export interface Adapter {
  readonly harness: Envelope['session']['harness'];
  /**
   * Parse rawPath into a fully-scrubbed, schema-valid Envelope. The returned
   * envelope has `session.redaction.scrubbed = true` — scrubEnvelope() has
   * already been called internally. The envelope is ready for persistence
   * (assertPersistable() passes).
   */
  normalize(rawPath: string): Envelope;
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

/**
 * Named slots for the three harness adapters. Wave 1 fills these; Wave 0
 * registers placeholders so detect.ts and the build compile cleanly.
 *
 * Usage:
 *   import { adapterRegistry } from './types.js';
 *   const adapter = adapterRegistry['claude-code'];
 */
export const adapterRegistry: Record<Envelope['session']['harness'], Adapter | null> = {
  'claude-code': null, // filled by WS 04
  'pi': null,          // filled by WS 05
  'antigravity': null, // filled by WS 06
};

/**
 * Register an adapter. Called by each WS 04/05/06 module at startup.
 */
export function registerAdapter(adapter: Adapter): void {
  adapterRegistry[adapter.harness] = adapter;
}

/**
 * Look up an adapter for a given harness, throwing if not yet registered.
 */
export function getAdapter(harness: Envelope['session']['harness']): Adapter {
  const a = adapterRegistry[harness];
  if (!a) {
    throw new Error(
      `No adapter registered for harness "${harness}". ` +
        `Wave 1 workstreams (WS 04/05/06) must call registerAdapter() before use.`
    );
  }
  return a;
}
