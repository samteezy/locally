import { test, expect, afterEach, vi } from "vitest";
import { runAgentLoop, type AgentTool } from "./agent-loop.js";
import { LocallyError } from "./errors.js";
import type { Message, ToolCall } from "./client.js";

const config = { baseUrl: "http://endpoint/v1", model: "test-model", apiKey: "" };

afterEach(() => {
  vi.unstubAllGlobals();
});

interface ScriptedTurn {
  content?: string | null;
  tool_calls?: ToolCall[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** Stub global fetch to return each scripted completion turn in order. */
function scriptFetch(turns: ScriptedTurn[]) {
  const queue = [...turns];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const turn = queue.shift();
      if (!turn) throw new Error("fetch called more times than scripted");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          choices: [{ message: { content: turn.content ?? null, tool_calls: turn.tool_calls } }],
          usage: turn.usage,
        }),
        text: async () => "",
      };
    })
  );
}

function toolCall(name: string, args: unknown, id = "call-1"): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function fakeTool(name: string, handler: AgentTool["handler"]): AgentTool {
  return {
    definition: { type: "function", function: { name, description: "", parameters: {} } },
    handler,
  };
}

test("returns the model's text answer and accumulates token totals", async () => {
  scriptFetch([
    { content: "final answer", usage: { prompt_tokens: 7, completion_tokens: 3 } },
  ]);
  const result = await runAgentLoop(config, [{ role: "user", content: "hi" }], []);
  expect(result.text).toBe("final answer");
  expect(result.model).toBe("test-model");
  expect(result.promptTokens).toBe(7);
  expect(result.completionTokens).toBe(3);
  expect(result.iterations).toBe(1);
});

test("dispatches a tool call to its handler and pushes a tool-result message", async () => {
  const handler = vi.fn(async () => "tool output");
  scriptFetch([
    { tool_calls: [toolCall("my_tool", { x: 1 })] },
    { content: "done" },
  ]);
  const messages: Message[] = [{ role: "user", content: "go" }];
  const result = await runAgentLoop(config, messages, [fakeTool("my_tool", handler)]);

  expect(handler).toHaveBeenCalledOnce();
  expect(handler).toHaveBeenCalledWith({ x: 1 });
  expect(result.text).toBe("done");
  const toolMsg = messages.find((m) => m.role === "tool");
  expect(toolMsg?.content).toBe("tool output");
  expect(toolMsg?.tool_call_id).toBe("call-1");
});

test("caches duplicate tool calls — handler runs once, second result is the cached marker", async () => {
  const handler = vi.fn(async () => "expensive result");
  scriptFetch([
    { tool_calls: [toolCall("my_tool", { x: 1 }, "a")] },
    { tool_calls: [toolCall("my_tool", { x: 1 }, "b")] },
    { content: "done" },
  ]);
  const messages: Message[] = [{ role: "user", content: "go" }];
  await runAgentLoop(config, messages, [fakeTool("my_tool", handler)]);

  expect(handler).toHaveBeenCalledOnce();
  const cached = messages.find((m) => m.role === "tool" && m.content?.includes("already retrieved"));
  expect(cached?.content).toContain("expensive result");
});

test("reports an unknown tool name without throwing", async () => {
  scriptFetch([
    { tool_calls: [toolCall("nope", {})] },
    { content: "recovered" },
  ]);
  const messages: Message[] = [{ role: "user", content: "go" }];
  const result = await runAgentLoop(config, messages, []);
  expect(result.text).toBe("recovered");
  const toolMsg = messages.find((m) => m.role === "tool");
  expect(toolMsg?.content).toContain('unknown tool "nope"');
});

test("captures invalid JSON tool arguments as a tool error", async () => {
  const handler = vi.fn(async () => "should not run");
  scriptFetch([
    {
      tool_calls: [
        { id: "x", type: "function", function: { name: "my_tool", arguments: "{not json" } },
      ],
    },
    { content: "done" },
  ]);
  const messages: Message[] = [{ role: "user", content: "go" }];
  await runAgentLoop(config, messages, [fakeTool("my_tool", handler)]);
  expect(handler).not.toHaveBeenCalled();
  const toolMsg = messages.find((m) => m.role === "tool");
  expect(toolMsg?.content).toContain("Invalid JSON in tool arguments");
});

test("forces a final answer when max iterations is reached", async () => {
  scriptFetch([
    { tool_calls: [toolCall("my_tool", { x: 1 })] }, // iteration 1 keeps calling tools
    { content: "forced final" }, // the forced no-tools call
  ]);
  const result = await runAgentLoop(
    config,
    [{ role: "user", content: "go" }],
    [fakeTool("my_tool", vi.fn(async () => "out"))],
    1
  );
  expect(result.text).toBe("forced final");
  expect(result.iterations).toBe(2);
});

test("throws a constraint error when the forced final call returns no text", async () => {
  scriptFetch([
    { tool_calls: [toolCall("my_tool", { x: 1 })] },
    { content: null }, // forced final has no usable content
  ]);
  const caught = await runAgentLoop(
    config,
    [{ role: "user", content: "go" }],
    [fakeTool("my_tool", vi.fn(async () => "out"))],
    1
  ).catch((e) => e);
  expect(caught).toBeInstanceOf(LocallyError);
  expect(caught).toMatchObject({ category: "constraint", origin: "local", retriable: true });
});
