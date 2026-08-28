import { test, expect, afterEach, vi } from "vitest";
import { runCompletionWithTools, type LlmConfig } from "./client.js";
import { LocallyError } from "./errors.js";

const baseConfig: LlmConfig = {
  baseUrl: "http://endpoint/v1",
  model: "test-model",
  apiKey: "",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal fetch Response stand-in with controllable status/body. */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  };
}

function stubFetch(impl: (...args: unknown[]) => unknown) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

test("throws a config LocallyError when no model is set", async () => {
  await expect(runCompletionWithTools({ ...baseConfig, model: "" }, [])).rejects.toMatchObject({
    category: "config",
    origin: "local",
    retriable: false,
  });
});

test("maps a successful response, converting usage to camelCase", async () => {
  stubFetch(() =>
    fakeResponse({
      json: {
        choices: [{ message: { content: "hello", tool_calls: [{ id: "1" }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    })
  );
  const turn = await runCompletionWithTools(baseConfig, [{ role: "user", content: "hi" }]);
  expect(turn.content).toBe("hello");
  expect(turn.tool_calls).toEqual([{ id: "1" }]);
  expect(turn.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
});

test("posts to /chat/completions and sets the Authorization header when an apiKey is set", async () => {
  const fetchFn = stubFetch(() =>
    fakeResponse({ json: { choices: [{ message: { content: "ok" } }] } })
  );
  await runCompletionWithTools({ ...baseConfig, apiKey: "secret" }, []);
  const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://endpoint/v1/chat/completions");
  expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret");
});

test("includes tools and tool_choice in the body when tools are provided", async () => {
  const fetchFn = stubFetch(() =>
    fakeResponse({ json: { choices: [{ message: { content: "ok" } }] } })
  );
  await runCompletionWithTools(baseConfig, [], [
    { type: "function", function: { name: "t", description: "d", parameters: {} } },
  ]);
  const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(init.body as string);
  expect(body.tool_choice).toBe("auto");
  expect(body.tools).toHaveLength(1);
});

test("401/403 surfaces a non-retriable config error", async () => {
  stubFetch(() => fakeResponse({ ok: false, status: 401, statusText: "Unauthorized" }));
  await expect(runCompletionWithTools(baseConfig, [])).rejects.toMatchObject({
    category: "config",
    origin: "local",
    retriable: false,
  });
});

test("5xx surfaces a retriable upstream error", async () => {
  stubFetch(() => fakeResponse({ ok: false, status: 503, statusText: "Service Unavailable" }));
  await expect(runCompletionWithTools(baseConfig, [])).rejects.toMatchObject({
    category: "upstream",
    origin: "upstream",
    retriable: true,
  });
});

test("429 is treated as a retriable upstream error", async () => {
  stubFetch(() => fakeResponse({ ok: false, status: 429, statusText: "Too Many Requests" }));
  await expect(runCompletionWithTools(baseConfig, [])).rejects.toMatchObject({
    category: "upstream",
    retriable: true,
  });
});

test("a non-transient 4xx surfaces a non-retriable upstream error", async () => {
  stubFetch(() => fakeResponse({ ok: false, status: 400, statusText: "Bad Request" }));
  await expect(runCompletionWithTools(baseConfig, [])).rejects.toMatchObject({
    category: "upstream",
    retriable: false,
  });
});

test("a malformed response (no choices[0].message) surfaces an upstream error", async () => {
  stubFetch(() => fakeResponse({ json: { choices: [] } }));
  await expect(runCompletionWithTools(baseConfig, [])).rejects.toMatchObject({
    category: "upstream",
    retriable: false,
  });
});

test("an AbortError caused by the caller's signal surfaces as cancelled, not a timeout", async () => {
  stubFetch(() => {
    const err = new Error("aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  });
  const controller = new AbortController();
  controller.abort();
  const caught = await runCompletionWithTools(baseConfig, [], undefined, controller.signal).catch((e) => e);
  expect(caught).toBeInstanceOf(LocallyError);
  expect(caught).toMatchObject({ category: "cancelled", origin: "local", retriable: true });
});

test("an AbortError from fetch surfaces a retriable timeout error", async () => {
  stubFetch(() => {
    const err = new Error("aborted");
    err.name = "AbortError";
    return Promise.reject(err);
  });
  const caught = await runCompletionWithTools(baseConfig, []).catch((e) => e);
  expect(caught).toBeInstanceOf(LocallyError);
  expect(caught).toMatchObject({ category: "timeout", origin: "local", retriable: true });
});

test("a network failure surfaces a retriable upstream error", async () => {
  stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  await expect(runCompletionWithTools(baseConfig, [])).rejects.toMatchObject({
    category: "upstream",
    origin: "upstream",
    retriable: true,
  });
});
