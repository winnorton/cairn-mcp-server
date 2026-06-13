/**
 * Adapter smoke-test — WS 04 (HIVE_CONTEXT_SESSIONS).
 *
 * Imports the Claude Code adapter (via compiled dist/), runs normalize() on the
 * real fable_first session, validates against envelope.schema.json, and prints
 * event stats + redaction hits.
 *
 * Prerequisite: compile the adapter first:
 *   npx tsc --noEmit false --outDir dist --rootDir src src/adapters/claude-code.ts \
 *            src/adapters/types.ts src/redaction/scrub.ts \
 *            src/helpers/envelope_validator.ts
 *
 * Or just: npx tsc
 *
 * Then: node test/adapter_cc.mjs
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Import compiled adapter ───────────────────────────────────────────────
const { claudeCodeAdapter } = await import('../dist/adapters/claude-code.js');

// ── AJV for independent schema validation ─────────────────────────────────
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const ajv = new Ajv2020({ strict: false });
const schemaText = readFileSync(path.join(ROOT, 'schema/envelope.schema.json'), 'utf-8');
const schema = JSON.parse(schemaText);
const validate = ajv.compile(schema);

// ── Run normalize on the real fable_first session ─────────────────────────
const SESSION_PATH =
  'C:\\Users\\winno\\projects\\cairn\\cairn\\docs\\study_sessions\\fable_first_817c311b-ce8b-460d-9f0d-eafbbe18ad02.jsonl';

console.log('=== WS 04 Claude Code adapter smoke test ===');
console.log(`Session: ${SESSION_PATH}`);
console.log('');

let envelope;
try {
  envelope = claudeCodeAdapter.normalize(SESSION_PATH);
} catch (err) {
  console.error('normalize() threw:', err);
  process.exit(1);
}

// ── Schema validation (independent of what the adapter asserts internally) ─
const valid = validate(envelope);
const schemaErrors = validate.errors ?? [];

console.log(`Schema valid: ${valid ? 'YES' : 'NO'}`);
if (!valid) {
  console.error('Schema errors:');
  for (const e of schemaErrors) {
    console.error(`  ${e.instancePath}: ${e.message}`);
  }
}
console.log('');

// ── Event statistics ───────────────────────────────────────────────────────
const events = envelope.events;
console.log(`Total events: ${events.length}`);
console.log('');

// Role distribution
const roleCounts = {};
for (const ev of events) {
  roleCounts[ev.role] = (roleCounts[ev.role] ?? 0) + 1;
}
console.log('Role distribution:');
for (const [role, count] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${role}: ${count}`);
}
console.log('');

// Type distribution
const typeCounts = {};
for (const ev of events) {
  typeCounts[ev.type] = (typeCounts[ev.type] ?? 0) + 1;
}
console.log('Event type distribution:');
for (const [t, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${count}`);
}
console.log('');

// Top tool calls
const toolCounts = {};
for (const ev of events) {
  if (ev.type === 'tool_call' && ev.tool?.name) {
    toolCounts[ev.tool.name] = (toolCounts[ev.tool.name] ?? 0) + 1;
  }
}
const topTools = Object.entries(toolCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15);
console.log('Top tool calls:');
for (const [name, count] of topTools) {
  console.log(`  ${name}: ${count}`);
}
console.log('');

// ── Session metadata ───────────────────────────────────────────────────────
console.log('Session metadata:');
console.log(`  id:            ${envelope.session.id}`);
console.log(`  harness:       ${envelope.session.harness}`);
console.log(`  harness_ver:   ${envelope.session.harness_version}`);
console.log(`  model:         ${envelope.session.model}`);
console.log(`  provider:      ${envelope.session.provider}`);
console.log(`  project_slug:  ${envelope.session.project_slug}`);
console.log(`  cwd:           ${envelope.session.cwd}`);
console.log(`  started_at:    ${envelope.session.started_at}`);
console.log(`  ended_at:      ${envelope.session.ended_at}`);
console.log('');

// ── Redaction ──────────────────────────────────────────────────────────────
console.log('Redaction:');
console.log(`  scrubbed:      ${envelope.session.redaction.scrubbed}`);
console.log(`  rules_version: ${envelope.session.redaction.rules_version}`);
console.log(`  hits:          ${envelope.session.redaction.hits}`);
console.log('');

// ── Content hash ──────────────────────────────────────────────────────────
console.log(`Content hash: ${envelope.content_hash}`);
console.log('');

// ── Determinism check (run normalize twice, hashes must match) ────────────
console.log('Determinism check (running normalize twice)...');
const envelope2 = claudeCodeAdapter.normalize(SESSION_PATH);
const h1 = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
const h2 = createHash('sha256').update(JSON.stringify(envelope2)).digest('hex');
console.log(`  Run 1 envelope digest: ${h1.slice(0, 16)}...`);
console.log(`  Run 2 envelope digest: ${h2.slice(0, 16)}...`);
console.log(`  Deterministic: ${h1 === h2 ? 'YES' : 'NO — FAIL'}`);
console.log('');

// ── Summary ───────────────────────────────────────────────────────────────
const pass = valid && envelope.session.redaction.scrubbed && h1 === h2;
console.log(`=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
if (!pass) process.exit(1);
