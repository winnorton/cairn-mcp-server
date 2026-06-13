/**
 * validate-corpus.mjs — WS 10 (HIVE_CONTEXT_SESSIONS)
 *
 * CI gate: validate every normalized/*.envelope.json in a cairn-sessions corpus against
 * schema/envelope.schema.json (AJV 2020-12), check MANIFEST row-count == envelope-count,
 * and verify id-uniqueness. Non-zero exit on any failure.
 *
 * Usage:
 *   node scripts/validate-corpus.mjs <corpus-root>
 *   # or via npm: CORPUS_ROOT=/path/to/cairn-sessions npm run validate-corpus
 *
 * If corpus-root is not provided, falls back to CORPUS_ROOT env var, then
 * ~/projects/cairn/cairn-sessions. If the corpus root does not exist, exits 0
 * with a warning (graceful skip for CI environments that don't have it checked out).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

// ---------------------------------------------------------------------------
// Args / corpus root resolution
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const corpusRoot = path.resolve(
  args[0] ||
  process.env.CORPUS_ROOT ||
  path.join(os.homedir(), 'projects', 'cairn', 'cairn-sessions')
);

if (!fs.existsSync(corpusRoot)) {
  console.warn(`[validate-corpus] WARN: corpus root not found — skipping: ${corpusRoot}`);
  process.exit(0);
}

console.log(`[validate-corpus] Corpus root: ${corpusRoot}`);

// ---------------------------------------------------------------------------
// Load AJV (requires AJV 8 with 2020-12 support)
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
let Ajv;
try {
  ({ default: Ajv } = await import('ajv/dist/2020.js'));
} catch {
  try {
    Ajv = require('ajv/dist/2020');
    if (Ajv.default) Ajv = Ajv.default;
  } catch (err) {
    console.error('[validate-corpus] ERROR: cannot load AJV. Run: npm install');
    console.error(err);
    process.exit(1);
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });

// ---------------------------------------------------------------------------
// Load envelope schema
// ---------------------------------------------------------------------------

const schemaPath = path.join(corpusRoot, 'schema', 'envelope.schema.json');
if (!fs.existsSync(schemaPath)) {
  // Fall back to the schema shipped alongside this script (in cairn-mcp-server/schema/)
  const localSchemaPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'schema', 'envelope.schema.json');
  if (!fs.existsSync(localSchemaPath)) {
    console.error(`[validate-corpus] ERROR: envelope schema not found at:\n  ${schemaPath}\n  ${localSchemaPath}`);
    process.exit(1);
  }
  console.log(`[validate-corpus] Using local schema: ${localSchemaPath}`);
  const schema = JSON.parse(fs.readFileSync(localSchemaPath, 'utf-8'));
  ajv.addSchema(schema, 'envelope');
} else {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  ajv.addSchema(schema, 'envelope');
}

const validateEnvelope = ajv.getSchema('envelope');

// ---------------------------------------------------------------------------
// Walk normalized/**/*.envelope.json
// ---------------------------------------------------------------------------

function walkEnvelopes(normalizedRoot) {
  const results = [];
  if (!fs.existsSync(normalizedRoot)) return results;

  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.envelope.json')) {
        results.push(full);
      }
    }
  }

  walk(normalizedRoot, 0);
  return results;
}

const normalizedRoot = path.join(corpusRoot, 'normalized');
const envelopePaths = walkEnvelopes(normalizedRoot);

console.log(`[validate-corpus] Found ${envelopePaths.length} envelope(s) under normalized/`);

// ---------------------------------------------------------------------------
// Validate each envelope
// ---------------------------------------------------------------------------

let validationErrors = 0;
const ids = new Map(); // id -> [paths]

for (const ep of envelopePaths) {
  const rel = path.relative(corpusRoot, ep);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(ep, 'utf-8'));
  } catch (err) {
    console.error(`[validate-corpus] FAIL (parse): ${rel}\n  ${err.message}`);
    validationErrors++;
    continue;
  }

  const valid = validateEnvelope(parsed);
  if (!valid) {
    console.error(`[validate-corpus] FAIL (schema): ${rel}`);
    for (const e of validateEnvelope.errors ?? []) {
      console.error(`  ${e.instancePath || '/'} ${e.message}`);
    }
    validationErrors++;
  } else {
    console.log(`[validate-corpus] OK: ${rel}`);
  }

  // Track id for uniqueness check
  const id = parsed?.session?.id;
  if (id) {
    const existing = ids.get(id) ?? [];
    existing.push(rel);
    ids.set(id, existing);
  }
}

// ---------------------------------------------------------------------------
// Id-uniqueness check
// ---------------------------------------------------------------------------

let uniquenessErrors = 0;
for (const [id, paths] of ids.entries()) {
  if (paths.length > 1) {
    console.error(`[validate-corpus] FAIL (duplicate id): ${id}`);
    for (const p of paths) console.error(`  ${p}`);
    uniquenessErrors++;
  }
}
if (uniquenessErrors === 0) {
  console.log(`[validate-corpus] id-uniqueness: OK (${ids.size} unique id(s))`);
}

// ---------------------------------------------------------------------------
// MANIFEST row-count check
// ---------------------------------------------------------------------------

let manifestErrors = 0;
const manifestPath = path.join(corpusRoot, 'MANIFEST.md');
if (fs.existsSync(manifestPath)) {
  const manifestText = fs.readFileSync(manifestPath, 'utf-8');
  // Count data rows in the manifest table (pipe-start, not header, not separator)
  const dataRows = manifestText
    .split(/\r?\n/)
    .filter(
      (l) =>
        l.startsWith('| ') &&
        !l.startsWith('| id ') &&
        !l.startsWith('|---|')
    );
  const manifestRowCount = dataRows.length;
  const envelopeCount = envelopePaths.length;

  if (manifestRowCount !== envelopeCount) {
    console.error(
      `[validate-corpus] FAIL (manifest mismatch): MANIFEST.md has ${manifestRowCount} row(s) but found ${envelopeCount} envelope(s)`
    );
    manifestErrors++;
  } else {
    console.log(`[validate-corpus] manifest row-count: OK (${manifestRowCount} == ${envelopeCount})`);
  }
} else {
  console.warn(`[validate-corpus] WARN: MANIFEST.md not found — skipping row-count check`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const totalErrors = validationErrors + uniquenessErrors + manifestErrors;
if (totalErrors > 0) {
  console.error(
    `\n[validate-corpus] FAILED: ${validationErrors} schema error(s), ${uniquenessErrors} duplicate id(s), ${manifestErrors} manifest mismatch(es)`
  );
  process.exit(1);
} else {
  console.log(
    `\n[validate-corpus] PASSED: ${envelopePaths.length} envelope(s) valid, ids unique, manifest row-count matches.`
  );
  process.exit(0);
}
