import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { pathToSlug, humanizeAge, safeStat, safeReadText, walkFiles } from '../helpers.js';

// ─── Types ──────────────────────────────────────────────────────

interface HabitatInfo {
  path: string;
  slug: string;
  tier: string;
  filesPresent: number;
  filesMissing: number;
  version: string | null;
  dirty: boolean;
  branch: string | null;
  lastCommit: string | null;
  lastCommitAge: string | null;
}

interface MemoryEntry {
  slug: string;
  type: string;
  name: string;
  path: string;
  ageHuman: string;
}

interface VersionInfo {
  canonical: string | null;
  consistent: boolean;
  mismatches: string[];
}

interface IssueInfo {
  repo: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  url: string;
  createdAt: string;
  ageHuman: string;
}

interface DashboardData {
  habitats: HabitatInfo[];
  memoryEntries: MemoryEntry[];
  totalUserGlobal: number;
  totalProjectScoped: number;
  version: VersionInfo;
  tools: string[];
  serverVersion: string;
  lastUpdate: Date;
  loading: boolean;
}

const INITIAL: DashboardData = {
  habitats: [], memoryEntries: [],
  totalUserGlobal: 0, totalProjectScoped: 0,
  version: { canonical: null, consistent: true, mismatches: [] },
  tools: ['slug_for', 'paths_for', 'now', 'age_of', 'habitat_status', 'check_version_consistency', 'memory_query', 'feedback_post'],
  serverVersion: '0.1.0',
  lastUpdate: new Date(), loading: true,
};

// ─── Helpers ────────────────────────────────────────────────────

function trunc(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function safeGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
  } catch { return null; }
}

const TABS = ['◈ Overview', '◆ Habitats', '◇ Memory', '◉ Tools', '◎ Version', '◐ Issues'] as const;

const ISSUE_REPOS = ['cairn', 'cairn-mcp-server'] as const;

// ─── Data Hook ──────────────────────────────────────────────────

