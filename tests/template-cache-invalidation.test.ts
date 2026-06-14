// SRV-86 — template-cache invalidation must fire on EVERY write path that lands
// the core template, not just prism_push. The shared helper is the single
// chokepoint push/patch/finalize all call.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, beforeEach } from "vitest";
import { templateCache, invalidateTemplateCacheOnWrite } from "../src/utils/cache.js";
import { FRAMEWORK_REPO, MCP_TEMPLATE_PATH } from "../src/config.js";

describe("invalidateTemplateCacheOnWrite (SRV-86)", () => {
  beforeEach(() => {
    templateCache.clear();
  });

  it("invalidates the cache when the framework core template is written", () => {
    templateCache.set(MCP_TEMPLATE_PATH, { content: "stale rules", size: 11 });
    expect(templateCache.get(MCP_TEMPLATE_PATH)).not.toBeNull();

    const invalidated = invalidateTemplateCacheOnWrite(FRAMEWORK_REPO, [MCP_TEMPLATE_PATH]);

    expect(invalidated).toBe(true);
    expect(templateCache.get(MCP_TEMPLATE_PATH)).toBeNull();
  });

  it("does NOT invalidate for a write on a non-framework repo", () => {
    templateCache.set(MCP_TEMPLATE_PATH, { content: "rules", size: 5 });
    const invalidated = invalidateTemplateCacheOnWrite("some-project", [MCP_TEMPLATE_PATH]);
    expect(invalidated).toBe(false);
    expect(templateCache.get(MCP_TEMPLATE_PATH)).not.toBeNull();
  });

  it("does NOT invalidate for a framework write that does not touch the template path", () => {
    templateCache.set(MCP_TEMPLATE_PATH, { content: "rules", size: 5 });
    const invalidated = invalidateTemplateCacheOnWrite(FRAMEWORK_REPO, [".prism/handoff.md", "README.md"]);
    expect(invalidated).toBe(false);
    expect(templateCache.get(MCP_TEMPLATE_PATH)).not.toBeNull();
  });
});
