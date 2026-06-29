import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  timeout?: number; // seconds
}

export interface TransportConfig {
  mode?: "stdio" | "http";
  port?: number;
  host?: string;
}

export interface ToolRoutingConfig {
  agent?: string;
}

export interface EmbeddingsConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Vector dimension. Optional — inferred from the first embedding and recorded if omitted. */
  dimensions?: number;
  /** Texts per /embeddings request (default 32). */
  batchSize?: number;
  timeout?: number; // seconds
}

export interface KnowledgeConfig {
  /** Opt-in. When false/unset the feature is fully inert (no watcher, routes, tool, or DB). */
  enabled?: boolean;
  /** Folders to index. Confined to `allowedRoots` like every other file path. */
  watch?: string[];
  /** SQLite file holding chunks + vectors. Default: ~/.locally/knowledge.db */
  storePath?: string;
  /** Extensions to index (no leading dot). Default: ["md", "markdown", "txt"]. */
  fileTypes?: string[];
  /** OpenAI-compatible embeddings endpoint. */
  embeddings?: EmbeddingsConfig;
  /** Chunking knobs. Defaults: maxChars 1000, overlap 150. */
  chunk?: { maxChars?: number; overlap?: number };
}

export interface LocallyConfig {
  transport?: TransportConfig;
  default?: AgentConfig;
  agents?: Record<string, AgentConfig>;
  tools?: {
    explore?: ToolRoutingConfig;
    run?: ToolRoutingConfig;
  };
  ignorePatterns?: string[];
  /**
   * Directories the file & shell tools are confined to. The model can only read/write/patch/
   * search/execute within these roots (symlinks are resolved before the check). Defaults to
   * `[process.cwd()]` — the directory the server launched in — when unset or empty.
   */
  allowedRoots?: string[];
  /** Optional folder-watching semantic-search knowledge base (HTTP/remote mode only). */
  knowledge?: KnowledgeConfig;
}

export interface ResolvedAgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  timeout?: number; // seconds
}

export function loadConfig(): LocallyConfig {
  const configPath = resolveConfigPath();

  if (configPath) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      return JSON.parse(raw) as LocallyConfig;
    } catch (err) {
      process.stderr.write(`Warning: failed to parse config at ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return {
    default: {
      baseUrl: process.env.LOCALLY_BASE_URL ?? "http://localhost:11434/v1",
      model: process.env.LOCALLY_MODEL ?? "",
      apiKey: process.env.LOCALLY_API_KEY ?? "",
    },
  };
}

function resolveConfigPath(): string | null {
  const envPath = process.env.LOCALLY_CONFIG;
  if (envPath) return envPath;

  const cwdPath = join(process.cwd(), "locally.config.json");
  if (existsSync(cwdPath)) return cwdPath;

  const homePath = join(homedir(), ".locally", "config.json");
  if (existsSync(homePath)) return homePath;

  return null;
}

export function resolveAgentConfig(config: LocallyConfig, agentName?: string): ResolvedAgentConfig {
  const defaults = config.default ?? {};
  const baseUrl = defaults.baseUrl ?? process.env.LOCALLY_BASE_URL ?? "http://localhost:11434/v1";
  const model = defaults.model ?? process.env.LOCALLY_MODEL ?? "";
  const apiKey = defaults.apiKey ?? process.env.LOCALLY_API_KEY ?? "";
  const maxTokens = defaults.maxTokens;

  if (!agentName) {
    return { baseUrl, model, apiKey, maxTokens, timeout: defaults.timeout };
  }

  const override = config.agents?.[agentName];
  if (!override) {
    throw new Error(`Agent "${agentName}" not found in config. Available agents: ${Object.keys(config.agents ?? {}).join(", ") || "(none)"}`);
  }

  return {
    baseUrl: override.baseUrl ?? baseUrl,
    model: override.model ?? model,
    apiKey: override.apiKey ?? apiKey,
    maxTokens: override.maxTokens ?? maxTokens,
    timeout: override.timeout ?? defaults.timeout,
  };
}

export function resolveToolAgent(
  config: LocallyConfig,
  toolKey: "explore" | "run",
  paramAgent?: string
): string | undefined {
  return paramAgent ?? config.tools?.[toolKey]?.agent;
}

export interface ResolvedEmbeddingsConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
  batchSize: number;
  timeout?: number; // seconds
}

/**
 * Resolve the embeddings endpoint for the knowledge base. Precedence: knowledge.embeddings >
 * LOCALLY_EMBEDDINGS_* env > the default agent's baseUrl/apiKey (so a user who already
 * configured a single endpoint doesn't have to repeat it). `model` has no sane default — the
 * embeddings model is endpoint-specific — so it stays "" and the client surfaces a config error.
 */
export function resolveEmbeddingsConfig(config: LocallyConfig): ResolvedEmbeddingsConfig {
  const emb = config.knowledge?.embeddings ?? {};
  const defaults = config.default ?? {};

  const baseUrl =
    emb.baseUrl ??
    process.env.LOCALLY_EMBEDDINGS_BASE_URL ??
    defaults.baseUrl ??
    process.env.LOCALLY_BASE_URL ??
    "http://localhost:11434/v1";
  const model = emb.model ?? process.env.LOCALLY_EMBEDDINGS_MODEL ?? "";
  const apiKey =
    emb.apiKey ??
    process.env.LOCALLY_EMBEDDINGS_API_KEY ??
    defaults.apiKey ??
    process.env.LOCALLY_API_KEY ??
    "";

  return {
    baseUrl,
    model,
    apiKey,
    dimensions: emb.dimensions,
    batchSize: emb.batchSize ?? 32,
    timeout: emb.timeout ?? defaults.timeout,
  };
}

export function resolveTransportMode(config: LocallyConfig): "stdio" | "http" {
  const idx = process.argv.indexOf("--transport");
  if (idx !== -1) {
    const flag = process.argv[idx + 1];
    if (flag === "stdio" || flag === "http") return flag;
  }

  const env = process.env.LOCALLY_TRANSPORT;
  if (env === "stdio" || env === "http") return env;

  if (config.transport?.mode) return config.transport.mode;

  return "stdio";
}