function useData(intervalMs = 3000) {
  const [data, setData] = useState<DashboardData>(INITIAL);

  const refresh = useCallback(() => {
    try {
      const home = os.homedir();
      const projectsDir = path.join(home, '.claude', 'projects');
      const userGlobalRoot = path.join(home, '.claude', 'memory');

      // Count user-global memory entries
      let totalUserGlobal = 0;
      if (fs.existsSync(userGlobalRoot)) {
        totalUserGlobal = walkFiles(userGlobalRoot).filter(f => f.endsWith('.md')).length;
      }

      // Discover all project slugs and their memory
      const habitats: HabitatInfo[] = [];
      const memoryEntries: MemoryEntry[] = [];
      let totalProjectScoped = 0;

      // Add user-global memory entries
      if (fs.existsSync(userGlobalRoot)) {
        for (const f of walkFiles(userGlobalRoot).filter(p => p.endsWith('.md'))) {
          const stat = safeStat(f);
          if (!stat) continue;
          const rel = path.relative(userGlobalRoot, f);
          const parts = rel.split(/[\\/]/);
          const type = parts.length >= 2 ? parts[0] : '<root>';
          const name = parts.length >= 2 ? parts.slice(1).join('/').replace(/\.md$/, '') : parts[0].replace(/\.md$/, '');
          memoryEntries.push({
            slug: '<user-global>',
            type, name, path: f,
            ageHuman: humanizeAge(Math.floor((Date.now() - stat.mtimeMs) / 1000)),
          });
        }
      }

      if (fs.existsSync(projectsDir)) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(projectsDir, { withFileTypes: true }); }
        catch { entries = []; }

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const slug = entry.name;
          const memRoot = path.join(projectsDir, slug, 'memory');

          // Count project-scoped memory
          if (fs.existsSync(memRoot)) {
            const mdFiles = walkFiles(memRoot).filter(f => f.endsWith('.md'));
            totalProjectScoped += mdFiles.length;
            for (const f of mdFiles) {
              const stat = safeStat(f);
              if (!stat) continue;
              const rel = path.relative(memRoot, f);
              const parts = rel.split(/[\\/]/);
              const type = parts.length >= 2 ? parts[0] : '<root>';
              const name = parts.length >= 2 ? parts.slice(1).join('/').replace(/\.md$/, '') : parts[0].replace(/\.md$/, '');
              memoryEntries.push({
                slug, type, name, path: f,
                ageHuman: humanizeAge(Math.floor((Date.now() - stat.mtimeMs) / 1000)),
              });
            }
          }

          // Try to resolve habitat info
          const claudeDir = path.join(projectsDir, slug);
          const settingsPath = path.join(claudeDir, 'settings.json');
          if (!fs.existsSync(settingsPath)) continue;

          // Try to reverse slug to path and probe git
          let projectPath: string | null = null;
          const winMatch = slug.match(/^([A-Za-z])--(.+)$/);
          if (winMatch) {
            const candidate = `${winMatch[1]}:\\${winMatch[2].replace(/-/g, '\\')}`;
            if (fs.existsSync(candidate)) projectPath = candidate;
          }

          if (projectPath) {
            const isRepo = safeGit(projectPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
            const branch = isRepo ? safeGit(projectPath, ['branch', '--show-current']) : null;
            const lastLog = isRepo ? safeGit(projectPath, ['log', '-1', '--format=%H\t%s\t%ct']) : null;
            let lastCommit: string | null = null;
            let lastCommitAge: string | null = null;
            if (lastLog) {
              const [hash, subject, ct] = lastLog.split('\t');
              lastCommit = `${hash.slice(0, 8)} ${subject}`;
              lastCommitAge = humanizeAge(Math.floor(Date.now() / 1000 - parseInt(ct, 10)));
            }
            const status = isRepo ? safeGit(projectPath, ['status', '--porcelain']) : null;
            const dirty = !!status && status.length > 0;

            // Infer tier from .claude directory contents
            const projectClaudeDir = path.join(projectPath, '.claude');
            let tier = 'unknown';
            if (fs.existsSync(path.join(projectClaudeDir, 'LAWS.md'))) tier = 'full';
            else if (fs.existsSync(path.join(projectPath, 'AGENTS.md'))) tier = 'structure';
            else if (fs.existsSync(path.join(projectPath, 'CLAUDE.md'))) tier = 'grow';
            else if (fs.existsSync(projectClaudeDir)) tier = 'seed';

            const versionFile = path.join(projectClaudeDir, 'cairn-version');
            const version = safeReadText(versionFile)?.trim() || null;

            habitats.push({
              path: projectPath, slug, tier,
              filesPresent: 0, filesMissing: 0,
              version, dirty, branch, lastCommit, lastCommitAge,
            });
          }
        }
      }

      // Sort memory entries newest first
      memoryEntries.sort((a, b) => {
        const sa = safeStat(a.path);
        const sb = safeStat(b.path);
        return (sb?.mtimeMs ?? 0) - (sa?.mtimeMs ?? 0);
      });

      // Version consistency for this repo
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1'), '..', '..');
      const versionText = safeReadText(path.join(repoRoot, 'VERSION'));
      const canonical = versionText?.trim() || null;

      setData(prev => ({
        ...prev,
        habitats, memoryEntries,
        totalUserGlobal, totalProjectScoped,
        version: { canonical, consistent: true, mismatches: [] },
        lastUpdate: new Date(), loading: false,
      }));
    } catch {
      // keep previous data on error
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { data, refresh };
}

// ─── Issues Hook ────────────────────────────────────────────────

function useIssues() {
  const [issues, setIssues] = useState<IssueInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [showAll, setShowAll] = useState(false);

  const showAllRef = useRef(showAll);
  showAllRef.current = showAll;

  const refetch = useCallback((stateOverride?: 'open' | 'all') => {
    const state = stateOverride ?? (showAllRef.current ? 'all' : 'open');
    setLoading(true);
    setError(null);
    try {
      const all: IssueInfo[] = [];
      for (const repo of ISSUE_REPOS) {
        const out = execFileSync('gh', [
          'issue', 'list',
          '--repo', `winnorton/${repo}`,
          '--state', state,
          '--limit', '30',
          '--json', 'number,title,labels,state,createdAt,url',
        ], {
          encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
        });
        const arr = JSON.parse(out) as Array<{
          number: number;
          title: string;
          labels: Array<{ name: string }>;
          state: string;
          createdAt: string;
          url: string;
        }>;
        for (const i of arr) {
          all.push({
            repo,
            number: i.number,
            title: i.title,
            state: i.state,
            labels: (i.labels || []).map((l) => l.name),
            url: i.url,
            createdAt: i.createdAt,
            ageHuman: humanizeAge(Math.floor((Date.now() - new Date(i.createdAt).getTime()) / 1000)),
          });
        }
      }
      all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setIssues(all);
      setLastFetch(new Date());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg.includes('ENOENT') ? 'gh CLI not found in PATH' : msg);
    } finally {
      setLoading(false);
    }
  }, []);

  return { issues, loading, error, lastFetch, showAll, setShowAll, refetch };
}

