/**
 * ingest_cli.mjs — DoD §4 test for cairn-ingest CLI
 *
 * Tests:
 *  1. gather (real) — discover 2 study_sessions files, persist them into a
 *     temp corpus, verify envelopes are schema-valid + redacted, dedup no-op.
 *  2. distill (mock LLM) — inject a canned Finding response via a local
 *     HTTP server; prove parse → validate → writeFindingsLedger → LEDGER.md.
 *  3. status — verify coverage output after gather + distill.
 *
 * Spark lane NOT required. Mock path is exercised (documented in report).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'dist', 'cli', 'ingest.js');
const CAIRN_SESSIONS = path.join(__dirname, '..', '..', 'cairn-sessions');
const STUDY_SESSIONS = path.join(__dirname, '..', '..', 'cairn', 'docs', 'study_sessions');
const CAIRN_SCHEMAS = path.join(__dirname, '..', '..', 'cairn-sessions', 'schema');

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
    errors.push(msg);
  }
}

// ---------------------------------------------------------------------------
// Setup: fresh temp corpus
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-test-cli-'));
console.log(`\nTemp corpus: ${tmpDir}`);
fs.mkdirSync(path.join(tmpDir, 'normalized'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'findings'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'schema'), { recursive: true });

// Copy schemas into temp corpus
for (const schemaFile of ['finding.schema.json', 'envelope.schema.json']) {
  const src = path.join(CAIRN_SCHEMAS, schemaFile);
  const dst = path.join(tmpDir, 'schema', schemaFile);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

function runCLI(args) {
  const result = spawnSync(
    process.execPath,
    [CLI, ...args],
    { encoding: 'utf-8', timeout: 60000 },
  );
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// Test 1: status on empty corpus
// ---------------------------------------------------------------------------
console.log('\n--- Test 1: status on empty corpus ---');
{
  const r = runCLI(['status', '--corpus', tmpDir]);
  assert(r.status === 0, 'status exits 0');
  let obj;
  try {
    obj = JSON.parse(r.stdout.trim());
  } catch {
    obj = null;
  }
  assert(obj !== null, 'status output is JSON');
  assert(obj?.envelopes?.total === 0, 'empty corpus has 0 envelopes');
}

// ---------------------------------------------------------------------------
// Test 2: gather — real study_sessions files
// ---------------------------------------------------------------------------
console.log('\n--- Test 2: gather (real study_sessions) ---');
{
  const gatherArgs = [
    'gather', '--corpus', tmpDir,
    '--roots', `claude-code=${STUDY_SESSIONS},pi=/nonexistent,antigravity=/nonexistent`,
  ];
  const r = runCLI(gatherArgs);
  if (r.stderr) process.stderr.write(r.stderr);

  let summary;
  try {
    summary = JSON.parse(r.stdout.trim());
  } catch {
    summary = null;
  }

  assert(r.status === 0, 'gather exits 0');
  assert(summary !== null, 'gather output is JSON');
  assert(summary?.discovered === 2, `discovered 2 study_sessions files (got ${summary?.discovered})`);
  assert(summary?.persisted === 2, `persisted 2 envelopes (got ${summary?.persisted})`);
  assert(summary?.skipped_dup === 0, 'no duplicates on first run');
  assert(summary?.errors === 0, 'no errors');
  assert(summary?.manifest_rows === 2, 'manifest has 2 rows');

  // Verify MANIFEST.md was created
  const manifestPath = path.join(tmpDir, 'MANIFEST.md');
  assert(fs.existsSync(manifestPath), 'MANIFEST.md exists');

  // Verify envelope files exist and are schema-valid + redacted
  const envelopeFiles = [];
  function findEnvelopes(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) findEnvelopes(full);
      else if (ent.name.endsWith('.envelope.json')) envelopeFiles.push(full);
    }
  }
  findEnvelopes(path.join(tmpDir, 'normalized'));

  assert(envelopeFiles.length === 2, `2 envelope files on disk (got ${envelopeFiles.length})`);

  for (const envFile of envelopeFiles) {
    const env = JSON.parse(fs.readFileSync(envFile, 'utf-8'));
    assert(env.schema_version === '1.0', `${path.basename(envFile)}: schema_version=1.0`);
    assert(env.session?.harness === 'claude-code', `${path.basename(envFile)}: harness=claude-code`);
    assert(env.session?.redaction?.scrubbed === true, `${path.basename(envFile)}: scrubbed=true`);
    assert(typeof env.content_hash === 'string', `${path.basename(envFile)}: has content_hash`);
  }

  // Test 2b: dedup — re-run should skip all 2 as duplicates
  console.log('\n--- Test 2b: gather dedup (re-run is a no-op) ---');
  const r2 = runCLI(gatherArgs);
  let s2;
  try { s2 = JSON.parse(r2.stdout.trim()); } catch { s2 = null; }
  assert(r2.status === 0, 'dedup gather exits 0');
  assert(s2?.persisted === 0, `dedup: persisted 0 (got ${s2?.persisted})`);
  assert(s2?.skipped_dup === 2, `dedup: skipped_dup=2 (got ${s2?.skipped_dup})`);
}

// ---------------------------------------------------------------------------
// Test 3: distill — mock LLM (direct module call, not subprocess)
// ---------------------------------------------------------------------------
// We test the distiller directly via module import rather than via a subprocess
// + mock HTTP server, because spawnSync blocks the event loop and prevents the
// mock server from handling requests. We monkey-patch global.fetch to inject
// a canned response instead.
console.log('\n--- Test 3: distill (mock LLM — direct module call with fetch mock) ---');

{
  // Pick the first envelope in the tmp corpus
  const envelopeFiles3 = [];
  function findEnv(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) findEnv(full);
      else if (ent.name.endsWith('.envelope.json')) envelopeFiles3.push(full);
    }
  }
  findEnv(path.join(tmpDir, 'normalized'));
  const firstEnvPath = envelopeFiles3[0];
  const firstEnv = JSON.parse(fs.readFileSync(firstEnvPath, 'utf-8'));
  const sessionId = firstEnv.session.id;

  // Canned valid Finding — matches finding.schema.json
  const cannedFinding = {
    session_id: sessionId,
    distilled_at: new Date().toISOString(),
    distiller: 'cairn-ingest@0.5.0',
    harness: firstEnv.session.harness,
    patterns: [
      { name: 'redundant-tool-calls', instance_count: 3, evidence: 'seq:10-45' },
      { name: 'unverified-completion-claims', instance_count: 1, evidence: 'seq:120' },
    ],
    candidates: {
      skills: ['session-distill'],
      laws: ['evidence-with-claim'],
      memory: ['verify_before_claiming_done'],
    },
    links: { note: null, commit: null },
  };

  // OpenAI-compatible response wrapper
  const mockResponse = {
    id: 'mock-id',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: JSON.stringify(cannedFinding) }, finish_reason: 'stop', index: 0 }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };

  // Inject a mock fetch that returns our canned response
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => ({
    ok: true,
    status: 200,
    json: async () => mockResponse,
    text: async () => JSON.stringify(mockResponse),
  });

  try {
    // Import the distiller module directly
    const { distillEnvelope } = await import('../dist/distill/llm.js');

    const result = await distillEnvelope(firstEnv, {
      corpusRoot: tmpDir,
      baseUrl: 'http://mock-llm/v1',
      apiKey: 'mock-key',
      model: 'mock-model',
      temperature: 0.2,
    });

    assert(result !== null, 'distillEnvelope returned a result');
    assert(typeof result.finding === 'object', 'result has finding');
    assert(result.finding.session_id === sessionId, `finding.session_id matches (got ${result.finding.session_id})`);
    assert(result.finding.harness === firstEnv.session.harness, `finding.harness matches`);
    assert(Array.isArray(result.finding.patterns), 'finding.patterns is array');
    assert(result.finding.patterns.length >= 1, `finding has >= 1 pattern`);
    assert(typeof result.finding.distilled_at === 'string', 'finding has distilled_at');
    assert(typeof result.finding.distiller === 'string', 'finding has distiller');
    assert(result.finding.distiller.startsWith('cairn-ingest@'), `distiller tag correct (got ${result.finding.distiller})`);
    assert(result.finding.links?.note === null, 'finding.links.note is null');
    assert(result.finding.links?.commit === null, 'finding.links.commit is null');
    assert(typeof result.findingsPath === 'string', 'result has findingsPath');
    assert(result.ledgerUpdated === true, 'ledgerUpdated=true');

    // Verify findings file was written to disk
    const findingsFile = path.join(tmpDir, 'findings', `${sessionId}.findings.json`);
    assert(fs.existsSync(findingsFile), 'findings JSON written to corpus');

    if (fs.existsSync(findingsFile)) {
      const written = JSON.parse(fs.readFileSync(findingsFile, 'utf-8'));
      const required = ['session_id', 'distilled_at', 'distiller', 'patterns', 'candidates', 'links'];
      for (const field of required) {
        assert(field in written, `written finding has required field: ${field}`);
      }
    }

    // Verify LEDGER.md was updated
    const ledgerPath = path.join(tmpDir, 'findings', 'LEDGER.md');
    assert(fs.existsSync(ledgerPath), 'LEDGER.md exists after distill');
    if (fs.existsSync(ledgerPath)) {
      const ledger = fs.readFileSync(ledgerPath, 'utf-8');
      assert(ledger.includes(sessionId.slice(0, 8)), 'LEDGER.md contains session_id prefix');
    }

    console.log(`  Distill path: MOCK (fetch intercepted in-process; Spark spark-448f:8001 NOT reachable)`);
  } catch (err) {
    assert(false, `distillEnvelope threw: ${err.message}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// Test 4: status after gather + distill
// ---------------------------------------------------------------------------
console.log('\n--- Test 4: status after gather + distill ---');
{
  const r = runCLI(['status', '--corpus', tmpDir]);
  let obj;
  try { obj = JSON.parse(r.stdout.trim()); } catch { obj = null; }
  assert(r.status === 0, 'status exits 0 after distill');
  assert(obj?.envelopes?.total === 2, `status shows 2 envelopes (got ${obj?.envelopes?.total})`);
  assert(obj?.envelopes?.distilled >= 1, `status shows >= 1 distilled (got ${obj?.envelopes?.distilled})`);
  assert(obj?.findings?.total >= 1, `status shows >= 1 finding (got ${obj?.findings?.total})`);
  assert(obj?.findings?.ledger_exists === true, 'ledger_exists=true in status');
}

// ---------------------------------------------------------------------------
// Cleanup + report
// ---------------------------------------------------------------------------
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.error('Failed assertions:');
  for (const e of errors) console.error(`  - ${e}`);
}
console.log(`Distill path exercised: MOCK (Spark spark-448f:8001 not reachable from this machine)`);
console.log(`================================================`);

if (failed > 0) process.exit(1);
