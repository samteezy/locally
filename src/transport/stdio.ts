import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../server.js";
import type { LocallyConfig } from "../config.js";

export async function startStdio(config: LocallyConfig): Promise<void> {
  // `serveStdio` owns the era decision for the connection: the opening exchange selects
  // 2025-era (`initialize`) or 2026-07-28 (`server/discover`, which it answers itself), and one
  // factory instance is pinned for the connection's lifetime. `legacy` defaults to `'serve'`,
  // so 2025-era hosts keep working unchanged.
  serveStdio(() => createServer(config), {
    onerror: (err) => process.stderr.write(`locally: ${err.message}\n`),
  });
  process.stderr.write("locally MCP server started (stdio)\n");
}
