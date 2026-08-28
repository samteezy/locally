import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import {
  createMcpHandler,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from "@modelcontextprotocol/server";
import { createServer } from "./server.js";

const MODERN_REVISION = "2026-07-28";

/**
 * Drive the HTTP entry in-process through its fetch function — the documented way to exercise
 * 2026-07-28 without sockets. The same entry serves both eras, so these tests cover the wire
 * shape the transports actually put out, not just the handler's return value.
 */
function handler() {
  return createMcpHandler(() => createServer({}));
}

/** A modern response is plain JSON; a legacy one arrives as a single SSE `data:` frame. */
async function post(body: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await handler().fetch(
    new Request("http://test.local/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  const frame = text.startsWith("event:") ? /^data: (.*)$/m.exec(text)?.[1] : text;
  return JSON.parse(frame ?? "{}");
}

/** A 2025-era request: no `_meta` envelope, no standard headers. */
function legacy(id: number, method: string, params: Record<string, unknown> = {}) {
  return post({ jsonrpc: "2.0", id, method, params });
}

/**
 * A 2026-07-28 request: envelope claim in `_meta` plus the SEP-2243 standard headers. The entry
 * rejects a modern request whose headers and body disagree, so `Mcp-Name` mirrors `params.name`
 * on the methods that carry one.
 */
function modern(id: number, method: string, params: Record<string, unknown> = {}) {
  const name: Record<string, string> =
    typeof params.name === "string" ? { "Mcp-Name": params.name } : {};
  return post(
    {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
          [CLIENT_INFO_META_KEY]: { name: "server.test", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    },
    { "MCP-Protocol-Version": MODERN_REVISION, "Mcp-Method": method, ...name }
  );
}

test("tools/list advertises the three tools in a deterministic order", async () => {
  const { result } = await modern(1, "tools/list");
  expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
    "explore_task",
    "run_task",
    "usage_report",
  ]);
});

test("each tool carries a title and annotations that match what it actually does", async () => {
  const { result } = await modern(2, "tools/list");
  const byName = Object.fromEntries(result.tools.map((t: { name: string }) => [t.name, t]));

  expect(byName.explore_task.title).toBe("Explore codebase (local model)");
  expect(byName.explore_task.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

  // run_task writes files, patches them, and runs shell commands.
  expect(byName.run_task.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

  expect(byName.usage_report.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });

  // Every tool is fenced to allowedRoots, so none of them reaches an open world.
  for (const tool of result.tools) {
    expect(tool.annotations.openWorldHint).toBe(false);
  }
});

test("a 2026-07-28 tools/list carries the configured cache hints", async () => {
  const { result } = await modern(3, "tools/list");
  // The tool list is static for the process's lifetime, so it is cacheable and shareable.
  expect(result.ttlMs).toBe(3_600_000);
  expect(result.cacheScope).toBe("public");
});

test("a 2026-07-28 result identifies the server and marks itself complete", async () => {
  const { result } = await modern(4, "tools/list");
  expect(result.resultType).toBe("complete");

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  // Identity is stamped on every 2026-era response, so it must not drift from the package.
  expect(result._meta[SERVER_INFO_META_KEY]).toEqual({ name: "locally", version: pkg.version });
});

test("a 2025-era tools/list still works and carries none of the 2026 fields", async () => {
  const { result } = await legacy(5, "tools/list");
  expect(result.tools).toHaveLength(3);
  expect(result.resultType).toBeUndefined();
  expect(result.ttlMs).toBeUndefined();
  expect(result.cacheScope).toBeUndefined();
});

test("an unknown tool comes back as an isError result, not a JSON-RPC error", async () => {
  const { result, error } = await modern(6, "tools/call", { name: "nope", arguments: {} });
  expect(error).toBeUndefined();
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Unknown tool: nope");
});
