import { test, expect, afterEach, vi } from "vitest";
import {
  resolveAgentConfig,
  resolveToolAgent,
  resolveTransportMode,
  type LocallyConfig, symbolCheckEnabled } from "./config.js";

const originalArgv = process.argv;

afterEach(() => {
  vi.unstubAllEnvs();
  process.argv = originalArgv;
});

// --- resolveAgentConfig ---

test("resolveAgentConfig returns config.default values when present", () => {
  const config: LocallyConfig = {
    default: { baseUrl: "http://host/v1", model: "m", apiKey: "k", maxTokens: 100, timeout: 30 },
  };
  expect(resolveAgentConfig(config)).toEqual({
    baseUrl: "http://host/v1",
    model: "m",
    apiKey: "k",
    maxTokens: 100,
    timeout: 30,
  });
});

test("resolveAgentConfig falls back to env vars and the Ollama default baseUrl", () => {
  vi.stubEnv("LOCALLY_BASE_URL", "");
  vi.stubEnv("LOCALLY_MODEL", "env-model");
  vi.stubEnv("LOCALLY_API_KEY", "env-key");
  const resolved = resolveAgentConfig({});
  // Empty LOCALLY_BASE_URL is `?? `-falsy only when undefined; "" is kept, so use the default path:
  expect(resolved.model).toBe("env-model");
  expect(resolved.apiKey).toBe("env-key");
});

test("resolveAgentConfig defaults baseUrl to the Ollama path when nothing is set", () => {
  vi.stubEnv("LOCALLY_BASE_URL", undefined);
  vi.stubEnv("LOCALLY_MODEL", undefined);
  vi.stubEnv("LOCALLY_API_KEY", undefined);
  expect(resolveAgentConfig({}).baseUrl).toBe("http://localhost:11434/v1");
});

test("resolveAgentConfig merges a named agent override onto the defaults", () => {
  const config: LocallyConfig = {
    default: { baseUrl: "http://base/v1", model: "base-model", apiKey: "base-key", timeout: 30 },
    agents: { fast: { model: "fast-model", maxTokens: 50 } },
  };
  expect(resolveAgentConfig(config, "fast")).toEqual({
    baseUrl: "http://base/v1",
    model: "fast-model",
    apiKey: "base-key",
    maxTokens: 50,
    timeout: 30,
  });
});

test("resolveAgentConfig throws for an unknown agent, listing the available ones", () => {
  const config: LocallyConfig = { agents: { fast: {}, slow: {} } };
  expect(() => resolveAgentConfig(config, "missing")).toThrow(/Agent "missing" not found/);
  expect(() => resolveAgentConfig(config, "missing")).toThrow(/fast, slow/);
});

test("resolveAgentConfig reports (none) when there are no configured agents", () => {
  expect(() => resolveAgentConfig({}, "missing")).toThrow(/\(none\)/);
});

// --- resolveToolAgent ---

test("resolveToolAgent prefers the explicit param over config", () => {
  const config: LocallyConfig = { tools: { explore: { agent: "configured" } } };
  expect(resolveToolAgent(config, "explore", "param")).toBe("param");
});

test("resolveToolAgent falls back to the configured tool agent", () => {
  const config: LocallyConfig = { tools: { run: { agent: "runner" } } };
  expect(resolveToolAgent(config, "run")).toBe("runner");
});

test("resolveToolAgent returns undefined when nothing is configured", () => {
  expect(resolveToolAgent({}, "explore")).toBeUndefined();
});

// --- resolveTransportMode ---

test("resolveTransportMode honors the --transport flag first", () => {
  process.argv = ["node", "index.js", "--transport", "http"];
  expect(resolveTransportMode({})).toBe("http");
});

test("resolveTransportMode falls back to LOCALLY_TRANSPORT env", () => {
  process.argv = ["node", "index.js"];
  vi.stubEnv("LOCALLY_TRANSPORT", "http");
  expect(resolveTransportMode({})).toBe("http");
});

