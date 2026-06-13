/**
 * llm.ts — LLM distiller for cairn-ingest (§2 of SPEC_HIVE_CONTEXT_SESSIONS_11_INGEST_CLI).
 *
 * distillEnvelope(envelope, opts): Promise<Finding>
 *
 * Sends a compressed pre-digest + sampled events to an OpenAI-compatible endpoint
 * (the Spark coding lane) and writes back a schema-validated Finding.
 * Uses global fetch (Node 24). No SDK dependency.
 *
 * Prompt mirrors the /session-distill skill methodology — patterns recognized vs the
 * seeded catalog; skill/law/memory candidates with 3-instance gate; report-only stance.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// AJV: use the draft-2020-12 entry point since finding.schema.json uses that dialect.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import Ajv2020Module from 'ajv/dist/2020.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv = (Ajv2020Module as any).default ?? Ajv2020Module;
import type { Envelope, EnvelopeEvent } from '../adapters/types.js';
import { loadPriorPatternNames, writeFindingsLedger, type Finding } from '../tools/findings_ledger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DistillOptions {
  corpusRoot: string;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** Timeout in ms (default 120000) */
  timeout?: number;
}

export interface DistillResult {
  finding: Finding;
  findingsPath: string;
  ledgerUpdated: boolean;
}

// ---------------------------------------------------------------------------
// Schema loading + validation (AJV)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundled fallback schema path (copied into cairn-mcp-server/schema/ at build)
const BUNDLED_SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema', 'finding.schema.json');

function loadFindingSchema(corpusRoot: string): Record<string, unknown> {
  // Prefer the corpus copy (authoritative); fall back to the bundled copy
  const corpusSchemaPath = path.join(corpusRoot, 'schema', 'finding.schema.json');
  for (const schemaPath of [corpusSchemaPath, BUNDLED_SCHEMA_PATH]) {
    if (fs.existsSync(schemaPath)) {
      try {
        return JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        // corrupt — try next
      }
    }
  }
  throw new Error('finding.schema.json not found in corpus or bundled schema directory');
}

function makeValidator(schema: Record<string, unknown>): (data: unknown) => string[] {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return (data: unknown): string[] => {
    const valid = validate(data);
    if (valid) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (validate.errors ?? []).map((e: any) => `${e.instancePath ?? ''} ${e.message ?? ''}`);
  };
}

// ---------------------------------------------------------------------------
// Pre-digest builder
// ---------------------------------------------------------------------------

interface PreDigest {
  session_id: string;
  harness: string;
  model: string | null;
  project_slug: string;
  duration_minutes: number | null;
  total_events: number;
  role_counts: Record<string, number>;
  type_counts: Record<string, number>;
  redaction_hits: number;
  top_tools: Array<{ name: string; count: number }>;
  inflection_points: Array<{ seq: number; type: string; reason?: string }>;
  user_arc: string[];
}

