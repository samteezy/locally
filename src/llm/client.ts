export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export async function runCompletion(config: LlmConfig, messages: Message[]): Promise<string> {
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
  const content = data.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error(`Unexpected response format from LLM endpoint: ${JSON.stringify(data)}`);
  }

  return content;
}
