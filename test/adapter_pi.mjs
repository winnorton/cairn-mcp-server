/**
 * Pi adapter verification test — WS 05 (HIVE_CONTEXT_SESSIONS).
 *
 * Runs normalize() on a real Pi session, validates against envelope.schema.json,
 * and prints a diagnostic summary: event count, role distribution, top tools,
 * redaction hits, schema-valid Y/N.
 *
 * Run:  node --experimental-strip-types test/adapter_pi.mjs
 *    or node test/adapter_pi.mjs   (Node 24 — .mjs files import .ts via the
 *                                   --experimental-strip-types flag)
 *
 * NOTE: This test imports src/adapters/pi.ts directly (Node 24 native TS strip).
 *       It does NOT require a prior `npm run build`.
 */

// Import from compiled dist/ (same pattern as the existing redaction.planted.mjs test).
// If you are developing without a build, run `npm run build` first, or use the
// --experimental-strip-types flag plus a .js→.ts resolver hook.
import { createHash } from 'crypto';
import { piAdapter } from '../dist/adapters/pi.js';
import { validateEnvelope } from '../dist/helpers/envelope_validator.js';

// ---------------------------------------------------------------------------
// Config — real Pi session captured 2026-06-13
// ---------------------------------------------------------------------------

// Large cwar-engine session: 436 lines, ~1 MB — substantial, multi-tool
const PI_SESSION_PATH =
  'C:/Users/winno/.pi/agent/sessions/' +
  '--C--Users-winno-projects-cwar-cwar-engine--/' +
  '2026-06-08T16-35-50-273Z_019ea817-2781-74b8-967f-211d4e8cb5ca.jsonl';

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('=== Pi Adapter Verification ===');
console.log('File:', PI_SESSION_PATH);
console.log();

let envelope;
try {
  // normalize() already calls scrubEnvelope() internally per WS 05 implementation
  envelope = piAdapter.normalize(PI_SESSION_PATH);
} catch (err) {
  console.error('FAIL: normalize() threw:', err);
  process.exit(1);
}

// ── Schema validation ──
const result = validateEnvelope(envelope);
const schemaValid = result.valid;
if (!schemaValid) {
  console.error('FAIL: schema validation errors:');
  for (const e of result.errors) {
    console.error(' ', e.instancePath, ':', e.message);
  }
} else {
  console.log('Schema valid: YES');
}

// ── Session metadata ──
const s = envelope.session;
console.log();
console.log('Session metadata:');
console.log('  id          :', s.id);
console.log('  harness     :', s.harness);
console.log('  harness_ver :', s.harness_version);
console.log('  model       :', s.model);
console.log('  provider    :', s.provider);
console.log('  project_slug:', s.project_slug);
console.log('  cwd         :', s.cwd);
console.log('  started_at  :', s.started_at);
console.log('  ended_at    :', s.ended_at);

// ── Redaction ──
console.log();
console.log('Redaction:');
console.log('  scrubbed     :', s.redaction.scrubbed);
console.log('  rules_version:', s.redaction.rules_version);
console.log('  hits         :', s.redaction.hits);

// ── Event stats ──
const events = envelope.events;
console.log();
console.log('Event count:', events.length);

// Role distribution
const roleCounts = {};
for (const e of events) {
  roleCounts[e.role] = (roleCounts[e.role] ?? 0) + 1;
}
console.log('Role distribution:', roleCounts);

// Type distribution
const typeCounts = {};
for (const e of events) {
  typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
}
console.log('Type distribution:', typeCounts);

// Top tools by name
const toolCounts = {};
for (const e of events) {
  if (e.tool?.name) {
    toolCounts[e.tool.name] = (toolCounts[e.tool.name] ?? 0) + 1;
  }
}
const topTools = Object.entries(toolCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
console.log();
console.log('Top tools:', topTools.map(([n, c]) => `${n}(${c})`).join(', '));

// Token coverage (how many assistant events have tokens)
const assistantEvents = events.filter((e) => e.role === 'assistant');
const withTokens = assistantEvents.filter((e) => e.tokens?.in != null || e.tokens?.out != null);
console.log();
console.log(
  `Token coverage: ${withTokens.length}/${assistantEvents.length} assistant events have tokens`
);

// content_hash
console.log();
console.log('content_hash:', envelope.content_hash);

// ── Determinism check (run normalize twice, digests must match) ────────────
console.log();
console.log('Determinism check (running normalize twice)...');
const envelope2 = piAdapter.normalize(PI_SESSION_PATH);
const h1 = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
const h2 = createHash('sha256').update(JSON.stringify(envelope2)).digest('hex');
console.log(`  Run 1 envelope digest: ${h1.slice(0, 16)}...`);
console.log(`  Run 2 envelope digest: ${h2.slice(0, 16)}...`);
const deterministic = h1 === h2;
console.log(`  Deterministic: ${deterministic ? 'YES' : 'NO — FAIL'}`);

// ── Summary ──
console.log();
if (schemaValid && s.redaction.scrubbed && deterministic) {
  console.log('PASS: envelope is schema-valid, redacted, and deterministic.');
  process.exit(0);
} else {
  console.log('FAIL: see errors above.');
  process.exit(1);
}
