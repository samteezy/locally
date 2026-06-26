import { createServer as createNodeHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "../server.js";
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
}