// ─── Components ─────────────────────────────────────────────────

function Header({ data }: { data: DashboardData }) {
  const time = data.lastUpdate.toLocaleTimeString();
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">🪨 CAIRN MCP SERVER</Text>
        <Text dimColor> — Management Console</Text>
      </Box>
      <Box gap={2} marginTop={0}>
        <Text color="green">● RUNNING</Text>
        <Text dimColor>│</Text>
        <Text color="magenta">{data.habitats.length}</Text><Text dimColor> habitats</Text>
        <Text dimColor>│</Text>
        <Text color="magenta">{data.totalUserGlobal + data.totalProjectScoped}</Text><Text dimColor> memories</Text>
        <Text dimColor>│</Text>
        <Text color="magenta">{data.tools.length}</Text><Text dimColor> tools</Text>
        <Text dimColor>│</Text>
        <Text dimColor>v{data.serverVersion}</Text>
        <Text dimColor>│</Text>
        <Text dimColor>↻ {time}</Text>
        {data.loading && <Text color="cyan"> <Spinner type="dots" /></Text>}
      </Box>
      <Text dimColor>{'━'.repeat(76)}</Text>
    </Box>
  );
}

function TabBar({ active }: { active: number }) {
  return (
    <Box paddingX={1} gap={1} marginBottom={0}>
      {TABS.map((label, i) => (
        <Box key={i}>
          {i === active
            ? <Text bold underline color="cyan"> {label} </Text>
            : <Text dimColor> {label} </Text>
          }
        </Box>
      ))}
    </Box>
  );
}

function tierColor(t: string): string {
  if (t === 'full') return 'green';
  if (t === 'structure') return 'cyan';
  if (t === 'grow') return 'yellow';
  if (t === 'seed') return 'magenta';
  return 'gray';
}

function OverviewPanel({ data }: { data: DashboardData }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={2}>
        {/* Habitat Summary */}
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1} width={38}>
          <Text bold color="cyan"> Habitats</Text>
          <Box><Text dimColor>Tracked:    </Text><Text bold>{data.habitats.length}</Text></Box>
          <Box><Text dimColor>Full tier:  </Text><Text bold color="green">{data.habitats.filter(h => h.tier === 'full').length}</Text></Box>
          <Box><Text dimColor>Structure:  </Text><Text bold color="cyan">{data.habitats.filter(h => h.tier === 'structure').length}</Text></Box>
          <Box><Text dimColor>Grow:       </Text><Text bold color="yellow">{data.habitats.filter(h => h.tier === 'grow').length}</Text></Box>
          <Box><Text dimColor>Seed:       </Text><Text bold color="magenta">{data.habitats.filter(h => h.tier === 'seed').length}</Text></Box>
        </Box>

        {/* Memory Summary */}
        <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1} width={38}>
          <Text bold color="magenta"> Memory</Text>
          <Box><Text dimColor>User-global:     </Text><Text bold>{data.totalUserGlobal}</Text></Box>
          <Box><Text dimColor>Project-scoped:  </Text><Text bold>{data.totalProjectScoped}</Text></Box>
          <Box><Text dimColor>Total entries:   </Text><Text bold>{data.totalUserGlobal + data.totalProjectScoped}</Text></Box>
          <Box><Text dimColor>Slugs tracked:   </Text><Text bold>{new Set(data.memoryEntries.map(m => m.slug)).size}</Text></Box>
          <Box><Text dimColor>Server version:  </Text><Text bold>v{data.serverVersion}</Text></Box>
        </Box>
      </Box>

      {/* Recent Memory Activity */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <Text bold color="cyan"> Recent Memory Activity</Text>
        {data.memoryEntries.length === 0
          ? <Text dimColor>  No memory entries found.</Text>
          : data.memoryEntries.slice(0, 8).map((m, i) => (
              <Box key={i} gap={1}>
                <Text dimColor>{pad(m.ageHuman, 10)}</Text>
                <Text color="cyan">{pad(trunc(m.slug, 18), 18)}</Text>
                <Text color="yellow">{pad(m.type, 10)}</Text>
                <Text>{trunc(m.name, 34)}</Text>
              </Box>
            ))
        }
      </Box>
    </Box>
  );
}

