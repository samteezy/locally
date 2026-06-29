import { LocallyError } from "./errors.js";

/**
 * Minimal OpenAI-compatible embeddings client. Mirrors the fetch/timeout/auth/error shape of
 * `runCompletionWithTools` in client.ts, but hits `/embeddings` and returns one vector per input.
 */

export interface EmbeddingsClientConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeout?: number; // seconds; default 600
}

interface EmbeddingsResponse {
  data?: Array<{ embedding: number[]; index?: number }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Embed a batch of strings in a single request. Returns vectors in input order.
 * The caller is responsible for batching large inputs (see indexer's batchSize).
 */
export async function embedTexts(
  config: EmbeddingsClientConfig,
  input: string[]
): Promise<number[][]> {
  if (input.length === 0) return [];

  if (!config.model) {
    throw new LocallyError("No embeddings model configured.", {
      category: "config",
      origin: "local",
      retriable: false,
      fix: 'set knowledge.embeddings.model in locally.config.json (or LOCALLY_EMBEDDINGS_MODEL), then reconnect the locally MCP server (config is read once at startup).',
    });
  }

  const url = `${config.baseUrl.replace(/\/$/, "")}/embeddings`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
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
      body: JSON.stringify({ model: config.model, input }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LocallyError(`Embeddings request timed out after ${timeoutSecs}s.`, {
        category: "timeout",
        origin: "local",
        retriable: true,
        fix: 'raise knowledge.embeddings.timeout (seconds) in locally.config.json, then reconnect the locally MCP server. Or lower knowledge.embeddings.batchSize.',
      });
    }
    throw new LocallyError(
      `Failed to reach embeddings endpoint at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      {
        category: "upstream",
        origin: "upstream",
        retriable: true,
        fix: `verify the embeddings endpoint at ${url} is running and reachable — this is the endpoint, not locally.`,
      }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new LocallyError(`Embeddings endpoint authentication failed (HTTP ${response.status}).`, {
        category: "config",
        origin: "local",
        retriable: false,
        fix: 'check knowledge.embeddings.apiKey in locally.config.json (or LOCALLY_EMBEDDINGS_API_KEY), then reconnect the locally MCP server.',
      });
    }
    const text = await response.text().catch(() => "");
    const transient = response.status >= 500 || response.status === 429;
    throw new LocallyError(`Embeddings endpoint returned ${response.status} ${response.statusText}: ${text}`, {
      category: "upstream",
      origin: "upstream",
      retriable: transient,
      fix: transient
        ? "the embeddings endpoint is overloaded or erroring (5xx/429) — wait and retry; this is the endpoint, not locally."
        : "the embeddings endpoint rejected the request — verify the configured embeddings model exists on the endpoint; this is the endpoint, not locally.",
    });
  }

  const data = (await response.json()) as EmbeddingsResponse;
  const rows = data.data;
  if (!Array.isArray(rows) || rows.length !== input.length) {
    throw new LocallyError(
      `Unexpected embeddings response: expected ${input.length} vectors, got ${rows?.length ?? 0}.`,
      {
        category: "upstream",
        origin: "upstream",
        retriable: false,
        fix: "the endpoint returned a response that is not OpenAI embeddings shaped — verify baseUrl points at an OpenAI-compatible /v1 endpoint with an embeddings model.",
      }
    );
  }

  // Honor the per-row `index` field if present; otherwise assume positional order.
  const out: number[][] = new Array(input.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    out[row.index ?? i] = row.embedding;
  }
  return out;
}
