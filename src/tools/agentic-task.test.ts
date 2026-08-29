import { test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgenticTask } from "./agentic-task.js";
import { AGENT_TOOLS, type AgentTool } from "../llm/agent-loop.js";
import type { LocallyConfig } from "../config.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "locally-fence-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "locally-outside-")));
mkdirSync(join(base, "src"));
writeFileSync(join(base, "src", "app.ts"), "line 1\nline 2\n");
writeFileSync(join(outside, "secret.ts"), "the model must not see this\n");

const config: LocallyConfig = {
  default: { baseUrl: "http://endpoint/v1", model: "test-model", apiKey: "" },
  allowedRoots: [base],
};

afterEach(() => vi.unstubAllGlobals());

/** One turn of tool calls, then a plain text answer. */
function scriptToolCall(name: string, args: unknown) {
  const turns = [
    { content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    { content: "done", tool_calls: undefined },
  ];
  const queue = [...turns];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const turn = queue.shift()!;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ choices: [{ message: turn }], usage: {} }),
        text: async () => "",
      };
    })
  );
}

/** Args each tool handler actually received, so a fenced-off call shows up as an absence. */
function capturing(seen: unknown[]): AgentTool[] {
  return AGENT_TOOLS.map((t) => ({
    ...t,
    handler: async (args: unknown) => {
      seen.push(args);
      return t.handler(args);
    },
  }));
}

test("a Read outside the allowed roots never reaches the handler, and the run continues", async () => {
  scriptToolCall("Read", { path: join(outside, "secret.ts") });
  const seen: unknown[] = [];
  const result = await runAgenticTask(config, { task: "q", path: base }, "explore", capturing(seen));

  // The wrapper validates before the handler, so the file is never opened...
  expect(seen).toHaveLength(0);
  // ...and the error goes back as a tool result rather than aborting, so the model can retry.
  expect(result.text).toBe("done");
});

test("Grep falls back to the task's own directory when the model omits the path", async () => {
  scriptToolCall("Grep", { pattern: "line 1" });
  const seen: unknown[] = [];
  await runAgenticTask(config, { task: "q", path: base }, "explore", capturing(seen));
  expect(seen).toEqual([{ pattern: "line 1", path: base }]);
});

test("a write tool with no path is refused rather than defaulted into the task directory", async () => {
  scriptToolCall("write_file", { content: "x" });
  const seen: unknown[] = [];
  const tools: AgentTool[] = [
    {
      definition: { type: "function", function: { name: "write_file", description: "", parameters: {} } },
      handler: async (args) => {
        seen.push(args);
        return "wrote";
      },
      fence: { pathKey: "path", mustExist: false },
    },
  ];
  await runAgenticTask(config, { task: "q", path: base }, "run", tools);
  expect(seen).toHaveLength(0);
});
