import { LocallyError } from "./errors.js";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  timeout?: number; // seconds; default 600
  temperature?: number;
  topP?: number;
  /** Endpoint-specific fields merged into the request body. See AgentConfig.extraBody. */
  extraBody?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded string
  };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AssistantTurn {
  content: string | null;
  tool_calls?: ToolCall[];
  usage?: Usage;
}

interface CompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export async function runCompletionWithTools(
  config: LlmConfig,
  messages: Message[],
  tools?: ToolDefinition[],
  signal?: AbortSignal
): Promise<AssistantTurn> {
  if (!config.model) {
    throw new LocallyError("No model configured.", {
      category: "config",
      origin: "local",
      retriable: false,
      fix: "set a model in LOCALLY_MODEL or in the \"model\" field of locally.config.json. Then reconnect the locally MCP server, because it reads the config only at startup.",
    });
  }

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };

  if (config.maxTokens !== undefined) {
    body.max_tokens = config.maxTokens;
  }

  if (config.temperature !== undefined) {
    body.temperature = config.temperature;
  }

  if (config.topP !== undefined) {
    body.top_p = config.topP;
  }

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  // Last, so the operator's config can override anything above it — including max_tokens for an
  // endpoint that spells it differently. This comes from the config file, not from the model.
  if (config.extraBody) {
    Object.assign(body, config.extraBody);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const timeoutSecs = config.timeout ?? 600;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000);

  // The caller's signal (an MCP client cancelling the tools/call, or the transport dropping)
  // aborts the same request the timeout does, so the two are merged rather than one replacing
  // the other. Which one fired is what tells the two failures apart in the catch below.
  const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestSignal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Only the caller's signal firing without the timeout's means a cancellation; anything
      // else, including an abort from neither, stays the timeout the caller can act on.
      if (signal?.aborted && !controller.signal.aborted) {
        throw new LocallyError("Task cancelled by the caller.", {
          category: "cancelled",
          origin: "local",
          retriable: true,
          fix: "nothing to fix. If you did not intend to cancel, run the task again.",
        });
      }
      throw new LocallyError(`LLM request timed out after ${timeoutSecs}s.`, {
        category: "timeout",
        origin: "local",
        retriable: true,
        fix: "increase \"timeout\" (in seconds) in locally.config.json. Then reconnect the locally MCP server, because it reads the config only at startup. You can also send a smaller task or a lower max_iterations.",
      });
    }
    throw new LocallyError(
      `Failed to reach LLM endpoint at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      {
        category: "upstream",
        origin: "upstream",
        retriable: true,
        fix: `make sure that the model endpoint at ${url} runs and accepts connections. The endpoint failed here, not locally.`,
      }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new LocallyError(`LLM endpoint authentication failed (HTTP ${response.status}).`, {
        category: "config",
        origin: "local",
        retriable: false,
        fix: "check the API key in the \"apiKey\" field of locally.config.json or in the LOCALLY_API_KEY environment variable. Then reconnect the locally MCP server.",
      });
    }
    const text = await response.text().catch(() => "");
    // 5xx and 429 are transient on the endpoint side; other 4xx usually mean a bad request (e.g. unknown model).
    const transient = response.status >= 500 || response.status === 429;
    throw new LocallyError(`LLM endpoint returned ${response.status} ${response.statusText}: ${text}`, {
      category: "upstream",
      origin: "upstream",
      retriable: transient,
      fix: transient
        ? "the model endpoint is overloaded or erroring (5xx/429) — wait and retry; this is the endpoint, not locally."
        : "the model endpoint rejected the request — verify the configured model exists on the endpoint; this is the endpoint, not locally.",
    });
  }

  const data = (await response.json()) as CompletionResponse;
  const message = data.choices?.[0]?.message;

  if (!message) {
    throw new LocallyError(`Unexpected response format from LLM endpoint: ${JSON.stringify(data)}`, {
      category: "upstream",
      origin: "upstream",
      retriable: false,
      fix: "the endpoint returned a response that is not in the OpenAI chat-completions shape. Make sure that baseUrl points at an OpenAI-compatible /v1 endpoint.",
    });
  }

  return {
    content: message.content ?? null,
    tool_calls: message.tool_calls,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

export async function runCompletion(config: LlmConfig, messages: Message[]): Promise<string> {
  const turn = await runCompletionWithTools(config, messages);
  if (typeof turn.content !== "string") {
    throw new Error(`Unexpected response format from LLM endpoint: content was ${turn.content}`);
  }
  return turn.content;
}
