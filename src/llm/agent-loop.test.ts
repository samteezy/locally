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
  expect(result.cappedAtMaxIterations).toBe(false);
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
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
  // The caller needs to know the run ran out of budget rather than finishing (issue #13).
  expect(result.cappedAtMaxIterations).toBe(true);
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

test("an already-aborted signal stops the loop before any completion is requested", async () => {
  scriptFetch([{ content: "should never be reached" }]);
  const controller = new AbortController();
  controller.abort();

  const caught = await runAgentLoop(config, [], [], 8, undefined, controller.signal).catch((e) => e);

  expect(caught).toBeInstanceOf(LocallyError);
  expect(caught).toMatchObject({ category: "cancelled", origin: "local" });
  expect(fetch).not.toHaveBeenCalled();
});

test("a signal aborted mid-run stops the loop between iterations", async () => {
  const controller = new AbortController();
  // First turn calls a tool; the tool aborts, so the loop must not start a second iteration.
  scriptFetch([{ content: null, tool_calls: [toolCall("stopper", {})] }, { content: "second turn" }]);
  const stopper = fakeTool("stopper", async () => {
    controller.abort();
    return "stopped";
  });

  const caught = await runAgentLoop(config, [], [stopper], 8, undefined, controller.signal).catch((e) => e);

  expect(caught).toBeInstanceOf(LocallyError);
  expect(caught).toMatchObject({ category: "cancelled" });
  // Only the first iteration's completion was requested.
  expect(fetch).toHaveBeenCalledTimes(1);
});

// --- the draft-answer hook ------------------------------------------------------
// The only thing that lets a caller's breadth setting shape the run rather than flavour the prompt
// (issue #16): a "very thorough" sweep that concluded after five of twenty iterations.

test("a returned nudge pushes a user turn and keeps the loop running", async () => {
  scriptFetch([{ content: "Done." }, { content: "Done properly." }]);
  const messages: Message[] = [{ role: "user", content: "q" }];
  let asked = 0;

  const result = await runAgentLoop(config, messages, [], 10, undefined, undefined, () =>
    asked++ === 0 ? "keep going" : null
  );

  expect(result.text).toBe("Done properly.");
  expect(result.iterations).toBe(2);
  expect(messages.some((m) => m.role === "user" && m.content === "keep going")).toBe(true);
});

test("a null from the hook accepts the answer as before", async () => {
  scriptFetch([{ content: "Done." }]);
  const result = await runAgentLoop(config, [{ role: "user", content: "q" }], [], 10, undefined, undefined, () => null);
  expect(result.text).toBe("Done.");
  expect(result.iterations).toBe(1);
});

test("the hook cannot push the loop past its iteration budget", async () => {
  // At the cap the answer would come from the forced tool-less call, where the model cannot act on
  // what it was asked — so the hook is not consulted at all.
  scriptFetch([{ content: "Done." }]);
  const hook = vi.fn(() => "keep going");
  const result = await runAgentLoop(config, [{ role: "user", content: "q" }], [], 1, undefined, undefined, hook);
  expect(hook).not.toHaveBeenCalled();
  expect(result.text).toBe("Done.");
  expect(result.cappedAtMaxIterations).toBe(false);
});
