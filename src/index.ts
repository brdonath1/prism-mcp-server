/**
 * PRISM MCP Server — Express app + MCP Streamable HTTP transport (stateless mode).
 *
 * Every request creates a new McpServer + StreamableHTTPServerTransport instance.
 * All state lives in GitHub — this server is a stateless proxy.
 */

import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CC_DISPATCH_ENABLED,
  GITHUB_PAT,
  PORT,
  RAILWAY_ENABLED,
  SERVER_VERSION,
} from "./config.js";
import { logger } from "./utils/logger.js";
import { requestLogger } from "./middleware/request-logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { registerBootstrap } from "./tools/bootstrap.js";
import { registerFetch } from "./tools/fetch.js";
import { registerPush } from "./tools/push.js";
import { registerStatus } from "./tools/status.js";
import { registerFinalize } from "./tools/finalize.js";
import { registerAnalytics } from "./tools/analytics.js";
import { registerScaleHandoff } from "./tools/scale.js";
import { registerSearch } from "./tools/search.js";
import { registerSynthesize } from "./tools/synthesize.js";
import { registerLogDecision } from "./tools/log-decision.js";
import { registerLogInsight } from "./tools/log-insight.js";
import { registerPatch } from "./tools/patch.js";
import { registerLoadRules } from "./tools/load-rules.js";
import { registerRailwayLogs } from "./tools/railway-logs.js";
import { registerRailwayDeploy } from "./tools/railway-deploy.js";
import { registerRailwayEnv } from "./tools/railway-env.js";
import { registerRailwayStatus } from "./tools/railway-status.js";
import { registerCCDispatch } from "./tools/cc-dispatch.js";
import { registerCCStatus } from "./tools/cc-status.js";
import { registerGhDeleteBranch } from "./tools/gh-delete-branch.js";
import { registerGhCreateRelease } from "./tools/gh-create-release.js";
import { registerGhUpdateRelease } from "./tools/gh-update-release.js";
import { registerGhDeleteTag } from "./tools/gh-delete-tag.js";
import { hydrateStore } from "./dispatch-store.js";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(requestLogger);
app.use(authMiddleware);

/**
 * Create a fresh McpServer instance with all tools registered.
 */
function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "prism-mcp-server",
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register all tools
  registerBootstrap(server);
  registerFetch(server);
  registerPush(server);
  registerStatus(server);
  registerFinalize(server);
  registerAnalytics(server);
  registerScaleHandoff(server);
  registerSearch(server);
  registerSynthesize(server);
  registerLogDecision(server);
  registerLogInsight(server);
  registerPatch(server);
  registerLoadRules(server);

  // Railway operations gateway (brief-103). Tools only register when the
  // RAILWAY_API_TOKEN environment variable is set, so existing deployments
  // without the token are unaffected.
  if (RAILWAY_ENABLED) {
    registerRailwayLogs(server);
    registerRailwayDeploy(server);
    registerRailwayEnv(server);
    registerRailwayStatus(server);
  }

  // Claude Code orchestration (brief-104). Tools only register when an
  // ANTHROPIC_API_KEY is available to pay for the Agent SDK subprocess.
  if (CC_DISPATCH_ENABLED) {
    registerCCDispatch(server);
    registerCCStatus(server);
  }

  // GitHub utility tools (brief-403) — wraps stable REST endpoints not
  // exposed by github/github-mcp-server (branch deletion + release CRUD).
  // Gated on GITHUB_PAT for symmetry with the other optional categories,
  // even though the server fatals on boot without it (see config.ts).
  if (GITHUB_PAT) {
    registerGhDeleteBranch(server);
    registerGhCreateRelease(server);
    registerGhUpdateRelease(server);
    registerGhDeleteTag(server);
  }

  return server;
}

/**
 * POST /mcp — Handle MCP requests (stateless mode).
 * Creates a new server + transport per request.
 */
app.post("/mcp", async (req: Request, res: Response) => {
  const start = Date.now();

  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    res.on("close", () => {
      logger.debug("mcp request closed", { ms: Date.now() - start });
      transport.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("POST /mcp error", { error: message });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

/**
 * GET /mcp — SSE endpoint for server-to-client notifications.
 * In stateless mode, we don't support SSE streams — return 405.
 */
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "SSE not supported in stateless mode. Use POST /mcp for all requests.",
    },
  });
});

/**
 * DELETE /mcp — Session termination.
 * In stateless mode, there's nothing to terminate — return 405.
 */
app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Session termination not applicable in stateless mode.",
    },
  });
});

/**
 * GET /health — Health check endpoint.
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", version: SERVER_VERSION });
});

/**
 * Start the server.
 */
app.listen(PORT, () => {
  logger.info("PRISM MCP Server started", {
    port: PORT,
    version: SERVER_VERSION,
    mode: "stateless",
    transport: "streamable-http",
    railway_enabled: RAILWAY_ENABLED,
    cc_dispatch_enabled: CC_DISPATCH_ENABLED,
    github_enabled: !!GITHUB_PAT,
  });

  // Hydrate dispatch store from GitHub (non-blocking).
  // Loads recent dispatch records into memory so cc_status works across
  // server restarts. Does NOT block request handling — the server accepts
  // requests immediately while hydration runs in the background.
  if (CC_DISPATCH_ENABLED) {
    void hydrateStore().catch((err) => {
      // Non-fatal — server operates in memory-only mode if hydration fails.
      // New dispatches still work; only pre-restart records are inaccessible.
      console.error("dispatch-store hydration failed:", err);
    });
  }
});
