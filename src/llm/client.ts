import { LocallyError } from "./errors.js";

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  timeout?: number; // seconds; default 600
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
  tools?: ToolDefinition[]
): Promise<AssistantTurn> {
  if (!config.model) {
    throw new LocallyError("No model configured.", {
      category: "config",
      origin: "local",
      retriable: false,
      fix: "set a model via LOCALLY_MODEL or the \"model\" field in locally.config.json, then reconnect the locally MCP server (config is read once at startup).",
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

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
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

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LocallyError(`LLM request timed out after ${timeoutSecs}s.`, {
        category: "timeout",
        origin: "local",
        retriable: true,
        fix: "raise \"timeout\" (seconds) in locally.config.json, then reconnect the locally MCP server (config is read once at startup). Or pass a smaller task / lower max_iterations.",
      });
    }
    throw new LocallyError(
      `Failed to reach LLM endpoint at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      {
        category: "upstream",
        origin: "upstream",
        retriable: true,
        fix: `verify the model endpoint at ${url} is running and reachable — this is the endpoint, not locally.`,
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
        fix: "check your API key in locally.config.json (\"apiKey\") or the LOCALLY_API_KEY env var, then reconnect the locally MCP server.",
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
      fix: "the endpoint returned a response that is not OpenAI chat-completions shaped — verify baseUrl points at an OpenAI-compatible /v1 endpoint.",
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
