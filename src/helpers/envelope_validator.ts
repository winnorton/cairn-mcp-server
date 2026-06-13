/**
 * Envelope validation helper — WS 01 (HIVE_CONTEXT_SESSIONS).
 *
 * Validates an object against schema/envelope.schema.json using AJV (already
 * a transitive dependency via @modelcontextprotocol/sdk). Used by:
 *  - CI gate (WS 10)
 *  - Normalization before persistence
 *  - validate-envelope CLI helper
 */

import { createRequire } from 'module';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Envelope } from '../adapters/types.js';

// ── AJV setup ──
// AJV v8 ships as CommonJS; use createRequire for ESM compatibility.
// We need the 2020-12 build for our $schema declaration.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020 = require('ajv/dist/2020') as any;

// ── Schema path ──
// The schema lives at <repo-root>/schema/envelope.schema.json.
// Resolve relative to this file: src/helpers/ → ../../schema/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../../schema/envelope.schema.json');

// Lazy singleton: compiled validator (expensive to build, free to reuse)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _validate: any = null;

function getValidator(): ReturnType<InstanceType<typeof Ajv2020>['compile']> {
  if (_validate) return _validate;
  const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const schema = JSON.parse(schemaText);
  const ajv = new Ajv2020({ strict: false });
  _validate = ajv.compile(schema);
  return _validate!;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ instancePath: string; message: string }>;
}

/**
 * Validate an object against the canonical envelope schema.
 *
 * @param obj Any object (typically a parsed JSON blob).
 * @returns `{ valid, errors }` — errors is empty when valid.
 */
export function validateEnvelope(obj: unknown): ValidationResult {
  const validate = getValidator();
  const valid = validate(obj) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (validate.errors ?? []).map((e: { instancePath: string; message?: string }) => ({
    instancePath: e.instancePath ?? '',
    message: e.message ?? 'unknown error',
  }));
  return { valid: false, errors };
}

// ---------------------------------------------------------------------------
// content_hash helper
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of a raw file's bytes.
 * This is the idempotence key stored in `envelope.content_hash`.
 *
 * Determinism: reads raw bytes, no line-ending normalization.
 */
export function computeContentHash(rawFilePath: string): string {
  const bytes = fs.readFileSync(rawFilePath);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compute SHA-256 of an arbitrary Buffer or string.
 * Useful for in-memory content (e.g. after scrubbing).
 */
export function hashBytes(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Envelope persistence guard  (§4 HARD CONTRACT)
// ---------------------------------------------------------------------------

/**
 * Assert that an envelope is safe to persist:
 *  - `session.redaction.scrubbed` must be true.
 *  - The envelope must pass schema validation.
 *
 * Throws with a descriptive message if either condition fails.
 * Call this immediately before writing an envelope to disk.
 */
export function assertPersistable(envelope: Envelope): void {
  if (!envelope.session.redaction.scrubbed) {
    throw new Error(
      '[WS03 gate] Refusing to persist envelope: session.redaction.scrubbed is false. ' +
        'Run scrub() and set redaction fields before persisting.'
    );
  }
  const result = validateEnvelope(envelope);
  if (!result.valid) {
    const detail = result.errors.map((e) => `  ${e.instancePath}: ${e.message}`).join('\n');
    throw new Error(`[WS01 gate] Refusing to persist envelope: schema validation failed.\n${detail}`);
  }
}
