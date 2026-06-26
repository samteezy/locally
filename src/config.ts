import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
}

export interface TransportConfig {
  mode?: "stdio" | "http";
  port?: number;
  host?: string;
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
    transform?: ToolRoutingConfig;
  };
}

export interface ResolvedAgentConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens?: number;
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
    return { baseUrl, model, apiKey, maxTokens };
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
  };
}

export function resolveToolAgent(
  config: LocallyConfig,
  toolKey: "explore" | "run" | "transform",
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
