import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  timeout?: number; // seconds
  /**
   * Replaces the tool's own system prompt for this agent, rather than being appended to it. A model
   * fine-tuned against a fixed exploration harness expects its own contract; handing it ours on top
   * is what wastes the fine-tune.
   */
  systemPrompt?: string;
  /** Sent only when set, so the default stays "let the endpoint decide". */
  temperature?: number;
  topP?: number;
  /**
   * Merged into the request body last, for endpoint-specific knobs locally has no business
   * guessing at. Turning Qwen reasoning off is `reasoning_effort` on Ollama and
   * `chat_template_kwargs: { enable_thinking: false }` on llama.cpp and vLLM; rather than
   * detect the endpoint, let whoever configured it say which. Set by the operator in the config
   * file, never by the model, so it is allowed to override anything above it.
   */
  extraBody?: Record<string, unknown>;
  /** Default loop budget for this agent. An explicit max_iterations on the call still wins. */
  maxIterations?: number;
}

export interface TransportConfig {
  mode?: "stdio" | "http";
  port?: number;
  host?: string;
  /**
   * Hostnames accepted in the `Host` and `Origin` headers on `/mcp` (DNS-rebinding defence).
   * Defaults to the bind host plus localhost. A deployment reached by any other name — a
   * reverse proxy, a container hostname — must list it here or requests are rejected.
   */
  allowedHosts?: string[];
  /** Origin hostnames accepted on `/mcp`. Defaults to `allowedHosts`. */
  allowedOrigins?: string[];
  /**
   * Shared secret required as `Authorization: Bearer <token>` on every `/mcp` request. Unset means
   * no auth, which is only allowed on a loopback bind — binding any other host without a token is a
   * startup error (`src/transport/auth.ts`). `LOCALLY_AUTH_TOKEN` is the env fallback.
   */
  authToken?: string;
}

export interface ToolRoutingConfig {
  agent?: string;
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
}

export interface ResolvedAgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
  timeout?: number; // seconds
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  extraBody?: Record<string, unknown>;
  maxIterations?: number;
}

/**
 * Whether explore_task runs the asserted-symbol check on an answer before returning it.
 *
 * Read straight from the environment, on purpose. `LocallyConfig` is the parsed config file
 * verbatim — the per-field env fallback that `baseUrl`/`model`/`apiKey` enjoy happens later, in
 * resolveAgentConfig, and only for those fields. A `verifySymbols` key on the config object
 * would therefore have no path by which an env var could reach it, and would be silently
 * ignored by everyone who has a locally.config.json.
 *
 * Set by the person running the server (the MCP client's `env` block), not by the model: this is
 * deliberately not a per-call parameter, so an answer cannot turn off its own fact-checking.
 */
export function symbolCheckEnabled(): boolean {
  const value = process.env.LOCALLY_VERIFY_SYMBOLS?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
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

  const inherited = {
    systemPrompt: defaults.systemPrompt,
    temperature: defaults.temperature,
    topP: defaults.topP,
    extraBody: defaults.extraBody,
    maxIterations: defaults.maxIterations,
  };

  if (!agentName) {
    return { baseUrl, model, apiKey, maxTokens, timeout: defaults.timeout, ...inherited };
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
    systemPrompt: override.systemPrompt ?? inherited.systemPrompt,
    temperature: override.temperature ?? inherited.temperature,
    topP: override.topP ?? inherited.topP,
    // Replaced wholesale, not merged: a half-applied set of endpoint knobs is harder to reason
    // about than either one on its own.
    extraBody: override.extraBody ?? inherited.extraBody,
    maxIterations: override.maxIterations ?? inherited.maxIterations,
  };
}

export function resolveToolAgent(
  config: LocallyConfig,
  toolKey: "explore" | "run",
  paramAgent?: string
): string | undefined {
  return paramAgent ?? config.tools?.[toolKey]?.agent;
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
