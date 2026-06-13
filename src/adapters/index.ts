/**
 * Adapter barrel — HIVE_CONTEXT_SESSIONS (orchestrator-wired, Wave 1 integration).
 *
 * Importing this module once registers all three harness adapters into the
 * registry in types.ts, after which getAdapter()/adapterRegistry/normalizeAuto
 * work for every supported harness. WS 04/05/06 author the individual adapter
 * files but deliberately do NOT self-register (avoids parallel-fan-out conflict
 * on this shared file); registration is centralized here.
 */

import { registerAdapter, getAdapter, type Envelope } from './types.js';
import { detect, type DetectResult } from './detect.js';
import { claudeCodeAdapter } from './claude-code.js';
import { piAdapter } from './pi.js';
import { antigravityAdapter } from './antigravity.js';

// Register on import (side effect).
registerAdapter(claudeCodeAdapter);
registerAdapter(piAdapter);
registerAdapter(antigravityAdapter);

/**
 * Detect the harness of a raw transcript and normalize it to an Envelope in
 * one call. Throws if the format cannot be detected. The returned envelope's
 * redaction is the adapter's responsibility (adapters scrub before returning,
 * per §2.6 / §4).
 */
export function normalizeAuto(rawPath: string): Envelope {
  const harness: DetectResult = detect(rawPath);
  if (harness === 'unknown') {
    throw new Error(`normalizeAuto: cannot detect harness for "${rawPath}"`);
  }
  return getAdapter(harness).normalize(rawPath);
}

export { claudeCodeAdapter, piAdapter, antigravityAdapter };
export { detect } from './detect.js';
export { getAdapter, adapterRegistry, registerAdapter } from './types.js';
export type { Adapter, Envelope } from './types.js';
export type { HarnessName, DetectResult } from './detect.js';
