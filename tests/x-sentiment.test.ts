process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, expect, it, vi } from "vitest";
import {
  analyzeXSentiment,
  extractXSearchSources,
  registerXSentiment,
} from "../src/tools/x-sentiment.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("prism_x_sentiment", () => {
  it("calls xAI Responses with x_search only and returns annotation-backed aggregate sentiment", async () => {
    let requestBody: any;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return response({
        status: "completed",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  sentiment: "mixed",
                  confidence: "medium",
                  summary: "Discussion is split between excitement and reliability concerns.",
                  caveats: ["source-limited"],
                }),
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://x.com/example/status/1234567890123456789",
                    title: "1",
                  },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 101, output_tokens: 42 },
      });
    });

    const result = await analyzeXSentiment({
      topic: "PRISM MCP routing",
      fromDate: "2026-06-20",
      toDate: "2026-06-26",
      env: liveEnv(),
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.x.ai/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-xai-key",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(requestBody).toMatchObject({
      model: "grok-4.3",
      store: false,
      tools: [{ type: "x_search", from_date: "2026-06-20", to_date: "2026-06-26" }],
    });
    expect(JSON.stringify(requestBody)).not.toContain("web_search");
    expect(JSON.stringify(requestBody)).not.toContain("enable_image_understanding");
    expect(JSON.stringify(requestBody)).not.toContain("enable_video_understanding");
    if (result.status !== "ok") throw new Error("expected ok result");
    expect(result.sentiment).toBe("mixed");
    expect(result.sources).toEqual([
      {
        url: "https://x.com/i/status/1234567890123456789",
        source_type: "x_status",
      },
    ]);
    expect(result.usage).toEqual({ input_tokens: 101, output_tokens: 42 });
    expect(JSON.stringify(result)).not.toMatch(/raw_x_post_text|@example|test-xai-key/);
  });

  it("does not forward provider-generated raw X text, handles, or URLs in summaries", async () => {
    const fetchImpl = vi.fn(async () => response({
      output: [
        {
          content: [
            {
              text: JSON.stringify({
                sentiment: "positive",
                confidence: "high",
                summary: "\"this raw quoted post should not pass\" from @live_handle https://x.com/live_handle/status/1234567890123456789",
                caveats: ["sample-limited"],
              }),
              annotations: [
                {
                  type: "url_citation",
                  url: "https://x.com/example/status/1234567890123456789",
                },
              ],
            },
          ],
        },
      ],
    }));

    const result = await analyzeXSentiment({
      topic: "PRISM MCP routing",
      env: liveEnv(),
      fetchImpl,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok result");
    expect(result.summary).toContain("Aggregate public X sentiment is positive");
    expect(result.summary).not.toMatch(/raw quoted post|@live_handle|https:\/\/x\.com/);
  });

  it("does not return raw provider exception messages or API keys", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("request failed with secret test-xai-key and Authorization: Bearer test-xai-key");
    });

    const result = await analyzeXSentiment({
      topic: "PRISM MCP routing",
      env: liveEnv(),
      fetchImpl,
    });

    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("test-xai-key");
    expect(JSON.stringify(result)).not.toContain("Authorization");
    expect(result.error).toBe("xAI provider request failed");
  });

  it("uses only annotation status URLs as audit-grade sources", () => {
    const extraction = extractXSearchSources({
      citations: ["https://x.com/top_level/status/999999999999999999"],
      output: [
        {
          content: [
            {
              annotations: [
                { type: "url_citation", url: "https://x.com/good/status/1234567890123456789" },
                { type: "url_citation", url: "https://twitter.com/good/status/2234567890123456789?ref=bad" },
                { type: "url_citation", url: "https://example.com/not-x" },
                { type: "url_citation", url: "not-a-url" },
              ],
            },
          ],
        },
      ],
    });

    expect(extraction.sources).toEqual([
      {
        url: "https://x.com/i/status/1234567890123456789",
        source_type: "x_status",
      },
    ]);
    expect(extraction.warnings).toEqual(
      expect.arrayContaining([
        "top-level-citations-ignored",
        "query-or-fragment-not-allowed",
        "unsupported-host",
        "invalid-url",
      ]),
    );
  });

  it("does not live-call xAI when only XAI_API_KEY is configured", async () => {
    const fetchImpl = vi.fn(async () => response({}));

    const result = await analyzeXSentiment({
      topic: "PRISM MCP routing",
      env: { XAI_API_KEY: "test-xai-key" },
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "unavailable",
      provider: "xai",
      warning: "live-invocation-disabled",
      error: "LLM_ROUTING_X_SENTIMENT_ENABLED is not true",
    });
    expect(JSON.stringify(result)).not.toContain("test-xai-key");
  });

  it("registered tool fails closed when XAI_API_KEY is absent", async () => {
    let handler: ((args: Record<string, unknown>) => Promise<any>) | undefined;
    const server = {
      tool(_name: string, _description: string, _schema: unknown, h: typeof handler) {
        handler = h;
      },
    };

    registerXSentiment(server as never, { env: {} });
    if (!handler) throw new Error("prism_x_sentiment handler was not registered");
    const result = await handler({ topic: "PRISM MCP routing" });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({
      status: "unavailable",
      provider: "xai",
      warning: "live-invocation-disabled",
    });
    expect(JSON.stringify(payload)).not.toContain("XAI_API_KEY=");
  });
});

function liveEnv(): Record<string, string> {
  return {
    XAI_API_KEY: "test-xai-key",
    LLM_ROUTING_X_SENTIMENT_ENABLED: "true",
    LLM_ROUTING_ENABLED: "true",
    LLM_ROUTING_DRY_RUN: "false",
    LLM_ROUTING_ALLOWED_PROVIDERS: "anthropic,xai",
  };
}
