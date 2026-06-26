export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
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

export interface AssistantTurn {
  content: string | null;
  tool_calls?: ToolCall[];
}

interface CompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
}

export async function runCompletionWithTools(
  config: LlmConfig,
  messages: Message[],
  tools?: ToolDefinition[]
): Promise<AssistantTurn> {
  if (!config.model) {
    throw new Error("No model configured. Set LOCALLY_MODEL or specify a model in locally.config.json.");
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

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Failed to reach LLM endpoint at ${url}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM endpoint returned ${response.status} ${response.statusText}: ${text}`);
  }

  const data = (await response.json()) as CompletionResponse;
  const message = data.choices?.[0]?.message;

  if (!message) {
    throw new Error(`Unexpected response format from LLM endpoint: ${JSON.stringify(data)}`);
  }

  return {
    content: message.content ?? null,
    tool_calls: message.tool_calls,
  };
}

export async function runCompletion(config: LlmConfig, messages: Message[]): Promise<string> {
  const turn = await runCompletionWithTools(config, messages);
  if (typeof turn.content !== "string") {
    throw new Error(`Unexpected response format from LLM endpoint: content was ${turn.content}`);
  }
  return turn.content;
}
