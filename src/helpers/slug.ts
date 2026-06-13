/**
 * Canonical project-slug helper — shared by all three session adapters.
 *
 * The slug is derived from the session's `cwd` using the SAME character
 * replacement logic as `pathToSlug` in `src/helpers.ts` (which powers the
 * `slug_for` MCP tool). Keeping these identical is critical for cross-harness
 * session correlation: the same project directory must yield the same slug
 * regardless of which harness recorded the session.
 *
 * Convention (from pathToSlug / slug_for):
 *   Replace every `\`, `/`, and `:` with `-`.
 *   Example: `C:\Users\winno\projects\foo` → `C--Users-winno-projects-foo`
 *
 * Additional handling this function adds:
 *   - Strip a leading `file://` prefix (Antigravity stores cwd as a file URL).
 *   - Percent-decode the result after stripping the prefix.
 *   - Return `'unknown'` for null / empty inputs.
 */

/**
 * Convert a session cwd (plain path or `file://` URL) into a canonical cairn
 * project slug.
 *
 * @param cwd  The raw cwd value from the session file, or null.
 * @returns    A slug string — never empty, never null.
 */
export function cwdToSlug(cwd: string | null | undefined): string {
  if (!cwd) return 'unknown';

  let p = cwd.trim();
  if (!p) return 'unknown';

  // Strip file:// or file:/// prefix (Antigravity stores cwd as a file URL).
  // Real observed format: file:///c%3A/Users/... (colon percent-encoded)
  // Also seen:           file:///C:/Users/...   (colon literal, drive uppercase)
  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    // Percent-decode NOW (before checking for the drive-letter slash) so that
    // file:///c%3A/Users/... decodes to /c:/Users/... which the regex below matches.
    try { p = decodeURIComponent(p); } catch { /* keep raw on error */ }
    // Strip the leading slash that appears before a Windows drive letter.
    // After decode: /c:/Users/... → c:/Users/...
    // After decode: /C:/Users/... → C:/Users/...
    if (/^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1);
    }
    // Normalize Windows drive letter to uppercase so that file:///c%3A/... (which
    // decodes to c:/...) and C:\... both yield the same slug (N5 cross-harness fix).
    p = p.replace(/^([a-z]):/, (_, d) => `${(d as string).toUpperCase()}:`);
  }

  if (!p) return 'unknown';

  // Apply the canonical replacement: \, /, : → -
  // This matches pathToSlug() in src/helpers.ts exactly.
  const slug = p.replace(/[\\/:]/g, '-');

  // Trim leading/trailing dashes that can arise from leading slashes on Unix paths
  const trimmed = slug.replace(/^-+|-+$/g, '');

  return trimmed || 'unknown';
}
