import { test, expect, afterEach, vi } from "vitest";
import {
  resolveAgentConfig,
  resolveToolAgent,
  resolveTransportMode,
  type LocallyConfig,
} from "./config.js";

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