function buildPreDigest(envelope: Envelope): PreDigest {
  const events = envelope.events ?? [];

  // Role and type counts
  const roleCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const ev of events) {
    roleCounts[ev.role] = (roleCounts[ev.role] ?? 0) + 1;
    typeCounts[ev.type] = (typeCounts[ev.type] ?? 0) + 1;
  }

  // Tool distribution
  const toolCounts: Record<string, number> = {};
  for (const ev of events) {
    if (ev.type === 'tool_call' && ev.tool?.name) {
      toolCounts[ev.tool.name] = (toolCounts[ev.tool.name] ?? 0) + 1;
    }
  }
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // Inflection points: error events, compaction events, same-tool runs >= 4
  const inflectionPoints: Array<{ seq: number; type: string; reason?: string }> = [];

  // Error + compaction events
  for (const ev of events) {
    if (ev.type === 'error' || ev.type === 'compaction') {
      inflectionPoints.push({ seq: ev.seq, type: ev.type, reason: ev.text?.slice(0, 200) ?? undefined });
    }
  }

  // Same-tool runs >= 4 (detect streaks)
  let lastTool: string | null = null;
  let streakStart = 0;
  let streakLen = 0;
  for (const ev of events) {
    if (ev.type === 'tool_call' && ev.tool?.name) {
      if (ev.tool.name === lastTool) {
        streakLen++;
        if (streakLen === 4) {
          inflectionPoints.push({ seq: streakStart, type: 'same-tool-run', reason: `${ev.tool.name} x${streakLen}+` });
        }
      } else {
        lastTool = ev.tool.name;
        streakStart = ev.seq;
        streakLen = 1;
      }
    }
  }

  // User message arc — capped at first 50 user messages to bound prompt size
  const userArcRaw: string[] = [];
  for (const ev of events) {
    if (ev.role === 'user' && ev.type === 'message' && ev.text) {
      const snippet = ev.text.slice(0, 300).replace(/\s+/g, ' ').trim();
      if (snippet) userArcRaw.push(`[seq:${ev.seq}] ${snippet}`);
    }
  }
  const userArc = userArcRaw.slice(0, 50);

  // Duration
  let durationMinutes: number | null = null;
  const timestamps = events
    .map((e) => e.ts)
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t))
    .filter((ms) => Number.isFinite(ms));
  if (timestamps.length >= 2) {
    const minMs = Math.min(...timestamps);
    const maxMs = Math.max(...timestamps);
    durationMinutes = Math.round((maxMs - minMs) / 60000);
  }

  const preDigest = {
    session_id: envelope.session.id,
    harness: envelope.session.harness,
    model: envelope.session.model,
    project_slug: envelope.session.project_slug,
    duration_minutes: durationMinutes,
    total_events: events.length,
    role_counts: roleCounts,
    type_counts: typeCounts,
    redaction_hits: envelope.session.redaction.hits,
    top_tools: topTools,
    inflection_points: inflectionPoints.sort((a, b) => a.seq - b.seq),
    user_arc: userArc,
    user_arc_truncated: false as boolean,
  };

  // Secondary budget: if the preDigest serialises beyond 20 KB, trim user_arc further
  while (JSON.stringify(preDigest).length > 20000 && preDigest.user_arc.length > 0) {
    preDigest.user_arc = preDigest.user_arc.slice(0, Math.max(0, preDigest.user_arc.length - 5));
    preDigest.user_arc_truncated = true;
  }
  if (preDigest.user_arc.length < userArc.length) {
    preDigest.user_arc_truncated = true;
  }

  return preDigest;
}

// ---------------------------------------------------------------------------
// Event sampler (char budget ~40KB)
// ---------------------------------------------------------------------------

const CHAR_BUDGET = 40_000;
const ASSISTANT_SAMPLE_EACH_END = 8;

