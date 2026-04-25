/** Heuristic claim phrases used by overclaim_check + session_distill. */
export const CLAIM_PHRASES: Array<{ phrase: string; kind: string }> = [
  { phrase: 'all tests pass', kind: 'test-pass' },
  { phrase: 'all tests passed', kind: 'test-pass' },
  { phrase: 'tests pass', kind: 'test-pass' },
  { phrase: 'tests passed', kind: 'test-pass' },
  { phrase: 'build is clean', kind: 'build-clean' },
  { phrase: 'build passes', kind: 'build-clean' },
  { phrase: 'build succeeds', kind: 'build-clean' },
  { phrase: 'should now work', kind: 'should-work' },
  { phrase: 'should work now', kind: 'should-work' },
  { phrase: 'should be working', kind: 'should-work' },
  { phrase: 'ready to test', kind: 'ready' },
  { phrase: 'ready for review', kind: 'ready' },
  { phrase: 'ready to ship', kind: 'ready' },
  { phrase: 'ready to merge', kind: 'ready' },
  // Word-boundary variants
  { phrase: 'fixed', kind: 'fixed' },
  { phrase: 'completed', kind: 'completed' },
  { phrase: 'complete', kind: 'completed' },
  { phrase: 'done', kind: 'done' },
];

export interface DetectedClaim {
  ts: string;
  text: string; // the matched line/sentence
  phrase: string; // matched phrase
  kind: string;
  block_index: number; // which agent_text_block this came from
}

/** Split text into sentences/lines so we can quote a tight excerpt around the claim. */
function quoteAround(text: string, phrase: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(phrase);
  if (idx === -1) return text.slice(0, 200);
  // Find sentence/line boundaries
  let start = 0;
  for (let i = idx; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n' || ch === '.' || ch === '!' || ch === '?') {
      start = i + 1;
      break;
    }
  }
  let end = text.length;
  for (let i = idx + phrase.length; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '.' || ch === '!' || ch === '?') {
      end = i + 1;
      break;
    }
  }
  return text.slice(start, end).trim().slice(0, 280);
}

/** Find all completion claims in agent text blocks. */
export function detectClaims(
  blocks: Array<{ ts: string; text: string }>
): DetectedClaim[] {
  const out: DetectedClaim[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    const lower = b.text.toLowerCase();
    for (const { phrase, kind } of CLAIM_PHRASES) {
      // Use word boundaries for short phrases to avoid e.g. "fixed-point" false positives
      const isShort = phrase.length <= 7 && !phrase.includes(' ');
      let found = false;
      if (isShort) {
        const re = new RegExp(`(^|[^a-zA-Z0-9])${phrase}([^a-zA-Z0-9]|$)`, 'i');
        found = re.test(b.text);
      } else {
        found = lower.includes(phrase);
      }
      if (found) {
        out.push({
          ts: b.ts,
          text: quoteAround(b.text, phrase),
          phrase,
          kind,
          block_index: bi,
        });
      }
    }
  }
  return out;
}

const VERIFY_TOOLS = new Set([
  'Bash',
  'PowerShell',
  // common build/test tools an agent may invoke
  'cwar_build_check',
  'cwar_run_tests',
  'mcp__cwar__cwar_build_check',
  'mcp__cwar__cwar_run_tests',
]);

const VERIFY_BASH_PATTERNS = [
  /\bnpm\s+(run\s+)?(test|build|lint)\b/,
  /\btsc\b/,
  /\beslint\b/,
  /\bjest\b/,
  /\bvitest\b/,
  /\bpnpm\s+(test|build|lint)\b/,
  /\byarn\s+(test|build|lint)\b/,
  /\bcargo\s+(test|build|check)\b/,
  /\bgo\s+(test|build|vet)\b/,
  /\bpython\s+-m\s+pytest\b/,
  /\bpytest\b/,
  /\bgit\s+commit\b/, // commit after claim is a soft-verify
];

/**
 * Decide if a claim was verified within a window after it was made.
 * Heuristic: any verify-tool tool_call with ts > claim.ts and within `windowMs`,
 * OR a subsequent user_text_block that appears to acknowledge ("good", "perfect", "lgtm", "thanks").
 */
export interface ClaimVerification {
  verified: boolean;
  via?: string;
}

const ACK_PATTERNS = [
  /\b(perfect|great|nice|lgtm|looks good|works|thanks|ty|approved|ship it|merge it)\b/i,
];

export function checkVerification(
  claim: DetectedClaim,
  toolCalls: Array<{ ts: string; tool: string; args?: unknown }>,
  userBlocks: Array<{ ts: string; text: string }>,
  windowMs = 10 * 60 * 1000
): ClaimVerification {
  const claimMs = Date.parse(claim.ts) || 0;
  if (claimMs === 0) return { verified: false };

  for (const tc of toolCalls) {
    const tcMs = Date.parse(tc.ts) || 0;
    if (tcMs <= claimMs || tcMs - claimMs > windowMs) continue;
    if (VERIFY_TOOLS.has(tc.tool)) {
      // For Bash/PowerShell, require a build/test command pattern in args.command
      if (tc.tool === 'Bash' || tc.tool === 'PowerShell') {
        const cmd = (tc.args as { command?: string } | undefined)?.command || '';
        if (VERIFY_BASH_PATTERNS.some((re) => re.test(cmd))) {
          return { verified: true, via: `${tc.tool}: ${cmd.slice(0, 80)}` };
        }
      } else {
        return { verified: true, via: tc.tool };
      }
    }
  }

  for (const ub of userBlocks) {
    const ubMs = Date.parse(ub.ts) || 0;
    if (ubMs <= claimMs || ubMs - claimMs > windowMs) continue;
    if (ACK_PATTERNS.some((re) => re.test(ub.text))) {
      return { verified: true, via: `user-ack: ${ub.text.slice(0, 80).replace(/\s+/g, ' ')}` };
    }
  }

  return { verified: false };
}
