import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFileSync } from 'child_process';
import {
  expandTilde,
  humanizeAge,
  jsonResult,
  pathToSlug,
  safeReadText,
  safeStat,
  walkFiles,
} from '../helpers.js';
import { getCairnManifest, getCairnLatestVersion, type ManifestFile } from '../cairnManifest.js';

const TIER_ORDER = ['seed', 'grow', 'structure', 'full'] as const;
type Tier = (typeof TIER_ORDER)[number];

/** Resolve a manifest dest template against the project root. */
function resolveDest(
  destTemplate: string,
  projectPath: string,
  slug: string
): string {
  const home = os.homedir();
  const projectClaude = path.join(projectPath, '.claude');
  const userMemoryProjectScoped = path.join(home, '.claude', 'projects', slug, 'memory');
  // Per cairn manifest, claude-code has TWO conventions for userMemory + userSkills.
  // We probe project-scoped first (it's the convention this MCP server primarily targets),
  // then fall back to user-global if project-scoped doesn't exist.
  return destTemplate
    .replace('{projectRoot}', projectPath)
    .replace('{projectClaude}', projectClaude)
    .replace('{userMemory}', userMemoryProjectScoped)
    .replace('{userSkills}', path.join(home, '.claude', 'skills'))
    .replace('{userClaude}', path.join(home, '.claude'))
    .replace(/\{cwd\}/g, projectPath);
}

/** Try to resolve a dest under multiple userMemory/userSkills conventions and pick whichever exists. */
function resolveDestWithFallback(
  destTemplate: string,
  projectPath: string,
  slug: string
): { resolved: string; exists: boolean } {
  const home = os.homedir();
  const projectScoped = resolveDest(destTemplate, projectPath, slug);
  if (fs.existsSync(projectScoped)) return { resolved: projectScoped, exists: true };

  // Fallback: user-global memory/skills
  if (destTemplate.includes('{userMemory}')) {
    const userGlobal = destTemplate
      .replace('{userMemory}', path.join(home, '.claude', 'memory'))
      .replace('{projectRoot}', projectPath)
      .replace('{projectClaude}', path.join(projectPath, '.claude'))
      .replace('{userSkills}', path.join(home, '.claude', 'skills'))
      .replace('{userClaude}', path.join(home, '.claude'))
      .replace(/\{cwd\}/g, projectPath);
    if (fs.existsSync(userGlobal)) return { resolved: userGlobal, exists: true };
  }
  if (destTemplate.includes('{userSkills}')) {
    const projectSkills = destTemplate
      .replace('{userSkills}', path.join(projectPath, '.claude', 'skills'))
      .replace('{userMemory}', path.join(home, '.claude', 'projects', slug, 'memory'))
      .replace('{projectRoot}', projectPath)
      .replace('{projectClaude}', path.join(projectPath, '.claude'))
      .replace('{userClaude}', path.join(home, '.claude'))
      .replace(/\{cwd\}/g, projectPath);
    if (fs.existsSync(projectSkills)) return { resolved: projectSkills, exists: true };
  }

  return { resolved: projectScoped, exists: false };
}

/** Infer tier by counting which tier's files are present. */
function inferTier(files: ManifestFile[], present: Set<string>): Tier | 'unknown' {
  // Group files by tier (files have a single tier label).
  const tierFiles = new Map<Tier, ManifestFile[]>();
  for (const t of TIER_ORDER) tierFiles.set(t, []);
  for (const f of files) {
    if (f.tier && (TIER_ORDER as readonly string[]).includes(f.tier)) {
      tierFiles.get(f.tier as Tier)!.push(f);
    }
  }

  // Tiers are cumulative; "highest tier where >= 50% of that tier's files are present
  // AND all lower tiers are >= 50% present" wins.
  let inferred: Tier | 'unknown' = 'unknown';
  for (const t of TIER_ORDER) {
    const tFiles = tierFiles.get(t)!;
    if (tFiles.length === 0) continue;
    const presentCount = tFiles.filter((f) => present.has(f.dest)).length;
    if (presentCount / tFiles.length >= 0.5) {
      inferred = t;
    } else {
      break; // gap detected; stop ratcheting
    }
  }
  return inferred;
}

