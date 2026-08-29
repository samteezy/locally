import { createServer as createNodeHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createServer as createMcpServer } from "../server.js";
import type { LocallyConfig } from "../config.js";
import { assertBindSafety, checkBearer, resolveAuthToken } from "./auth.js";

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

  // Before any socket is opened: a non-loopback bind with no token configured is a startup error,
  // not a warning. The DNS-rebinding guards below do not substitute for this — they defend a browser
  // against a page it did not expect, while `Host` and `Origin` are whatever a direct client types.
  const authToken = resolveAuthToken(config);
  assertBindSafety(host, authToken);

  const allowedHosts = config.transport?.allowedHosts ?? [host, "localhost", "127.0.0.1", "[::1]"];
  const allowedOrigins = config.transport?.allowedOrigins ?? allowedHosts;
  const checkHost = hostHeaderValidation(allowedHosts);
  const checkOrigin = originValidation(allowedOrigins);

  const logError = (err: Error) => process.stderr.write(`locally: ${err.message}\n`);

  // One factory, one endpoint, both protocol eras. `legacy` defaults to `'stateless'`, which
  // serves 2025-era traffic through exactly the per-request idiom this transport used before —
  // a fresh server per request, no session id — while modern requests get 2026-07-28.
  const mcp = toNodeHandler(
    createMcpHandler(() => createMcpServer(config), { onerror: logError }),
    { onerror: logError }
  );

  const httpServer = createNodeHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "locally" }));
        return;
      }

      if (req.url === "/mcp") {
        // DNS-rebinding defence. Both guards write their own rejection and return false. This is
        // what stops a local browser page from reaching an unauthenticated loopback endpoint; it is
        // not access control, since a direct client sends whatever Host and Origin it likes — that
        // is the token's job below. Note a present-but-unparseable Origin (the `null` sent by
        // sandboxed iframes and file:// pages) is rejected and cannot be allowlisted.
        if (!checkHost(req, res) || !checkOrigin(req, res)) return;

        // Auth, before the body is read: an unauthenticated caller should not get to spend the 1MB
        // read, and should learn nothing from the response but that a token is wanted. /health stays
        // open — it is the liveness check and reports no data.
        if (authToken !== undefined && !checkBearer(req.headers.authorization, authToken)) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="locally"',
          });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        // The adapter has no body-size limit of its own, so the body is still read here under a
        // cap and handed over parsed. Method semantics (405 on the 2025-era GET/DELETE session
        // operations) are the entry's to answer, not this router's.
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
        await mcp(req, res, body);
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
  // Same reasoning as the sandbox fence line in index.ts: a protection that is silently off is worse
  // than one that is loudly off, so say which of the two this is.
  process.stderr.write(
    `locally: /mcp auth: ${authToken !== undefined ? "bearer token required" : "none (loopback bind only)"}\n`
  );
}
