import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from '../helpers.js';

const ENDPOINTS = [
  {
    url: 'https://cairn-feedback-591252228833.us-central1.run.app/feedback',
    source: 'cloudrun',
  },
  {
    url: 'https://cairn.winnorton.com/feedback',
    source: 'domain',
  },
] as const;

const CATEGORY = z.enum(['gap', 'bug', 'skill-idea', 'clarification', 'docs', 'design']);
const SEVERITY = z.enum(['low', 'medium', 'high']);

interface Payload {
  category: string;
  severity: string;
  title: string;
  body: string;
  context?: string;
  cairn_version?: string;
  environment?: string;
}

async function tryPost(url: string, payload: Payload): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: e instanceof Error ? e.message : String(e) };
  }
}

function extractIssueUrl(responseText: string): string | null {
  // Endpoint typically returns JSON with an `issue_url` or `url` field.
  try {
    const json = JSON.parse(responseText);
    if (typeof json.issue_url === 'string') return json.issue_url;
    if (typeof json.url === 'string') return json.url;
    if (typeof json.html_url === 'string') return json.html_url;
  } catch {
    // Plain-text fallback: look for a github URL
    const m = responseText.match(/https?:\/\/github\.com\/[^\s)"']+/);
    if (m) return m[0];
  }
  return null;
}

export function register(server: McpServer): void {
  server.tool(
    'feedback_post',
    "POST structured feedback to cairn's hosted feedback endpoint with three-level fallback. Tries the Cloud Run direct URL first, then the custom domain. On total failure, returns { delivered: false, fallback_payload } so the agent can fall back to `gh issue create` or paste the body manually.",
    {
      category: CATEGORY.describe('One of gap | bug | skill-idea | clarification | docs | design.'),
      severity: SEVERITY.describe('One of low | medium | high.'),
      title: z.string().max(120).describe('Short title (<=120 chars).'),
      body: z.string().max(20000).describe('Markdown body of the feedback (<=20000 chars).'),
      context: z.string().optional().describe('Optional additional markdown context.'),
      cairn_version: z.string().optional().describe('Optional semver of the cairn version observed.'),
      environment: z
        .string()
        .optional()
        .describe('Optional environment description (e.g. "Claude Code", "Cowork", "claude.ai").'),
    },
    async (args) => {
      const payload: Payload = {
        category: args.category,
        severity: args.severity,
        title: args.title,
        body: args.body,
        ...(args.context !== undefined ? { context: args.context } : {}),
        ...(args.cairn_version !== undefined ? { cairn_version: args.cairn_version } : {}),
        ...(args.environment !== undefined ? { environment: args.environment } : {}),
      };

      const attempts: Array<{ url: string; source: string; status: number; ok: boolean; error?: string }> = [];

      for (const endpoint of ENDPOINTS) {
        const result = await tryPost(endpoint.url, payload);
        attempts.push({
          url: endpoint.url,
          source: endpoint.source,
          status: result.status,
          ok: result.ok,
          ...(result.ok ? {} : { error: result.text.slice(0, 500) }),
        });
        if (result.ok) {
          const issueUrl = extractIssueUrl(result.text);
          return jsonResult({
            delivered: true,
            issue_url: issueUrl,
            source: endpoint.source,
            response_excerpt: result.text.slice(0, 500),
            attempts,
          });
        }
      }

      // All endpoints failed — return fallback payload
      return jsonResult({
        delivered: false,
        fallback_payload: payload,
        attempts,
        suggestion:
          'All endpoints failed. Use `gh issue create --repo winnorton/cairn` with the fallback_payload, or paste the body into a new issue manually.',
      });
    }
  );
}
