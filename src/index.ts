/**
 * PRISM MCP Server — Express app + MCP Streamable HTTP transport (stateless mode).
 *
 * Every request creates a new McpServer + StreamableHTTPServerTransport instance.
 * All state lives in GitHub — this server is a stateless proxy.
 */

import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PORT, SERVER_VERSION } from "./config.js";
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

const app = express();
app.set("trust proxy", 1); // Railway runs behind 1 reverse proxy
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
  });
});