/** Parse `## Related memory paths` section out of HANDOFF.md. */
function parseRelatedMemoryPaths(handoffText: string): string[] {
  const out: string[] = [];
  const lines = handoffText.split('\n');
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Related memory paths/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s/.test(line)) break; // next section
    if (inSection) {
      // Look for `- ~/.claude/...` or backtick paths
      const m = line.match(/[`-]\s*([~][^`\s)]+|\/[^`\s)]+|[A-Z]:[\\/][^`\s)]+)/);
      if (m) {
        const p = m[1].replace(/[`,]+$/, '').trim();
        if (p && !out.includes(p)) out.push(p);
      }
    }
  }
  return out;
}

function safeGitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function gitState(projectPath: string) {
  const isRepo = safeGitOutput(projectPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!isRepo) {
    return { is_repo: false, last_commit: null, branch: null, dirty: false };
  }
  const branch = safeGitOutput(projectPath, ['branch', '--show-current']);
  const lastLog = safeGitOutput(projectPath, [
    'log',
    '-1',
    '--format=%H%x09%s%x09%ct',
  ]);
  let lastCommit: { hash: string; subject: string; age_human: string } | null = null;
  if (lastLog) {
    const [hash, subject, ct] = lastLog.split('\t');
    const ageSec = Math.floor(Date.now() / 1000 - parseInt(ct, 10));
    lastCommit = { hash: hash.slice(0, 12), subject, age_human: humanizeAge(ageSec) };
  }
  const status = safeGitOutput(projectPath, ['status', '--porcelain']);
  const dirty = !!status && status.length > 0;
  return { is_repo: true, last_commit: lastCommit, branch, dirty };
}

function memorySummary(home: string, slug: string) {
  const userGlobalRoot = path.join(home, '.claude', 'memory');
  const projectScopedRoot = path.join(home, '.claude', 'projects', slug, 'memory');

  const countMd = (root: string): number => {
    if (!fs.existsSync(root)) return 0;
    return walkFiles(root).filter((p) => p.endsWith('.md')).length;
  };
  const userGlobalEntries = countMd(userGlobalRoot);
  const projectScopedEntries = countMd(projectScopedRoot);

  // Find the most recent write across both roots.
  let lastWrite: { path: string; age_human: string } | null = null;
  let maxMtime = 0;
  for (const root of [userGlobalRoot, projectScopedRoot]) {
    if (!fs.existsSync(root)) continue;
    for (const f of walkFiles(root)) {
      const stat = safeStat(f);
      if (stat && stat.mtimeMs > maxMtime) {
        maxMtime = stat.mtimeMs;
        const ageSec = Math.floor((Date.now() - stat.mtimeMs) / 1000);
        lastWrite = { path: f, age_human: humanizeAge(ageSec) };
      }
    }
  }

  return {
    user_global_root: userGlobalRoot,
    project_scoped_root: projectScopedRoot,
    user_global_entries: userGlobalEntries,
    project_scoped_entries: projectScopedEntries,
    last_write: lastWrite,
  };
}

export function register(server: McpServer): void {
  server.tool(
    'habitat_status',
    'Composite probe of a cairn habitat. Returns installed/latest cairn version, drift flag, inferred tier, manifest files present/missing, HANDOFF.md state (with parsed related memory paths), memory entry counts (user-global + project-scoped), and git state. Defaults to process.cwd(). Fetches the cairn manifest from GitHub on first call (cached for the process lifetime).',
    {
      project_path: z
        .string()
        .optional()
        .describe('Absolute path to the project directory. Defaults to the current working directory.'),
    },
    async ({ project_path }) => {
      const projectPath = project_path
        ? path.resolve(expandTilde(project_path))
        : process.cwd();
      const slug = pathToSlug(projectPath);
      const home = os.homedir();

      // Installed version (from <project>/.claude/cairn-version)
      const versionFile = path.join(projectPath, '.claude', 'cairn-version');
      const installed = safeReadText(versionFile)?.trim() || null;

      // Latest version (HTTP)
      const latest = await getCairnLatestVersion();

      // Manifest (HTTP, cached)
      const manifest = await getCairnManifest();
      const manifestFiles = manifest?.files ?? [];

      // Resolve every manifest dest, classify present/missing
      const present: string[] = [];
      const missing: string[] = [];
      const presentSet = new Set<string>();
      for (const f of manifestFiles) {
        const { resolved, exists } = resolveDestWithFallback(f.dest, projectPath, slug);
        if (exists) {
          present.push(resolved);
          presentSet.add(f.dest); // track by template for tier inference
        } else {
          missing.push(resolved);
        }
      }

      const tierInferred = inferTier(manifestFiles, presentSet);

      // HANDOFF.md probe
      const handoffPath = path.join(projectPath, 'HANDOFF.md');
      const handoffStat = safeStat(handoffPath);
      const handoffExists = !!handoffStat;
      let relatedMemoryPaths: string[] = [];
      let handoffMtimeIso: string | null = null;
      let handoffAgeHuman: string | null = null;
      if (handoffExists && handoffStat) {
        handoffMtimeIso = new Date(handoffStat.mtimeMs).toISOString();
        const ageSec = Math.floor((Date.now() - handoffStat.mtimeMs) / 1000);
        handoffAgeHuman = humanizeAge(ageSec);
        const txt = safeReadText(handoffPath);
        if (txt) relatedMemoryPaths = parseRelatedMemoryPaths(txt);
      }

      const result = {
        project_path: projectPath,
        slug,
        cairn_version_installed: installed,
        cairn_version_latest: latest,
        version_drift: !!installed && !!latest && installed !== latest,
        tier_inferred: tierInferred,
        files_present: present,
        files_missing: missing,
        handoff_md: {
          path: handoffExists ? handoffPath : null,
          exists: handoffExists,
          last_modified: handoffMtimeIso,
          age_human: handoffAgeHuman,
          related_memory_paths: relatedMemoryPaths,
        },
        memory: memorySummary(home, slug),
        git: gitState(projectPath),
      };

      return jsonResult(result);
    }
  );
}
