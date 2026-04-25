// S56: env scrubbing + OAuth rejection detection for cc_dispatch
import { describe, it, expect } from "vitest";
import {
  buildDispatchEnv,
  detectOAuthRejection,
} from "../src/claude-code/client.js";

describe("buildDispatchEnv — env scrubbing", () => {
  it("sets CLAUDE_CODE_OAUTH_TOKEN to the provided token", () => {
    const env = buildDispatchEnv({ PATH: "/usr/bin" }, "tok-abc", "max");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-abc");
  });

  it("sets CLAUDE_CODE_EFFORT to the provided value", () => {
    const env = buildDispatchEnv({}, "tok", "high");
    expect(env.CLAUDE_CODE_EFFORT).toBe("high");
  });

  it("scrubs ANTHROPIC_API_KEY from the parent env", () => {
    const env = buildDispatchEnv(
      { ANTHROPIC_API_KEY: "sk-ant-api-leak", PATH: "/usr/bin" },
      "tok",
      "max",
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("scrubs ANTHROPIC_AUTH_TOKEN from the parent env", () => {
    const env = buildDispatchEnv(
      { ANTHROPIC_AUTH_TOKEN: "bearer-leak", HOME: "/home/x" },
      "tok",
      "max",
    );
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.HOME).toBe("/home/x");
  });

  it("preserves PATH/HOME/LANG and other non-auth vars", () => {
    const env = buildDispatchEnv(
      { PATH: "/usr/bin", HOME: "/home/x", LANG: "en_US.UTF-8" },
      "tok",
      "max",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("provided OAuth token overrides any pre-existing CLAUDE_CODE_OAUTH_TOKEN in parent env", () => {
    const env = buildDispatchEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: "stale-token" },
      "fresh-token",
      "max",
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-token");
  });

  it("skips parent env entries with undefined values", () => {
    const env = buildDispatchEnv(
      { PATH: "/usr/bin", MAYBE: undefined as unknown as string },
      "tok",
      "max",
    );
    expect(env.PATH).toBe("/usr/bin");
    expect("MAYBE" in env).toBe(false);
  });
});

describe("detectOAuthRejection — auth-failure pattern matching", () => {
  it("returns null for empty/undefined input", () => {
    expect(detectOAuthRejection(undefined)).toBeNull();
    expect(detectOAuthRejection("")).toBeNull();
  });

  it("returns null for unrelated error strings", () => {
    expect(detectOAuthRejection("ECONNREFUSED 127.0.0.1:443")).toBeNull();
    expect(detectOAuthRejection("rate_limit_exceeded")).toBeNull();
  });

  it("matches the Messages API OAuth rejection signature", () => {
    const result = detectOAuthRejection(
      "401 OAuth authentication is currently not supported",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(result).toContain("claude setup-token");
  });

  it("matches Invalid bearer token (capitalized)", () => {
    expect(detectOAuthRejection("Invalid bearer token")).not.toBeNull();
  });

  it("matches invalid bearer token (lowercased)", () => {
    expect(detectOAuthRejection("invalid bearer token")).not.toBeNull();
  });

  it("matches OAuth token expired", () => {
    expect(detectOAuthRejection("error: OAuth token expired")).not.toBeNull();
  });

  it("matches Please run /login", () => {
    expect(
      detectOAuthRejection("auth failed: Please run /login"),
    ).not.toBeNull();
  });

  it("includes the matched signature and original error in the surfaced message", () => {
    const original = "401 Invalid bearer token from upstream";
    const result = detectOAuthRejection(original) as string;
    expect(result).toContain("Invalid bearer token");
    expect(result).toContain(original);
  });
});
