/**
 * Secret-scrubber — WS 03 (HIVE_CONTEXT_SESSIONS).
 *
 * Operationalizes [LAW credentials-never-in-transcript] as a gate:
 * normalization MUST NOT persist an envelope unless redaction.scrubbed == true.
 *
 * Pattern table covers:
 *  - GitHub PAT  : github_pat_... / ghp_...
 *  - AWS key     : AKIA...
 *  - Anthropic key: sk-ant-api03-...
 *  - OpenAI key  : sk-...  (classic and project-scoped sk-proj-...)
 *  - Bearer tokens: Authorization: Bearer <token>
 *  - PEM private-key blocks: -----BEGIN ... PRIVATE KEY-----
 *  - Generic high-entropy assignments: KEY=, TOKEN=, SECRET=, PASSWORD=, PASSWD=
 *    (any prefix, e.g. GITHUB_TOKEN=, DB_SECRET=, STRIPE_KEY=)
 *
 * Each hit is replaced with `<REDACTED:pattern-name>`.
 *
 * Determinism: scrub() is a pure function of its input — no timestamps, no
 * machine state, no randomness in the output.
 */

// ---------------------------------------------------------------------------
// Rules version
// ---------------------------------------------------------------------------

/**
 * Increment this string whenever any pattern is added, changed, or removed.
 * Stamped into every envelope's `session.redaction.rules_version`.
 */
export const RULES_VERSION = '1.1.0';

// ---------------------------------------------------------------------------
// Pattern table
// ---------------------------------------------------------------------------

export interface RedactionRule {
  /** Short name used in the <REDACTED:name> marker and in test output. */
  name: string;
  /** Regex applied against the input string. Must have `g` flag. */
  pattern: RegExp;
}

/**
 * Ordered list of redaction rules. Earlier rules win when patterns overlap.
 * All regexes must have the `g` (global) flag.
 */
