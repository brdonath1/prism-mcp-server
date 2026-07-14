/**
 * prism_patch — Section-level file operations without full-file roundtrips.
 * Supports append, prepend, and replace on markdown sections.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../utils/logger.js";
import { applyPatch, validateIntegrity, type IntegrityIssue } from "../utils/markdown-sections.js";
import { resolveDocPath } from "../utils/doc-resolver.js";
import { DOC_ROOT, PATCH_WALL_CLOCK_DEADLINE_MS } from "../config.js";
import { DiagnosticsCollector } from "../utils/diagnostics.js";
import { safeMutation } from "../utils/safe-mutation.js";
import { invalidateTemplateCacheOnWrite } from "../utils/cache.js";
import {
  sanitizeContent,
  detectZwsHeaders,
  type NeutralizedLine,
} from "../utils/sanitize-content.js";
import { ingestRulesHint } from "../utils/rules-hint.js";

interface PatchOpResult {
  operation: string;
  section: string;
  success: boolean;
  error?: string;
}

/**
 * Internal sentinel thrown from inside `computeMutation` when one or more
 * patch operations fail to apply. Caught at the tool boundary to surface
 * the existing PATCH_PARTIAL_FAILURE response shape unchanged.
 */
class PatchPartialFailureError extends Error {
  readonly partial = true as const;
  constructor(
    readonly results: PatchOpResult[],
    message: string,
  ) {
    super(message);
    this.name = "PatchPartialFailureError";
  }
}

/**
 * Internal sentinel thrown when post-patch integrity validation fails.
 * Caught at the tool boundary to surface the existing integrity-error
 * response shape unchanged.
 */
class PatchIntegrityError extends Error {
  readonly integrity = true as const;
  constructor(
    readonly issues: IntegrityIssue[],
    readonly attempted: PatchOpResult[],
    message: string,
  ) {
    super(message);
    this.name = "PatchIntegrityError";
  }
}

