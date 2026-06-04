/**
 * Input sanitization for project slugs and file paths (B.11).
 *
 * brief-444 R5-c: these guards are now WIRED into the GitHub client's
 * URL-construction choke points (src/github/client.ts) — every repo slug
 * and contents path passes through them before any request is built.
 */

/**
 * Repo-slug charset. Dots are permitted in non-leading positions
 * (brief-444 review): GitHub repo names legally contain `.` (e.g.
 * `brian.github.io`, `prism-2.0`) and the wired guard must not reject the
 * platform's own valid names. The leading character stays alphanumeric —
 * that single restriction is what keeps `..`, `.git`-style relatives, and
 * option-injection (`-x`) out of request URLs; `/` and whitespace remain
 * excluded entirely so a slug can never span URL path segments.
 */
const VALID_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_SLUG_LENGTH = 100;

export function validateProjectSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || slug.length === 0) {
    return { valid: false, error: "Project slug cannot be empty" };
  }
  if (slug.includes("\x00")) {
    return { valid: false, error: "Project slug contains null byte" };
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    return { valid: false, error: `Project slug exceeds ${MAX_SLUG_LENGTH} characters` };
  }
  if (!VALID_SLUG_PATTERN.test(slug)) {
    return { valid: false, error: "Project slug must match ^[a-zA-Z0-9][a-zA-Z0-9._-]*$" };
  }
  return { valid: true };
}

export function validateFilePath(path: string): { valid: boolean; error?: string } {
  if (!path || path.length === 0) {
    return { valid: false, error: "File path cannot be empty" };
  }

  // Null byte check — prevents null byte injection attacks
  if (path.includes("\x00")) {
    return { valid: false, error: "File path contains null byte" };
  }

  // Decode URL-encoded input before validation to catch encoded traversal
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return { valid: false, error: "File path contains invalid URL encoding" };
  }

  // Check for null bytes in decoded form
  if (decoded.includes("\x00")) {
    return { valid: false, error: "File path contains null byte" };
  }

  // Check both raw and decoded forms for traversal sequences
  if (path.includes("..") || decoded.includes("..")) {
    return { valid: false, error: "File path cannot contain '..'" };
  }
  if (path.startsWith("/") || decoded.startsWith("/")) {
    return { valid: false, error: "File path must be relative (no leading /)" };
  }

  // Reject if decoded form differs from raw and contains path separators (nested encoding attack)
  if (decoded !== path && (decoded.includes("/") || decoded.includes("\\"))) {
    return { valid: false, error: "File path contains suspicious URL encoding" };
  }

  return { valid: true };
}
