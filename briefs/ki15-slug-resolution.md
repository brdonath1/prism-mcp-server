# CC Brief: Server-Side Slug Resolution (KI-15)

> **Priority:** High — causes session boot failures when Claude memory loses project slugs
> **Scope:** `src/tools/bootstrap.ts`, `src/config.ts`
> **Branch:** `main` (direct push)
> **Estimated complexity:** Low-Medium — 20-30 minutes

---

## Mission

Make `prism_bootstrap` resilient to slug resolution failures by accepting either a project slug OR a display name and resolving it server-side. Currently, Claude must resolve the slug before calling bootstrap. When Claude's native memory loses the slug, sessions fail and trigger onboarding for projects with 70+ sessions.

The server already has `PROJECT_DISPLAY_NAMES` in `src/config.ts` — a map from slug to display name. This brief adds the reverse lookup: display name to slug.

Do NOT ask questions. This is a targeted fix.

---

## Task Checklist

### Task 1: Add reverse display name lookup to `src/config.ts`

Add a reverse map derived from the existing `PROJECT_DISPLAY_NAMES`:

```typescript
// Reverse map: display name (lowercase) → slug
export const DISPLAY_NAME_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(PROJECT_DISPLAY_NAMES).map(([slug, name]) => [name.toLowerCase(), slug])
);
```

Also add a resolver function:

```typescript
/**
 * Resolve a project identifier to a slug.
 * Accepts: exact slug, display name (case-insensitive), or Claude project name.
 * Returns the slug if found, or the original input if no match (let it fail downstream with a clear error).
 */
export function resolveProjectSlug(input: string): string {
  // 1. Direct slug match — check if a repo with this name exists in our project list
  const lowerInput = input.toLowerCase().trim();
  const slugs = Object.keys(PROJECT_DISPLAY_NAMES);
  if (slugs.includes(lowerInput)) return lowerInput;
  
  // 2. Display name match (case-insensitive)
  if (DISPLAY_NAME_TO_SLUG[lowerInput]) return DISPLAY_NAME_TO_SLUG[lowerInput];
  
  // 3. Partial/fuzzy match — handle cases like "PlatformForge-v2" matching slug "platformforge-v2"
  //    Strip spaces, hyphens, underscores for comparison
  const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');
  const normalizedInput = normalize(input);
  for (const slug of slugs) {
    if (normalize(slug) === normalizedInput) return slug;
    const displayName = PROJECT_DISPLAY_NAMES[slug];
    if (displayName && normalize(displayName) === normalizedInput) return slug;
  }
  
  // 4. No match — return original input, bootstrap will fail with a clear "repo not found" error
  return input;
}
```

### Task 2: Update `src/tools/bootstrap.ts`

Update the bootstrap handler to resolve the slug before using it:

```typescript
import { resolveProjectSlug } from "../config.js";

// At the start of the handler, before any GitHub operations:
const resolvedSlug = resolveProjectSlug(project_slug);
// Use resolvedSlug instead of project_slug for all subsequent operations
```

Also update the Zod input schema description to indicate it accepts display names:

```typescript
project_slug: z.string().describe("Project repo name or display name (e.g., 'platformforge-v2', 'PlatformForge v2', 'prism')")
```

### Task 3: Build, test, push

```bash
npm run build
npm test
git add -A && git commit -m "prism: KI-15 server-side slug resolution — bootstrap accepts display names" && git push origin main
```

---

## Completion Criteria

1. `resolveProjectSlug("platformforge-v2")` returns `"platformforge-v2"` (exact slug)
2. `resolveProjectSlug("PlatformForge v2")` returns `"platformforge-v2"` (display name)
3. `resolveProjectSlug("PlatformForge-v2")` returns `"platformforge-v2"` (Claude project name with hyphen)
4. `resolveProjectSlug("PRISM Framework")` returns `"prism"` (display name)
5. `resolveProjectSlug("nonexistent")` returns `"nonexistent"` (passthrough for clear error)
6. All existing tests still pass
7. Pushed to `main`, Railway auto-deploy triggered

---

## What NOT to Do

- Do NOT change the `prism_bootstrap` parameter name — it stays as `project_slug`
- Do NOT add new MCP tools — this is purely internal resolution
- Do NOT change the response format — only the input handling changes
- Do NOT modify any other tools

<!-- EOF: slug-resolution-brief.md -->