export function registerPatch(server: McpServer): void {
  server.tool(
    "prism_patch",
    "Section-level operations (append/prepend/replace) on living documents. All-or-nothing semantics.",
    {
      project_slug: z.string().describe("Project repo name"),
      file: z.string().describe("File path relative to repo root (e.g., 'task-queue.md')"),
      patches: z.array(z.object({
        operation: z.enum(["append", "prepend", "replace"]).describe("Operation type"),
        section: z.string().describe("Section header to target (e.g., '## In Progress', '### Session 22')"),
        content: z.string().describe("Content to append/prepend/replace with"),
      })).describe("One or more patch operations to apply sequentially"),
    },
    async ({ project_slug, file, patches }) => {
      const start = Date.now();
      const diagnostics = new DiagnosticsCollector();
      logger.info("prism_patch", { project_slug, file, patchCount: patches.length });

      try {
        // 1. Resolve file path to prevent root-level duplication (D-67 addendum).
        //    "Not found" at both .prism/ and root is the legitimate fallback
        //    case (arbitrary repo files, brand-new docs) — fall back silently.
        //    Operational errors (5xx, rate limit, timeout, network, auth) are
        //    distinct: the resolver couldn't tell us which path is correct, so
        //    surface PATCH_RESOLVE_FAILED. We still fall back to the requested
        //    path (Option A) — the patch may succeed against it, and even if
        //    fetchFile inside safeMutation 404s, the operator now has a
        //    diagnostic explaining why path resolution was inconclusive
        //    (S63 Phase 1 Brief 3).
        const baseName = file.startsWith(`${DOC_ROOT}/`) ? file.slice(DOC_ROOT.length + 1) : file;
        let resolvedPath: string;
        try {
          const resolved = await resolveDocPath(project_slug, baseName);
          resolvedPath = resolved.path;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // resolveDocPath rethrows the inner fetchFile error on "neither path
          // exists"; that error has the form "Not found: fetchFile <repo>/<path>"
          // (handleApiError, src/github/client.ts). Mirror fetch.ts's
          // substring-match pattern. Anything else is operational.
          const isNotFound = message.includes("Not found");
          if (!isNotFound) {
            diagnostics.warn(
              "PATCH_RESOLVE_FAILED",
              `Path resolution failed (operational): ${message}`,
              { original: file, error: message },
            );
          }
          resolvedPath = file;
        }

        if (resolvedPath !== file) {
          diagnostics.warn("PATCH_REDIRECTED", `Path redirected: "${file}" → "${resolvedPath}"`, { original: file, resolved: resolvedPath });
        }

        // brief-s202b T2: stateless module nudge for `.prism/ingest/` writes
        // (checked against both the requested and resolved path). Emitted on
        // every matching call; harmless if the module is already loaded.
        const rulesHint = ingestRulesHint([file, resolvedPath]);

        // brief-460 / SRV-78: incoming patch content that ALREADY carries the
        // ZWS-neutralized-header signature was corrupted upstream (usually
        // copied out of a document the pre-redesign sanitizer damaged).
        // Surface it — writing it back would silently re-commit the damage.
        for (const patch of patches) {
          const contaminated = detectZwsHeaders(patch.content);
          if (contaminated.length > 0) {
            diagnostics.warn(
              "ZWS_CONTAMINATION_DETECTED",
              `Patch content for "${patch.section}" contains ${contaminated.length} ZWS-neutralized header(s) — corruption from a pre-brief-460 sanitizer write (repair: M-041); this patch writes the bytes as supplied. First: "${contaminated[0].header}" (line ${contaminated[0].line}).`,
              {
                section: patch.section,
                lines: contaminated.map((c) => ({ line: c.line, header: c.header })),
              },
            );
          }
        }

        // 2. safeMutation handles fetch + atomic commit + 409 retry. The patch
        //    operations move INSIDE computeMutation so on retry they re-run
        //    against the latest content (closes the stale-content-on-retry
        //    vulnerability identified in the audit).
        let lastIntegrityIssues: IntegrityIssue[] = [];
        const sanitizedLines = new Map<string, NeutralizedLine[]>();

        const safeMutationResult = await safeMutation({
          repo: project_slug,
          commitMessage: `prism: patch ${resolvedPath} (${patches.length} ops)`,
          readPaths: [resolvedPath],
          diagnostics,
          deadlineMs: PATCH_WALL_CLOCK_DEADLINE_MS,
          computeMutation: (files) => {
            const fileResult = files.get(resolvedPath);
            if (!fileResult) {
              throw new Error(`safeMutation did not return ${resolvedPath} content`);
            }
            let content = fileResult.content;

            const results: PatchOpResult[] = [];
            for (const [patchIdx, patch] of patches.entries()) {
              try {
                // KI-26 (redesigned brief-460 / SRV-03): neutralize embedded
                // headers that could escape the target section's boundary.
                // parseSections bounds a section at the next same-or-higher
                // header, so only levels <= the target's level are hazards —
                // `## Injected` against a `##` section is still neutralized,
                // while the `###`+ subsections the replace contract requires
                // callers to resend survive byte-identical. Fenced content is
                // never touched (SRV-29). Mutations are reported via the
                // PATCH_CONTENT_SANITIZED diagnostic below (SRV-53).
                const levelMatch = patch.section.trim().match(/^(#{1,6})\s/);
                const targetLevel = levelMatch ? levelMatch[1].length : 6;
                const sanitized = sanitizeContent(patch.content, { targetLevel });
                if (sanitized.neutralized.length > 0) {
                  sanitizedLines.set(`${patchIdx}:${patch.section}`, sanitized.neutralized);
                }
                content = applyPatch(content, patch.section, patch.operation, sanitized.text);
                results.push({ operation: patch.operation, section: patch.section, success: true });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                results.push({ operation: patch.operation, section: patch.section, success: false, error: msg });
              }
            }

            if (results.some(r => !r.success)) {
              throw new PatchPartialFailureError(results, "One or more patches failed — file not modified");
            }

            const integrity = validateIntegrity(content);
            if (!integrity.valid) {
              throw new PatchIntegrityError(
                integrity.issues,
                results,
                "Post-patch integrity check failed — file not modified",
              );
            }
            lastIntegrityIssues = integrity.issues;

            return {
              writes: [{ path: resolvedPath, content }],
            };
          },
        });

        if (!safeMutationResult.ok) {
          logger.error("prism_patch safeMutation failed", {
            project_slug,
            file: resolvedPath,
            code: safeMutationResult.code,
            error: safeMutationResult.error,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  file: resolvedPath,
                  original_path: resolvedPath !== file ? file : undefined,
                  redirected: resolvedPath !== file,
                  success: false,
                  error: safeMutationResult.error,
                  code: safeMutationResult.code,
                  ...(rulesHint ? { rules_hint: rulesHint } : {}), // brief-s202b T2
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }

        // brief-460 / SRV-53: sanitization is no longer silent. Name every
        // neutralized line so the caller can re-issue the patch correctly
        // (e.g. against a deeper target section) instead of discovering the
        // damage sessions later.
        for (const [key, neutralized] of sanitizedLines) {
          const section = key.slice(key.indexOf(":") + 1);
          diagnostics.warn(
            "PATCH_CONTENT_SANITIZED",
            `${neutralized.length} header line(s) in content for "${section}" were ZWS-neutralized (level <= target section level — they would have escaped the section boundary): ${neutralized.map((n) => `"${n.header}"`).join(", ")}`,
            {
              section,
              lines: neutralized.map((n) => ({ line: n.line, header: n.header })),
            },
          );
        }

        const patches_applied: PatchOpResult[] = patches.map(p => ({
          operation: p.operation,
          section: p.section,
          success: true,
        }));

        // SRV-86: a prism_patch on the framework core template must invalidate
        // the behavioral-rules cache too — pre-brief-465 only prism_push did, so
        // a patch-driven template edit served stale rules up to the TTL.
        invalidateTemplateCacheOnWrite(project_slug, [resolvedPath]);

        logger.info("prism_patch complete", {
          project_slug,
          file: resolvedPath,
          patchCount: patches.length,
          redirected: resolvedPath !== file,
          retried: safeMutationResult.retried,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              file: resolvedPath,
              original_path: resolvedPath !== file ? file : undefined,
              redirected: resolvedPath !== file,
              success: true,
              patches_applied,
              integrity_check: lastIntegrityIssues.length > 0
                ? { warnings: lastIntegrityIssues }
                : { clean: true },
              ...(rulesHint ? { rules_hint: rulesHint } : {}), // brief-s202b T2
              diagnostics: diagnostics.list(),
            }),
          }],
        };
      } catch (error) {
        if (error instanceof PatchPartialFailureError) {
          const failedPatches = error.results.filter(r => !r.success);
          diagnostics.error(
            "PATCH_PARTIAL_FAILURE",
            `${failedPatches.length} patch(es) failed`,
            { failedPatches: failedPatches.map(p => ({ section: p.section, error: p.error })) },
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: error.message,
                  results: error.results,
                  diagnostics: diagnostics.list(),
                }),
              },
            ],
            isError: true,
          };
        }
        if (error instanceof PatchIntegrityError) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: error.message,
                  issues: error.issues,
                  patches_attempted: error.attempted,
                }),
              },
            ],
            isError: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_patch failed", { project_slug, file, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
