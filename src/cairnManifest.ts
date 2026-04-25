/**
 * In-memory cache for the cairn manifest fetched at runtime via HTTP.
 *
 * The manifest at https://raw.githubusercontent.com/winnorton/cairn/main/manifest.json
 * declares which files cairn installs (with `src`, `dest`, `tier`, `role`).
 * `habitat_status` uses it to enumerate files-present/missing and infer the tier.
 */

const MANIFEST_URL = 'https://raw.githubusercontent.com/winnorton/cairn/main/manifest.json';
const VERSION_URL = 'https://raw.githubusercontent.com/winnorton/cairn/main/VERSION';

export interface ManifestFile {
  src: string;
  dest: string;
  mode?: string;
  role?: string;
  tier?: string;
  description?: string;
}

export interface CairnManifest {
  name?: string;
  version?: string;
  files?: ManifestFile[];
  [key: string]: unknown;
}

let manifestCache: CairnManifest | null = null;
let versionCache: string | null = null;
let manifestFetchedAt = 0;

const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour — process lifetime in practice but bounded

export async function getCairnManifest(): Promise<CairnManifest | null> {
  if (manifestCache && Date.now() - manifestFetchedAt < CACHE_TTL_MS) {
    return manifestCache;
  }
  try {
    const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = (await res.json()) as CairnManifest;
    manifestCache = json;
    manifestFetchedAt = Date.now();
    return json;
  } catch {
    return null;
  }
}

export async function getCairnLatestVersion(): Promise<string | null> {
  if (versionCache && Date.now() - manifestFetchedAt < CACHE_TTL_MS) {
    return versionCache;
  }
  try {
    const res = await fetch(VERSION_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const txt = (await res.text()).trim();
    versionCache = txt;
    return txt;
  } catch {
    return null;
  }
}
