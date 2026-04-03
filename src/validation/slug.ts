/**
 * Input sanitization for project slugs and file paths (B.11).
 */

const VALID_SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_SLUG_LENGTH = 100;

export function validateProjectSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || slug.length === 0) {
    return { valid: false, error: "Project slug cannot be empty" };
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    return { valid: false, error: `Project slug exceeds ${MAX_SLUG_LENGTH} characters` };
  }
  if (!VALID_SLUG_PATTERN.test(slug)) {
    return { valid: false, error: "Project slug must match ^[a-zA-Z0-9][a-zA-Z0-9_-]*$" };
  }
  return { valid: true };
}

export function validateFilePath(path: string): { valid: boolean; error?: string } {
  if (!path || path.length === 0) {
    return { valid: false, error: "File path cannot be empty" };
  }
  if (path.includes("..")) {
    return { valid: false, error: "File path cannot contain '..'" };
  }
  if (path.startsWith("/")) {
    return { valid: false, error: "File path must be relative (no leading /)" };
  }
  return { valid: true };
}
