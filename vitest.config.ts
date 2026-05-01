import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // brief-417: also pick up co-located tests under src/**/__tests__/. The
    // legacy convention is the top-level tests/ folder; new modules can place
    // tests next to the code without a config change.
    include: ["tests/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
