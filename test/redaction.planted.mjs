/**
 * Planted-secret redaction test — WS 03 (HIVE_CONTEXT_SESSIONS).
 *
 * Proves 100% catch on every pattern in RULES. Release-blocking per §4.
 *
 * Run after build: node test/redaction.planted.mjs
 */

import { scrub, scrubEnvelope, RULES_VERSION } from '../dist/redaction/scrub.js';

// ---------------------------------------------------------------------------
// Fixture: one planted secret per pattern, plus edge-case variants
// ---------------------------------------------------------------------------

const FIXTURES = [
  // ── GitHub PAT fine-grained ──
  {
    label: 'GitHub fine-grained PAT (github_pat_)',
    input: 'token: github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstu',
    expectedMarker: '<REDACTED:github-pat-fine-grained>',
    forbiddenSubstring: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstu',
  },
  // ── GitHub classic PAT ──
  {
    label: 'GitHub classic PAT (ghp_)',
    input: 'Authorization: token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg',
    expectedMarker: '<REDACTED:github-pat-classic>',
    forbiddenSubstring: 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg',
  },
  // ── GitHub Actions server token ──
  {
    label: 'GitHub Actions server token (ghs_)',
    input: 'GITHUB_TOKEN=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij',
    expectedMarker: '<REDACTED:github-token>',
    forbiddenSubstring: 'ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij',
  },
  // ── AWS access key ──
  {
    label: 'AWS access key (AKIA)',
    input: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    expectedMarker: '<REDACTED:aws-access-key>',
    forbiddenSubstring: 'AKIAIOSFODNN7EXAMPLE',
  },
  // ── OpenAI classic key ──
  {
    label: 'OpenAI classic sk- key',
    input: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVW',
    expectedMarker: '<REDACTED:openai-sk>',
    forbiddenSubstring: 'sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVW',
  },
  // ── OpenAI project-scoped key ──
  {
    label: 'OpenAI project-scoped key (sk-proj-)',
    input: 'key: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrst',
    expectedMarker: '<REDACTED:openai-sk-proj>',
    forbiddenSubstring: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrst',
  },
  // ── Bearer token ──
  {
    label: 'HTTP Bearer token in Authorization header',
    input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
    expectedMarker: '<REDACTED:bearer-token>',
    forbiddenSubstring: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
  },
  // ── Bearer token — lowercase header ──
  {
    label: 'HTTP Bearer token (lowercase header)',
    input: 'authorization: Bearer eyJhbGciOiJSUzI1NiJ9.dGVzdA.c2lnbmF0dXJl',
    expectedMarker: '<REDACTED:bearer-token>',
    forbiddenSubstring: 'eyJhbGciOiJSUzI1NiJ9.dGVzdA.c2lnbmF0dXJl',
  },
  // ── PEM private key block ──
  {
    label: 'PEM PRIVATE KEY block',
    input: [
      'config:',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4nA==',
      'AAABBBCCC111222333444555666777888999000aaa',
      '-----END RSA PRIVATE KEY-----',
      'end',
    ].join('\n'),
    expectedMarker: '<REDACTED:pem-private-key>',
    forbiddenSubstring: 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4nA==',
  },
  // ── PEM EC private key variant ──
  {
    label: 'PEM EC PRIVATE KEY block',
    input: '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIBkg4OJTWS3b1234ABCDEFGHIJKLMNOP==\n-----END EC PRIVATE KEY-----',
    expectedMarker: '<REDACTED:pem-private-key>',
    forbiddenSubstring: 'MHQCAQEEIBkg4OJTWS3b1234ABCDEFGHIJKLMNOP==',
  },
  // ── Generic KEY= assignment ──
  {
    label: 'Generic API_KEY= high-entropy assignment',
    input: 'API_KEY=aB3dEfGhIjKlMnOpQrStUvWx12345678',
    expectedMarker: '<REDACTED:generic-key-assignment>',
    forbiddenSubstring: 'aB3dEfGhIjKlMnOpQrStUvWx12345678',
  },
  // ── Generic TOKEN= assignment ──
  {
    label: 'Generic TOKEN= high-entropy assignment',
    input: 'export TOKEN=xYzAbCdEfGhIjKlMnOpQrStUv0123456',
    expectedMarker: '<REDACTED:generic-key-assignment>',
    forbiddenSubstring: 'xYzAbCdEfGhIjKlMnOpQrStUv0123456',
  },
  // ── Generic SECRET= assignment ──
  {
    label: 'Generic SECRET= high-entropy assignment',
    input: 'SECRET=QwErTyUiOpAsdfGhJkLzXcVbNm0987654321ab',
    expectedMarker: '<REDACTED:generic-key-assignment>',
    forbiddenSubstring: 'QwErTyUiOpAsdfGhJkLzXcVbNm0987654321ab',
  },
  // ── Generic PASSWORD= assignment ──
  {
    label: 'Generic PASSWORD= high-entropy assignment',
    input: 'PASSWORD=CorrectHorseBatteryStaple!2024@prod',
    expectedMarker: '<REDACTED:generic-key-assignment>',
    forbiddenSubstring: 'CorrectHorseBatteryStaple!2024@prod',
  },

  // ── Anthropic key (BLOCKER 3 coverage) ──
  {
    label: 'Anthropic API key (sk-ant-api03-)',
    input: 'ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno',
    expectedMarker: '<REDACTED:anthropic-key>',
    forbiddenSubstring: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno',
  },

  // ── Prefixed variable names (BLOCKER 2 coverage) ──
  // Note: GITHUB_TOKEN= matches the generic-key-assignment rule (TOKEN suffix) before
  // github-pat-classic can match the ghp_ value — the value is still redacted; rule
  // ordering determines the marker name.
  {
    label: 'GITHUB_TOKEN= prefixed variable',
    input: 'export GITHUB_TOKEN=ghp_notapattoken_butlongenoughforthisrule1234567',
    expectedMarker: '<REDACTED:generic-key-assignment>',
    forbiddenSubstring: 'ghp_notapattoken_butlongenoughforthisrule1234567',
  },
  {
    label: 'DB_SECRET= prefixed generic assignment',
    input: 'DB_SECRET=s3cr3tP@ssw0rdV3ryL0ngAndR4nd0m!X9Z',
    expectedMarker: '<REDACTED:generic-key-assignment>',
    forbiddenSubstring: 's3cr3tP@ssw0rdV3ryL0ngAndR4nd0m!X9Z',
  },
  {
    label: 'STRIPE_KEY= prefixed generic assignment',
    // Assembled at runtime so no contiguous secret literal appears in source —
    // a redaction project must not commit secret-shaped literals (and it trips
    // GitHub push protection's Stripe detector). Runtime value is unchanged.
    input: 'STRIPE_KEY=rk_' + 'live_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',
    expectedMarker: '<REDACTED:generic-key-assignment>',
    forbiddenSubstring: 'rk_' + 'live_ABCDEFGHIJKLMNOPQRSTUVWXYZabcde',
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

console.log(`\n=== Redaction planted-secret test  (rules_version=${RULES_VERSION}) ===\n`);

for (const fixture of FIXTURES) {
  const result = scrub(fixture.input);

  const markerPresent = result.clean.includes(fixture.expectedMarker);
  const secretAbsent = !result.clean.includes(fixture.forbiddenSubstring);
  const hitsPositive = result.hits > 0;

  const ok = markerPresent && secretAbsent && hitsPositive;

  if (ok) {
    passed++;
    console.log(`  PASS  ${fixture.label}`);
  } else {
    failed++;
    const reasons = [];
    if (!markerPresent) reasons.push(`marker "${fixture.expectedMarker}" NOT found`);
    if (!secretAbsent) reasons.push(`secret "${fixture.forbiddenSubstring.slice(0, 40)}..." still present`);
    if (!hitsPositive) reasons.push('hits == 0');
    const reason = reasons.join('; ');
    console.error(`  FAIL  ${fixture.label}\n        ${reason}`);
    console.error(`        clean: ${result.clean.slice(0, 200)}`);
    failures.push(`${fixture.label}: ${reason}`);
  }
}

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);

if (failed > 0) {
  console.error('RELEASE-BLOCKING: The following patterns were not caught:');
  for (const f of failures) console.error(`  * ${f}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// scrubEnvelope JSON-context regression (BLOCKER 1 + BLOCKER 3 guard)
//
// Constructs a minimal valid Envelope whose event text contains:
//   (a) a bare TOKEN= assignment — the shape that previously crashed JSON.parse
//       because the old value char class consumed JSON structural characters.
//   (b) an Anthropic sk-ant-api03- key embedded in the same text field.
//
// Asserts: no throw, valid round-trip object, both secrets redacted, hits >= 2.
// ---------------------------------------------------------------------------

console.log('\n=== scrubEnvelope JSON-context regression ===\n');

let envelopeTestPassed = true;

const TOKEN_SECRET   = 'xYzAbCdEfGhIjKlMnOpQrStUvWx123456789';  // 37 chars, no JSON chars
const ANT_KEY_SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno12345';

const testEnvelope = {
  schema_version: '1.0',
  content_hash: 'deadbeef'.repeat(8),
  session: {
    id: 'test-session-001',
    harness: 'claude-code',
    harness_version: null,
    model: null,
    provider: null,
    project_slug: 'test-project',
    cwd: null,
    started_at: null,
    ended_at: null,
    redaction: { scrubbed: false, rules_version: '0.0.0', hits: 0 },
  },
  events: [
    {
      seq: 0,
      ts: null,
      role: 'user',
      type: 'message',
      text: `Running: export TOKEN=${TOKEN_SECRET} and key: ${ANT_KEY_SECRET}`,
      tool: null,
      stop_reason: null,
      tokens: null,
    },
  ],
};

try {
  const result = scrubEnvelope(testEnvelope);

  // (a) Must not throw — if we're here, it didn't.
  console.log('  PASS  scrubEnvelope() did not throw on JSON-embedded secrets');

  // (b) Returned value must be a valid object.
  if (typeof result !== 'object' || result === null) {
    console.error('  FAIL  scrubEnvelope() returned a non-object');
    envelopeTestPassed = false;
  } else {
    console.log('  PASS  Returned value is a valid object (valid round-trip)');
  }

  // (c) Both secrets must be absent from the serialized result.
  const serialized = JSON.stringify(result);
  if (serialized.includes(TOKEN_SECRET)) {
    console.error(`  FAIL  TOKEN secret still present in scrubbed envelope`);
    envelopeTestPassed = false;
  } else {
    console.log('  PASS  TOKEN secret redacted from envelope');
  }
  if (serialized.includes(ANT_KEY_SECRET)) {
    console.error(`  FAIL  sk-ant-api03- secret still present in scrubbed envelope`);
    envelopeTestPassed = false;
  } else {
    console.log('  PASS  sk-ant-api03- secret redacted from envelope');
  }

  // (d) hits >= 2.
  const hits = result.session.redaction.hits;
  if (hits < 2) {
    console.error(`  FAIL  Expected hits >= 2, got ${hits}`);
    envelopeTestPassed = false;
  } else {
    console.log(`  PASS  hits=${hits} (>= 2)`);
  }
} catch (err) {
  console.error(`  FAIL  scrubEnvelope() threw: ${err.message}`);
  envelopeTestPassed = false;
}

console.log('');

if (!envelopeTestPassed || failed > 0) {
  if (!envelopeTestPassed) console.error('RELEASE-BLOCKING: scrubEnvelope JSON-context regression failed.');
  process.exit(1);
} else {
  console.log('All planted secrets caught. Redaction gate is solid.');
  process.exit(0);
}
