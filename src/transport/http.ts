import { createServer as createNodeHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "../server.js";
import {
  initKnowledge,
  isKnowledgeEnabled,
  searchKnowledge,
  browseChunks,
  knowledgeStats,
} from "../knowledge/index.js";
import { KNOWLEDGE_UI_HTML } from "../knowledge/ui.js";
import { formatLocallyError } from "../llm/errors.js";
import type { LocallyConfig } from "../config.js";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on("error", reject);
  });
}

export async function startHttp(config: LocallyConfig): Promise<void> {
  const port = config.transport?.port ?? parseInt(process.env.LOCALLY_PORT ?? "3000", 10);
  const host = config.transport?.host ?? process.env.LOCALLY_HOST ?? "127.0.0.1";
  let knowledgeEnabled = isKnowledgeEnabled(config);

  const httpServer = createNodeHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "locally" }));
        return;
      }

      if (req.url === "/mcp") {
        const mcpServer = createMcpServer(config);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await mcpServer.connect(transport);
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err instanceof Error && err.message === "Request body too large") {
            res.writeHead(413, { "Content-Type": "text/plain" });
            res.end("Payload too large");
            return;
          }
          throw err;
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      if (knowledgeEnabled && req.method === "GET" && req.url?.startsWith("/knowledge")) {
        await handleKnowledgeRoute(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, resolve);
    httpServer.on("error", reject);
  });

  process.stderr.write(
    `locally MCP server started (http) at http://${host}:${port}/mcp\n`
  );

  if (knowledgeEnabled) {
    try {
      const status = await initKnowledge(config);
      process.stderr.write(
        `locally: ${status}\n` +
          `locally: knowledge UI at http://${host}:${port}/knowledge\n`
      );
    } catch (err) {
      // A misconfigured knowledge base shouldn't take down the MCP server.
      process.stderr.write(`locally: knowledge base disabled — ${formatLocallyError(err)}\n`);
      knowledgeEnabled = false;
    }
  }
}

const json = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
};

/** Read-only browse/search endpoints + UI for the knowledge base. No auth (per design). */
async function handleKnowledgeRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/knowledge" || path === "/knowledge/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(KNOWLEDGE_UI_HTML);
      return;
    }

    if (path === "/knowledge/stats") {
      json(res, 200, knowledgeStats() ?? { files: 0, chunks: 0, dimensions: null, lastIndexed: null });
      return;
    }

    if (path === "/knowledge/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) {
        json(res, 400, { error: "missing query parameter 'q'" });
        return;
      }
      const k = Math.min(Math.max(1, parseInt(url.searchParams.get("k") ?? "10", 10) || 10), 25);
      const results = await searchKnowledge(q, k);
      json(res, 200, { results });
      return;
    }

    if (path === "/knowledge/chunks") {
      const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100), 500);
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      json(res, 200, { chunks: browseChunks(limit, offset) });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(formatLocallyError(err));
  }
}