function HabitatsPanel({ data }: { data: DashboardData }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan"> Discovered Habitats</Text>
        <Box gap={1}>
          <Text bold>{pad('Project', 30)}</Text>
          <Text bold>{pad('Tier', 10)}</Text>
          <Text bold>{pad('Branch', 12)}</Text>
          <Text bold>{pad('Dirty', 6)}</Text>
          <Text bold>{pad('Version', 8)}</Text>
        </Box>
        <Text dimColor>{'─'.repeat(70)}</Text>
        {data.habitats.length === 0
          ? <Text dimColor>  No habitats discovered. Projects need a ~/.claude/projects/&lt;slug&gt;/ directory.</Text>
          : data.habitats.map((h) => (
              <Box key={h.slug} gap={1}>
                <Text color="white">{pad(trunc(path.basename(h.path), 30), 30)}</Text>
                <Text color={tierColor(h.tier)} bold>{pad(h.tier.toUpperCase(), 10)}</Text>
                <Text dimColor>{pad(h.branch ?? '—', 12)}</Text>
                <Text color={h.dirty ? 'yellow' : 'green'}>{pad(h.dirty ? 'yes' : 'clean', 6)}</Text>
                <Text dimColor>{pad(h.version ?? '—', 8)}</Text>
              </Box>
            ))
        }
      </Box>

      {/* Detail for first habitat */}
      {data.habitats.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
          <Text bold color="cyan"> Habitat Detail</Text>
          {data.habitats.slice(0, 5).map((h) => (
            <Box key={h.slug} flexDirection="column" marginBottom={1}>
              <Box><Text dimColor>Path:    </Text><Text>{h.path}</Text></Box>
              <Box><Text dimColor>Slug:    </Text><Text color="cyan">{trunc(h.slug, 50)}</Text></Box>
              {h.lastCommit && (
                <Box><Text dimColor>Commit:  </Text><Text>{trunc(h.lastCommit, 50)}</Text><Text dimColor> ({h.lastCommitAge})</Text></Box>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function MemoryPanel({ data }: { data: DashboardData }) {
  // Group by slug
  const slugs = [...new Set(data.memoryEntries.map(m => m.slug))];

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Summary bar */}
      <Box gap={2} marginBottom={1}>
        <Text color="green">● {data.totalUserGlobal} user-global</Text>
        <Text color="cyan">● {data.totalProjectScoped} project-scoped</Text>
        <Text color="magenta">● {slugs.length} slugs</Text>
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan"> All Memory Entries</Text>
        <Box gap={1}>
          <Text bold>{pad('Age', 10)}</Text>
          <Text bold>{pad('Slug', 18)}</Text>
          <Text bold>{pad('Type', 10)}</Text>
          <Text bold>Name</Text>
        </Box>
        <Text dimColor>{'─'.repeat(70)}</Text>
        {data.memoryEntries.length === 0
          ? <Text dimColor>  No memory entries found.</Text>
          : data.memoryEntries.slice(0, 20).map((m, i) => (
              <Box key={i} gap={1}>
                <Text dimColor>{pad(m.ageHuman, 10)}</Text>
                <Text color="cyan">{pad(trunc(m.slug, 18), 18)}</Text>
                <Text color="yellow">{pad(m.type, 10)}</Text>
                <Text>{trunc(m.name, 30)}</Text>
              </Box>
            ))
        }
        {data.memoryEntries.length > 20 && (
          <Text dimColor>  ... and {data.memoryEntries.length - 20} more entries</Text>
        )}
      </Box>
    </Box>
  );
}

function ToolsPanel({ data }: { data: DashboardData }) {
  const toolDescriptions: Record<string, string> = {
    'slug_for': 'Convert filesystem path → cairn slug',
    'paths_for': 'Reverse slug → candidate paths',
    'now': 'Current wall-clock time (ISO, unix, human)',
    'age_of': 'File mtime + age for any path',
    'habitat_status': 'Full habitat probe (tier, files, git, memory)',
    'check_version_consistency': 'Scan version strings across repo files',
    'memory_query': 'Search memory entries across slugs',
    'feedback_post': 'POST feedback to cairn endpoint with fallback',
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan"> Registered Tools ({data.tools.length})</Text>
        <Box gap={1}>
          <Text bold>{pad('Tool', 30)}</Text>
          <Text bold>Description</Text>
        </Box>
        <Text dimColor>{'─'.repeat(70)}</Text>
        {data.tools.map((tool) => (
          <Box key={tool} gap={1}>
            <Text color="cyan">{pad(tool, 30)}</Text>
            <Text dimColor>{toolDescriptions[tool] ?? '—'}</Text>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1} marginTop={1}>
        <Text bold color="magenta"> Server Info</Text>
        <Box><Text dimColor>Name:       </Text><Text>cairn-mcp-server</Text></Box>
        <Box><Text dimColor>Version:    </Text><Text>v{data.serverVersion}</Text></Box>
        <Box><Text dimColor>Transport:  </Text><Text>stdio</Text></Box>
        <Box><Text dimColor>Node:       </Text><Text>{process.version}</Text></Box>
        <Box><Text dimColor>Platform:   </Text><Text>{process.platform} {os.arch()}</Text></Box>
        <Box><Text dimColor>Home:       </Text><Text>{os.homedir()}</Text></Box>
      </Box>
    </Box>
  );
}

function VersionPanel({ data }: { data: DashboardData }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan"> Version Consistency</Text>
        <Box><Text dimColor>Canonical (VERSION):  </Text><Text bold>{data.version.canonical ?? '(not found)'}</Text></Box>
        <Box>
          <Text dimColor>Status:               </Text>
          <Text bold color={data.version.consistent ? 'green' : 'red'}>
            {data.version.consistent ? '✓ CONSISTENT' : '✗ MISMATCHES FOUND'}
          </Text>
        </Box>
        {data.version.mismatches.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="red"> Mismatches:</Text>
            {data.version.mismatches.map((m, i) => (
              <Box key={i}><Text color="red">  • {m}</Text></Box>
            ))}
          </Box>
        )}
      </Box>

      {/* Habitat versions */}
      <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1} marginTop={1}>
        <Text bold color="magenta"> Habitat Cairn Versions</Text>
        <Box gap={1}>
          <Text bold>{pad('Project', 30)}</Text>
          <Text bold>{pad('Installed', 12)}</Text>
          <Text bold>Drift</Text>
        </Box>
        <Text dimColor>{'─'.repeat(50)}</Text>
        {data.habitats.length === 0
          ? <Text dimColor>  No habitats discovered.</Text>
          : data.habitats.map((h) => {
              const drift = h.version && data.version.canonical && h.version !== data.version.canonical;
              return (
                <Box key={h.slug} gap={1}>
                  <Text>{pad(trunc(path.basename(h.path), 30), 30)}</Text>
                  <Text color={h.version ? 'green' : 'gray'}>{pad(h.version ?? '—', 12)}</Text>
                  <Text color={drift ? 'yellow' : 'green'}>{drift ? '⚠ DRIFT' : '✓'}</Text>
                </Box>
              );
            })
        }
      </Box>
    </Box>
  );
}

function IssuesPanel({
  issues, loading, error, lastFetch, showAll,
}: {
  issues: IssueInfo[];
  loading: boolean;
  error: string | null;
  lastFetch: Date | null;
  showAll: boolean;
}) {
  const fetchAge = lastFetch
    ? humanizeAge(Math.floor((Date.now() - lastFetch.getTime()) / 1000))
    : null;

  const labelsToString = (labels: string[]) =>
    labels.length === 0 ? '—' : labels.slice(0, 3).join(',') + (labels.length > 3 ? '…' : '');

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={2} marginBottom={1}>
        <Text color={showAll ? 'gray' : 'green'}>
          ● {showAll ? 'open + closed' : 'open only'}
        </Text>
        <Text dimColor>│</Text>
        <Text color="magenta">{issues.length}</Text>
        <Text dimColor> issues</Text>
        <Text dimColor>│</Text>
        {fetchAge ? <Text dimColor>↻ {fetchAge}</Text> : <Text dimColor>not fetched yet</Text>}
        {loading && <Text color="cyan"> <Spinner type="dots" /></Text>}
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan"> Filed Issues ({ISSUE_REPOS.join(' + ')})</Text>
        <Box gap={1}>
          <Text bold>{pad('Repo', 18)}</Text>
          <Text bold>{pad('#', 5)}</Text>
          <Text bold>{pad('State', 7)}</Text>
          <Text bold>{pad('Age', 10)}</Text>
          <Text bold>{pad('Labels', 22)}</Text>
          <Text bold>Title</Text>
        </Box>
        <Text dimColor>{'─'.repeat(74)}</Text>
        {error
          ? <Text color="red">  {error}</Text>
          : issues.length === 0
          ? <Text dimColor>  {lastFetch ? 'No issues match the current filter.' : "Press 'r' to fetch issues."}</Text>
          : issues.slice(0, 25).map((i) => (
              <Box key={`${i.repo}-${i.number}`} gap={1}>
                <Text color="magenta">{pad(trunc(i.repo, 18), 18)}</Text>
                <Text color="cyan">{pad(`#${i.number}`, 5)}</Text>
                <Text color={i.state === 'OPEN' ? 'green' : 'gray'}>{pad(i.state, 7)}</Text>
                <Text dimColor>{pad(i.ageHuman, 10)}</Text>
                <Text color="yellow">{pad(trunc(labelsToString(i.labels), 22), 22)}</Text>
                <Text>{trunc(i.title, 36)}</Text>
              </Box>
            ))
        }
        {issues.length > 25 && (
          <Text dimColor>  ... and {issues.length - 25} more</Text>
        )}
      </Box>
    </Box>
  );
}

function Footer({ msg }: { msg?: string }) {
  return (
    <Box paddingX={1} marginTop={0} flexDirection="column">
      <Text dimColor>{'━'.repeat(76)}</Text>
      {msg && <Text color="yellow">{msg}</Text>}
    </Box>
  );
}

function KeyHelp({ onIssuesTab }: { onIssuesTab: boolean }) {
  return (
    <Box paddingX={1} gap={2}>
      <Text dimColor><Text color="white" bold>q</Text>·quit</Text>
      <Text dimColor><Text color="white" bold>←→</Text>·tabs</Text>
      <Text dimColor><Text color="white" bold>1-6</Text>·jump</Text>
      <Text dimColor><Text color="white" bold>r</Text>·refresh</Text>
      {onIssuesTab && <Text dimColor><Text color="white" bold>o</Text>·open|all</Text>}
    </Box>
  );
}

// ─── Main App ───────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState(0);
  const { data, refresh } = useData();
  const issuesHook = useIssues();
  const { exit } = useApp();
  const [actionMsg, setActionMsg] = useState('');
  const issuesFetchedOnce = useRef(false);

  useEffect(() => {
    if (tab === 5 && !issuesFetchedOnce.current) {
      issuesHook.refetch();
      issuesFetchedOnce.current = true;
    }
  }, [tab, issuesHook]);

  useInput((input, key) => {
    if (input === 'q') exit();
    if (input === 'r') {
      refresh();
      if (tab === 5) issuesHook.refetch();
      setActionMsg('Refreshed');
      setTimeout(() => setActionMsg(''), 2000);
    }
    if (input === '1') setTab(0);
    if (input === '2') setTab(1);
    if (input === '3') setTab(2);
    if (input === '4') setTab(3);
    if (input === '5') setTab(4);
    if (input === '6') setTab(5);
    if (input === 'o' && tab === 5) {
      const next = !issuesHook.showAll;
      issuesHook.setShowAll(next);
      issuesHook.refetch(next ? 'all' : 'open');
    }
    if (key.leftArrow) setTab(t => Math.max(0, t - 1));
    if (key.rightArrow) setTab(t => Math.min(5, t + 1));
  }, { isActive: process.stdin.isTTY === true });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan">
      <Header data={data} />
      <TabBar active={tab} />
      <Box marginY={0}>
        <Text dimColor>{'─'.repeat(76)}</Text>
      </Box>
      {tab === 0 && <OverviewPanel data={data} />}
      {tab === 1 && <HabitatsPanel data={data} />}
      {tab === 2 && <MemoryPanel data={data} />}
      {tab === 3 && <ToolsPanel data={data} />}
      {tab === 4 && <VersionPanel data={data} />}
      {tab === 5 && (
        <IssuesPanel
          issues={issuesHook.issues}
          loading={issuesHook.loading}
          error={issuesHook.error}
          lastFetch={issuesHook.lastFetch}
          showAll={issuesHook.showAll}
        />
      )}
      <Footer msg={actionMsg} />
      <KeyHelp onIssuesTab={tab === 5} />
    </Box>
  );
}