function sampleEvents(events: EnvelopeEvent[]): string {
  const parts: string[] = [];
  let budget = CHAR_BUDGET;

  const append = (text: string): boolean => {
    if (budget <= 0) return false;
    const chunk = text.slice(0, budget);
    parts.push(chunk);
    budget -= chunk.length;
    return true;
  };

  // ALL user + error + compaction events
  const priority = events.filter(
    (e) =>
      (e.role === 'user' && e.type === 'message') ||
      e.type === 'error' ||
      e.type === 'compaction'
  );
  for (const ev of priority) {
    const line = `[seq:${ev.seq} role:${ev.role} type:${ev.type}] ${ev.text?.slice(0, 800) ?? ''}`;
    if (!append(line + '\n')) break;
  }

  // First ~8 + last ~8 assistant messages
  const assistant = events.filter((e) => e.role === 'assistant' && e.type === 'message' && e.text);
  const sampled = assistant.length <= ASSISTANT_SAMPLE_EACH_END * 2
    ? assistant
    : [
        ...assistant.slice(0, ASSISTANT_SAMPLE_EACH_END),
        ...assistant.slice(-ASSISTANT_SAMPLE_EACH_END),
      ];
  for (const ev of sampled) {
    const line = `[seq:${ev.seq} role:assistant] ${ev.text?.slice(0, 600) ?? ''}`;
    if (!append(line + '\n')) break;
  }

  return parts.join('');
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are a cairn session-distillation analyst. Your job is to read a compressed digest of an agent session transcript and extract cairn-improvement-relevant findings.

## Your methodology (mirror of /session-distill skill)

Analyze the session through cairn's lens:

### Pattern recognition
Match observed behaviors against the catalog of named patterns. When you recognize a pattern, cite it by name. For NEW patterns not in the catalog, name them descriptively and note instance count toward the 3-instance gate.

**Known catalog patterns (from cairn's foundational research and prior distillations):**
- cross-session-relay: user acts as information relay between sessions
- reframing: agent rotates solution space when stuck
- user-advocacy: user rotates builder to UX observer
- timing-judgment: cheap-now vs expensive-later decisions
- bidirectional-verification: agent corrects human with tool-log evidence
- cross-session-memory-namespace-fragmentation: memory namespace fragmentation across sessions
- feedback-velocity: agents driving framework evolution
- habitat-transfer: adaptation across platforms
- stub-spec-executed-anyway: executor proceeded on an elaborated stub
- silent-rm-on-windows: environment trap (bash rm vs Windows)
- status-report-without-spec-links: agent reports status without linking to specs
- self-improving-prompt: prompt that evolves itself
- pi-as-executor: Pi agent as zero-cairn-skills executor
- upstream-api-stream-drops: API stream drops at high token counts
- redundant-tool-calls: same tool called with identical args multiple times
- unverified-completion-claims: agent declares done without verification evidence
- namespace-bias: agent uses generic tools when namespace-specialized alternatives exist
- discipline-doesnt-survive-compaction: standing instructions lost after context compaction

### Four cairn-formalization-test questions (apply to each finding)
1. Is this a repeatable move?
2. Can the agent not do it alone?
3. Can it be structured (triggered, formatted, prompted)?
4. If yes, formalize how?

### Candidate categories
- **skill candidate**: new or enhanced skill (apply 3-instance gate — if < 3 instances, flag as "watch")
- **law candidate**: "never again" or "always do this" pattern (slug form)
- **memory candidate**: collaboration rules or project facts (feedback/<name> form)

## Output format
You MUST return a single JSON object conforming EXACTLY to this schema. Do NOT wrap in markdown or add commentary outside the JSON.

{
  "session_id": "<string — the session UUID>",
  "distilled_at": "<ISO-8601 timestamp>",
  "distiller": "<string — e.g. cairn-ingest@0.5.0>",
  "harness": "<string — claude-code|pi|antigravity>",
  "patterns": [
    {
      "name": "<catalog-name or new descriptive name>",
      "instance_count": <integer >= 0>,
      "evidence": "<seq range or short description>"
    }
  ],
  "candidates": {
    "skills": ["<skill-name>"],
    "laws": ["<law-slug>"],
    "memory": ["<memory-entry-name>"]
  },
  "links": {
    "note": null,
    "commit": null
  }
}

Rules:
- instance_count = 0 means seeded from prior ledger but not observed this session
- instance_count >= 1 means actually observed in this session
- Do NOT include patterns with 0 count unless they appear in the prior patterns list provided
- The 3-instance gate: skill candidates with fewer than 3 instances should be noted in evidence as "instance N/3 toward gate"
- Honesty: if the session is clean/short with no clear patterns, return patterns: [] and empty candidates
- STRICT JSON only — no markdown, no trailing commas, no comments`;
}

function buildUserPrompt(
  preDigest: PreDigest,
  sampledEvents: string,
  priorPatterns: string[],
): string {
  const priorSection =
    priorPatterns.length > 0
      ? `\n## Prior pattern names from corpus ledger (recognize, don't re-derive)\n${priorPatterns.map((p) => `- ${p}`).join('\n')}\n`
      : '\n## Prior patterns\n(none yet — this may be the first distillation in this corpus)\n';

  return `## Session pre-digest

${JSON.stringify(preDigest, null, 2)}
${priorSection}
## Sampled events (priority: user messages, errors, compactions + first/last assistant messages)

\`\`\`
${sampledEvents}
\`\`\`

## Task

Analyze the above session through cairn's lens. Return a single JSON object conforming to the finding schema.`;
}

// ---------------------------------------------------------------------------
// HTTP call
// ---------------------------------------------------------------------------

async function callLLM(
  baseUrl: string,
  apiKey: string,
  model: string,
  temperature: number,
  systemPrompt: string,
  userPrompt: string,
  timeout: number,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`LLM endpoint ${url} returned ${response.status}: ${body.slice(0, 500)}`);
    }

    // Timeout covers the full request + body read; cleared only after json() completes
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    clearTimeout(timer);

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('LLM response had no content in choices[0].message.content');
    }
    return content;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// JSON extraction (strip markdown code fences if model ignores json_object)