export const RULES: ReadonlyArray<RedactionRule> = [
  // 1. PEM private-key blocks (multi-line; replace the whole block)
  {
    name: 'pem-private-key',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },

  // 2. GitHub fine-grained PAT  (github_pat_ + 36+ base62 chars)
  {
    name: 'github-pat-fine-grained',
    pattern: /github_pat_[A-Za-z0-9_]{36,}/g,
  },

  // 3. GitHub classic PAT / OAuth token  (ghp_ + 36+ base62 chars)
  {
    name: 'github-pat-classic',
    pattern: /ghp_[A-Za-z0-9]{36,}/g,
  },

  // 4. GitHub Actions tokens (ghs_, ghr_, gho_)
  {
    name: 'github-token',
    pattern: /gh[sro]_[A-Za-z0-9]{36,}/g,
  },

  // 5. AWS access key  (AKIA + 16 uppercase alphanumeric)
  {
    name: 'aws-access-key',
    pattern: /AKIA[0-9A-Z]{16}/g,
  },

  // 6. Anthropic secret key (sk-ant-api03- prefix + 20+ base62/hyphen/underscore chars)
  //    Must appear BEFORE openai-sk so it wins over the generic sk- rule.
  {
    name: 'anthropic-key',
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
  },

  // 7. OpenAI secret key — classic (sk- + 48+ chars)
  {
    name: 'openai-sk',
    pattern: /sk-[A-Za-z0-9]{48,}/g,
  },

  // 8. OpenAI project-scoped key (sk-proj- prefix)
  {
    name: 'openai-sk-proj',
    pattern: /sk-proj-[A-Za-z0-9_-]{40,}/g,
  },

  // 9. Bearer tokens in HTTP headers (case-insensitive header name)
  {
    name: 'bearer-token',
    pattern: /(?:Authorization|authorization)\s*:\s*Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  },

  // 10. Generic high-entropy KEY= assignments (case-insensitive)
  //     Matches any prefix: GITHUB_TOKEN=, DB_SECRET=, STRIPE_KEY=, API_KEY=, TOKEN=, etc.
  //     Value char class deliberately excludes JSON structural chars (", }, ], {, :, ;, \, ,)
  //     so scrubEnvelope() (which JSON.stringify→scrub→JSON.parse) cannot consume JSON
  //     delimiters and produce invalid JSON.
  {
    name: 'generic-key-assignment',
    pattern: /(?:^|[\s,;"'])((?:\w+_)?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)s?\s*=\s*)([A-Za-z0-9!@#$%^&*()_+\-=./<>?~]{16,})/gim,
  },
];

// ---------------------------------------------------------------------------
// Hit record
// ---------------------------------------------------------------------------

export interface RedactionHit {
  /** Rule name that matched. */
  rule: string;
  /** Character offset in the original string where the match started. */
  offset: number;
  /** Length of the matched text in the original string. */
  length: number;
  /** Replacement marker written into the clean output. */
  marker: string;
}

// ---------------------------------------------------------------------------
// Result shape  (§2.6)
// ---------------------------------------------------------------------------

export interface ScrubResult {
  /** The input with all secrets replaced by <REDACTED:pattern-name> markers. */
  clean: string;
  /** Number of replacements made (sum across all patterns). */
  hits: number;
  /** Rules version used. */
  rules_version: string;
  /** Detailed hit records (useful for diagnostics / --explain mode). */
  hit_records: RedactionHit[];
}

// ---------------------------------------------------------------------------
// Core scrub function
// ---------------------------------------------------------------------------

/**
 * Scrub secrets from `input`.
 *
 * Accepts:
 *  - string: scrub directly.
 *  - object: JSON.stringify → scrub → return both `clean` (re-parsed if valid)
 *    and the stringified form. The `clean` field in the result is always a
 *    string; callers that pass an object can re-parse if needed.
 *
 * Pure function: identical input → identical output.
 */
export function scrub(input: string | object): ScrubResult {
  const inputStr: string = typeof input === 'string' ? input : JSON.stringify(input);

  let working = inputStr;
  const hitRecords: RedactionHit[] = [];
  let totalHits = 0;

  for (const rule of RULES) {
    // Reset lastIndex before each application (required for global regexes
    // when called multiple times on the same pattern object).
    rule.pattern.lastIndex = 0;

    const marker = `<REDACTED:${rule.name}>`;
    let newStr = '';
    let lastEnd = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.pattern.exec(working)) !== null) {
      const matchStart = match.index;

      // For the generic-key-assignment rule, only the value part (group 2) is
      // redacted, not the key name. If group 2 is captured, replace only that.
      let replaceStart = matchStart;
      let replaceEnd = matchStart + match[0].length;
      let replaceWith = marker;

      if (rule.name === 'generic-key-assignment' && match[2] !== undefined) {
        // Find where the value (group 2) starts within the full match.
        const valueOffset = match[0].indexOf(match[2]);
        replaceStart = matchStart + valueOffset;
        replaceEnd = replaceStart + match[2].length;
        replaceWith = marker;
      }

      hitRecords.push({
        rule: rule.name,
        offset: replaceStart,
        length: replaceEnd - replaceStart,
        marker,
      });
      totalHits++;

      newStr += working.slice(lastEnd, replaceStart) + replaceWith;
      lastEnd = replaceEnd;

      // Move lastIndex past the replacement to avoid overlapping matches.
      rule.pattern.lastIndex = replaceEnd;
    }

    newStr += working.slice(lastEnd);
    working = newStr;

    // Reset for next iteration (safety).
    rule.pattern.lastIndex = 0;
  }

  return {
    clean: working,
    hits: totalHits,
    rules_version: RULES_VERSION,
    hit_records: hitRecords,
  };
}

// ---------------------------------------------------------------------------
// Envelope-aware scrub  (convenience wrapper)
// ---------------------------------------------------------------------------

import type { Envelope } from '../adapters/types.js';

/**
 * Scrub an Envelope object in-place (stringifies events/session, scrubs, then
 * re-integrates). Returns the scrubbed Envelope with `redaction` fields filled.
 *
 * This is the Layer-1 call inside normalization: called before persistence.
 * Layer-2 is the corpus pre-commit hook (WS 02).
 */
export function scrubEnvelope(envelope: Envelope): Envelope {
  // Scrub the full serialized envelope to catch any secret that leaked into
  // event text, tool args, or session metadata.
  const result = scrub(JSON.stringify(envelope));

  // Re-parse the scrubbed JSON back into an envelope-shaped object.
  const scrubbed = JSON.parse(result.clean) as Envelope;

  // Stamp redaction metadata.
  scrubbed.session.redaction = {
    scrubbed: true,
    rules_version: result.rules_version,
    hits: result.hits,
  };

  return scrubbed;
}
