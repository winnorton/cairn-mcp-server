/**
 * Antigravity adapter smoke test — WS 06 (HIVE_CONTEXT_SESSIONS).
 *
 * Runs against a REAL Antigravity session DB at
 *   ~/.gemini/antigravity/conversations/01ccc93c-3fba-411d-87f5-2e780175398f.db
 * (the session from the spike: cwar-engine gamemode-coverage task, 2026-06-01).
 *
 * Usage (after npm run build or npx tsc):
 *   node test/adapter_antigravity.mjs
 *
 * Node 24 runs this with built-in SQLite (node:sqlite) — no extra deps needed.
 *
 * Prints:
 *   • Spike findings (on-disk format)
 *   • Event count and role breakdown
 *   • Fidelity level
 *   • Redaction hits
 *   • Schema-valid Y/N
 */

import { createRequire } from 'module';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Import compiled adapter ───────────────────────────────────────────────────
const { antigravityAdapter, FIDELITY } = await import('../dist/adapters/antigravity.js');

// ── AJV for independent schema validation ─────────────────────────────────────
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const ajv = new Ajv2020({ strict: false });
const schemaText = readFileSync(path.join(ROOT, 'schema/envelope.schema.json'), 'utf-8');
const schema = JSON.parse(schemaText);
const validate = ajv.compile(schema);

// ── Real session DB from spike ─────────────────────────────────────────────────
const SESSION_PATH =
  'C:\\Users\\winno\\.gemini\\antigravity\\conversations\\01ccc93c-3fba-411d-87f5-2e780175398f.db';

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  WS 06 Antigravity adapter smoke test                        ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log('Spike findings (on-disk format):');
console.log('  Location : ~/.gemini/antigravity/conversations/<uuid>.db');
console.log('  Format   : SQLite 3 (confirmed via magic bytes)');
console.log('  Tables   : trajectory_meta, steps, gen_metadata,');
console.log('             trajectory_metadata_blob, executor_metadata,');
console.log('             parent_references, battle_mode_infos');
console.log('  Payloads : steps.step_payload — binary protobuf (no .proto schema)');
console.log('  Timestamps: steps.metadata nested proto → field[1]={secs,nanos}');
console.log('  Model    : gen_metadata.data → field[19] = "gemini-3-flash-b"');
console.log('  CWD      : trajectory_metadata_blob.data → field[7] = file:// URL');
console.log('');
console.log(`Session DB : ${SESSION_PATH}`);
console.log('');

let envelope;
try {
  envelope = antigravityAdapter.normalize(SESSION_PATH);
} catch (err) {
  console.error('normalize() threw:', err);
  process.exit(1);
}

// ── Schema validation ─────────────────────────────────────────────────────────
const valid = validate(envelope);
const schemaErrors = valid ? [] : (validate.errors ?? []);

// ── Stats ─────────────────────────────────────────────────────────────────────
const roleCounts = { user: 0, assistant: 0, tool: 0, system: 0 };
const typeCounts = { message: 0, tool_call: 0, tool_result: 0, error: 0, compaction: 0, model_change: 0 };
for (const ev of envelope.events) {
  roleCounts[ev.role] = (roleCounts[ev.role] ?? 0) + 1;
  typeCounts[ev.type] = (typeCounts[ev.type] ?? 0) + 1;
}

console.log('── Envelope stats ────────────────────────────────────────────────');
console.log(`  schema_version : ${envelope.schema_version}`);
console.log(`  content_hash   : ${envelope.content_hash.slice(0, 16)}…`);
console.log(`  session.id     : ${envelope.session.id}`);
console.log(`  harness        : ${envelope.session.harness}`);
console.log(`  model          : ${envelope.session.model ?? '(null)'}`);
console.log(`  provider       : ${envelope.session.provider ?? '(null)'}`);
console.log(`  project_slug   : ${envelope.session.project_slug}`);
console.log(`  cwd            : ${envelope.session.cwd ?? '(null)'}`);
console.log(`  started_at     : ${envelope.session.started_at ?? '(null)'}`);
console.log(`  ended_at       : ${envelope.session.ended_at ?? '(null)'}`);
console.log('');
console.log(`  Total events   : ${envelope.events.length}`);
console.log('  Roles          :', JSON.stringify(roleCounts));
console.log('  Types          :', JSON.stringify(typeCounts));
console.log('');
console.log('── Security / redaction ─────────────────────────────────────────');
console.log(`  scrubbed       : ${envelope.session.redaction.scrubbed}`);
console.log(`  rules_version  : ${envelope.session.redaction.rules_version}`);
console.log(`  hits           : ${envelope.session.redaction.hits}`);
console.log('');
console.log('── Fidelity ─────────────────────────────────────────────────────');
console.log(`  Level          : ${FIDELITY}`);
console.log('  Note: Binary protobuf without .proto schema decoded via generic');
console.log('  wire-type walk. Tool results (step_type 9/5/7) are emitted as');
console.log('  tool_call events only; result blobs are skipped (D1 follow-up).');
console.log('');
console.log('── Schema validation ─────────────────────────────────────────────');
if (valid) {
  console.log('  ✓ SCHEMA VALID');
} else {
  console.log('  ✗ SCHEMA INVALID:');
  for (const e of schemaErrors) {
    console.log(`    ${e.instancePath}: ${e.message}`);
  }
}
console.log('');

// ── Sample events (first 3 user + first 2 assistant) ─────────────────────────
console.log('── Sample events ────────────────────────────────────────────────');
let userShown = 0, assistantShown = 0;
for (const ev of envelope.events) {
  if (ev.role === 'user' && userShown < 3) {
    console.log(`  [seq=${ev.seq} user] ${(ev.text ?? '').slice(0, 120)}`);
    userShown++;
  } else if (ev.role === 'assistant' && assistantShown < 2) {
    console.log(`  [seq=${ev.seq} assistant] ${(ev.text ?? '').slice(0, 120)}`);
    assistantShown++;
  }
  if (userShown >= 3 && assistantShown >= 2) break;
}

// ── Determinism check (run normalize twice, digests must match) ────────────
console.log('── Determinism ──────────────────────────────────────────────────');
const envelope2 = antigravityAdapter.normalize(SESSION_PATH);
const h1 = createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
const h2 = createHash('sha256').update(JSON.stringify(envelope2)).digest('hex');
console.log(`  Run 1 envelope digest: ${h1.slice(0, 16)}...`);
console.log(`  Run 2 envelope digest: ${h2.slice(0, 16)}...`);
const deterministic = h1 === h2;
console.log(`  Deterministic: ${deterministic ? 'YES' : 'NO — FAIL'}`);
console.log('');

if (valid && envelope.session.redaction.scrubbed && deterministic) {
  console.log('✓ PASS — schema valid, redacted, deterministic, ready for corpus persistence');
} else {
  console.log('✗ FAIL — see errors above');
  process.exit(1);
}
