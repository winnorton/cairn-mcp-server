# cairn-mcp-server

An MCP (Model Context Protocol) server that exposes utilities useful to agents working in [cairn](https://github.com/winnorton/cairn) habitats: deterministic project-slug resolution, wall-clock time, composite habitat status, version-consistency checks, cross-slug memory query, and a hosted-feedback wrapper. This server is a *companion* to the cairn markdown habitat — it doesn't replace anything in cairn, just makes some recurring agent probes faster than ad-hoc shell commands.

## Tools

| Tool | Family | One-line |
|---|---|---|
| `slug_for` | Slug ↔ path | Convert an absolute path to a cairn project slug + memory roots. |
| `paths_for` | Slug ↔ path | Best-effort reverse — slug to candidate filesystem paths. |
| `now` | Time | Wall-clock time as ISO + unix + human string. |
| `age_of` | Time | Age of a path's mtime as seconds + human string ("4h ago"). |
| `habitat_status` | Status | Composite probe: cairn version (installed vs latest), tier, file presence, HANDOFF.md, memory counts, git state. |
| `check_version_consistency` | Version | Scan VERSION, manifest.json, README.md, adopt.md, HANDOFF.md for matching versions. |
| `memory_query` | Memory | Search memory entries across one or more project slugs. |
| `feedback_post` | Feedback | POST to cairn's hosted feedback endpoint with three-level fallback. |

## Install

Clone and build:

```bash
git clone https://github.com/winnorton/cairn-mcp-server.git
cd cairn-mcp-server
npm install
npm run build
```

Then add it to your project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "cairn": {
      "command": "node",
      "args": ["C:/Users/winno/projects/cairn-mcp-server/dist/server.js"]
    }
  }
}
```

(Adjust the path to wherever you cloned this.)

## Tool reference

### `slug_for({ path })`

Convert an absolute filesystem path to the cairn project-slug used by `~/.claude/projects/<slug>/memory`. Replaces every `\`, `/`, and `:` with `-`. Returns the slug, the user-global memory root, the project-scoped memory root, and the project's `.claude` directory path.

### `paths_for({ slug })`

Best-effort reverse. Pattern `^([A-Z])--(.+)$` decodes a Windows-style slug back to `C:\path\with\backslashes`. Also produces a Unix-style candidate. Returned `candidates` are filtered to those that actually exist on disk, plus the raw decoded form for inspection.

### `now()`

`{ iso, unix_seconds, unix_ms, human }`. The human string is `YYYY-MM-DD HH:MM UTC`.

### `age_of({ path })`

`{ exists, mtime_iso, mtime_unix, age_seconds, age_human }`. `age_human` is `Ns`, `Nm`, `Nh`, `Nd`, or `Nw` ago. Returns `{ exists: false }` for missing paths.

### `habitat_status({ project_path? })`

The big composite probe. Defaults to `process.cwd()`. Returns:

- `cairn_version_installed` (from `<project>/.claude/cairn-version`) and `cairn_version_latest` (HTTP GET against the cairn repo's `VERSION` file), with `version_drift` boolean.
- `tier_inferred` — one of `seed | grow | structure | full | unknown`, based on which cairn-manifest files are present.
- `files_present` / `files_missing` — manifest file destinations resolved against the project path.
- `handoff_md` — path, exists, last_modified, age_human, plus any `## Related memory paths` block parsed out.
- `memory` — counts at both user-global and project-scoped roots, plus the most recent write.
- `git` — is_repo, last_commit, branch, dirty.

The cairn manifest is fetched once per process from `https://raw.githubusercontent.com/winnorton/cairn/main/manifest.json` and cached in memory.

### `check_version_consistency({ repo_path? })`

Scans well-known cairn-shape files for a version string and reports mismatches against the canonical `VERSION` file. Files checked: `VERSION`, `manifest.json` (`$.version`), `README.md` (`@v...` and `^v... —` patterns), `adopt.md` (`cairn v...`), `HANDOFF.md` (`Latest release: ... v...`). Files that don't exist are skipped silently.

### `memory_query({ slugs?, type?, since?, query? })`

Search memory entries across one or more project slugs. If `slugs` is omitted, scans every directory under `~/.claude/projects/*/memory/` plus `~/.claude/memory/` (user-global). If `type` is provided, restricts to `memory/<type>/`. If `since` is an ISO date, filters by mtime. If `query` is provided, does case-insensitive substring matching against file content and includes a snippet with the first matching line.

### `feedback_post({ category, severity, title, body, context?, cairn_version?, environment? })`

POSTs to the cairn hosted feedback endpoint with three-level fallback:

1. Try `https://cairn-feedback-591252228833.us-central1.run.app/feedback` (Cloud Run direct URL).
2. Try `https://cairn.winnorton.com/feedback` (custom domain).
3. Return `{ delivered: false, fallback_payload }` so the agent can fall back to `gh issue create` or paste manually.

## Build instructions

```bash
npm install
npm run build
```

The TypeScript build emits to `dist/server.js`. Run with `node dist/server.js` (stdio transport).

## Relationship to cairn

This server is **opt-in**. The cairn markdown habitat (the actual `.md` files installed by `adopt`) works with any markdown-reading agent. This MCP server just adds a few deterministic probes for MCP-aware agents that would otherwise get re-implemented as one-off shell commands every session. None of cairn's own scaffolding depends on this server existing.

The cairn project itself: https://github.com/winnorton/cairn

## License

MIT — see `LICENSE`.