// ---------------------------------------------------------------------------

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  // Strip ```json ... ``` or ``` ... ```
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenced) return fenced[1].trim();
  // Strip leading/trailing non-JSON
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function distillEnvelope(
  envelope: Envelope,
  opts: DistillOptions,
): Promise<DistillResult> {
  const {
    corpusRoot,
    baseUrl,
    apiKey = 'local',
    model = process.env.CAIRN_DISTILL_MODEL ?? 'deepseek-v4-flash',
    temperature = 0.2,
    timeout = 120_000,
  } = opts;

  // Load schema and build validator
  const schema = loadFindingSchema(corpusRoot);
  const validate = makeValidator(schema);

  // Load prior patterns (compounding mechanism)
  const priorPatterns = loadPriorPatternNames(corpusRoot);

  // Build pre-digest (never serialize full events[])
  const preDigest = buildPreDigest(envelope);

  // Sample events within char budget
  const sampledEvents = sampleEvents(envelope.events ?? []);

  // Build prompts
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(preDigest, sampledEvents, priorPatterns);

  const version = await readPackageVersion();
  const distillerTag = `cairn-ingest@${version}`;
  const sessionId = envelope.session.id;
  const harness = envelope.session.harness;

  // Call LLM (with one retry on parse/validation failure)
  let rawContent: string;
  let parsedFinding: Finding | null = null;
  let validationErrors: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const promptForAttempt =
      attempt === 0
        ? userPrompt
        : userPrompt +
          `\n\n## CORRECTION REQUIRED\nYour previous response was not valid JSON or did not conform to the finding schema.\nErrors:\n${validationErrors.join('\n')}\nThe schema disallows any property not listed — remove any extra keys.\n\nReturn ONLY a valid JSON object. No markdown. No comments.`;

    rawContent = await callLLM(
      baseUrl,
      apiKey,
      model,
      temperature,
      systemPrompt,
      promptForAttempt,
      timeout,
    );

    const extracted = extractJson(rawContent);
    let parsed: unknown;
    try {
      parsed = JSON.parse(extracted);
    } catch (err) {
      validationErrors = [`JSON parse error: ${String(err)}`];
      if (attempt === 1) throw new Error(`distillEnvelope: JSON parse failed after retry: ${String(err)}`);
      continue;
    }

    validationErrors = validate(parsed);
    if (validationErrors.length === 0) {
      parsedFinding = parsed as Finding;
      break;
    }

    if (attempt === 1) {
      throw new Error(
        `distillEnvelope: finding schema validation failed after retry: ${validationErrors.join('; ')}`,
      );
    }
  }

  if (!parsedFinding) {
    throw new Error('distillEnvelope: unexpected null finding after loop');
  }

  // Stamp required fields
  parsedFinding.session_id = sessionId;
  parsedFinding.harness = harness;
  parsedFinding.distilled_at = new Date().toISOString();
  parsedFinding.distiller = distillerTag;
  parsedFinding.links ??= { note: null, commit: null };

  // Write to corpus
  const { findingsPath, ledgerUpdated } = writeFindingsLedger(
    corpusRoot,
    sessionId,
    harness,
    parsedFinding,
  );

  return { finding: parsedFinding, findingsPath, ledgerUpdated };
}

// ---------------------------------------------------------------------------
// Package version (read from package.json at runtime)
// ---------------------------------------------------------------------------

let _version: string | undefined;

async function readPackageVersion(): Promise<string> {
  if (_version) return _version;
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    _version = pkg.version ?? '0.0.0';
  } catch {
    _version = '0.0.0';
  }
  return _version;
}