test("resolveTransportMode falls back to config.transport.mode", () => {
  process.argv = ["node", "index.js"];
  vi.stubEnv("LOCALLY_TRANSPORT", undefined);
  expect(resolveTransportMode({ transport: { mode: "http" } })).toBe("http");
});

test("resolveTransportMode defaults to stdio", () => {
  process.argv = ["node", "index.js"];
  vi.stubEnv("LOCALLY_TRANSPORT", undefined);
  expect(resolveTransportMode({})).toBe("stdio");
});

// --- LOCALLY_VERIFY_SYMBOLS ---------------------------------------------------
// Read from the environment on every call rather than from the config object: loadConfig
// returns a config file verbatim and never consults env on that path, so a knob living there
// would be silently ignored by anyone who has a locally.config.json.

function withSymbolEnv(value: string | undefined, fn: () => void): void {
  const original = process.env.LOCALLY_VERIFY_SYMBOLS;
  if (value === undefined) delete process.env.LOCALLY_VERIFY_SYMBOLS;
  else process.env.LOCALLY_VERIFY_SYMBOLS = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.LOCALLY_VERIFY_SYMBOLS;
    else process.env.LOCALLY_VERIFY_SYMBOLS = original;
  }
}

test("the symbol check is on when the env var is unset", () => {
  withSymbolEnv(undefined, () => expect(symbolCheckEnabled()).toBe(true));
});

test("the symbol check is off for each spelling of no", () => {
  for (const value of ["0", "false", "off", "no", "FALSE", " Off "]) {
    withSymbolEnv(value, () => expect(symbolCheckEnabled()).toBe(false));
  }
});

test("an unrecognised value leaves the symbol check on", () => {
  // Failing open matches the rest of the config: a typo should not silently drop a check.
  for (const value of ["1", "true", "yes", "maybe", ""]) {
    withSymbolEnv(value, () => expect(symbolCheckEnabled()).toBe(true));
  }
});

test("an agent inherits the default's sampling and prompt settings", () => {
  const config = {
    default: { baseUrl: "http://a/v1", model: "m", apiKey: "", temperature: 0.7, maxIterations: 10 },
    agents: { fast: { model: "small" } },
  };
  const resolved = resolveAgentConfig(config, "fast");
  expect(resolved.model).toBe("small");
  expect(resolved.temperature).toBe(0.7);
  expect(resolved.maxIterations).toBe(10);
});

test("an agent's own sampling and prompt settings win over the default's", () => {
  const config = {
    default: { baseUrl: "http://a/v1", model: "m", apiKey: "", temperature: 0.7, maxIterations: 10 },
    agents: {
      explorer: {
        temperature: 0,
        topP: 0.9,
        maxIterations: 6,
        systemPrompt: "its own contract",
        extraBody: { reasoning_effort: "none" },
      },
    },
  };
  const resolved = resolveAgentConfig(config, "explorer");
  expect(resolved.temperature).toBe(0);
  expect(resolved.topP).toBe(0.9);
  expect(resolved.maxIterations).toBe(6);
  expect(resolved.systemPrompt).toBe("its own contract");
  expect(resolved.extraBody).toEqual({ reasoning_effort: "none" });
});

test("unset sampling stays undefined rather than defaulting to a value", () => {
  const resolved = resolveAgentConfig({ default: { baseUrl: "http://a/v1", model: "m", apiKey: "" } });
  expect(resolved.temperature).toBeUndefined();
  expect(resolved.topP).toBeUndefined();
  expect(resolved.extraBody).toBeUndefined();
});

test("an agent's extraBody replaces the default's rather than merging into it", () => {
  const config = {
    default: { baseUrl: "http://a/v1", model: "m", apiKey: "", extraBody: { reasoning_effort: "high", seed: 1 } },
    agents: { quiet: { extraBody: { reasoning_effort: "none" } } },
  };
  expect(resolveAgentConfig(config, "quiet").extraBody).toEqual({ reasoning_effort: "none" });
});
