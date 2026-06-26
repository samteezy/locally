import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../server.js";
import type { LocallyConfig } from "../config.js";

export async function startStdio(config: LocallyConfig): Promise<void> {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("locally MCP server started (stdio)\n");
}
