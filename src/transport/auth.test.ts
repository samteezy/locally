import { test, expect, vi, afterEach } from "vitest";
import { assertBindSafety, checkBearer, isLoopbackHost, resolveAuthToken } from "./auth.js";
import { LocallyError } from "../llm/errors.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("resolveAuthToken prefers the config field over the environment", () => {
  vi.stubEnv("LOCALLY_AUTH_TOKEN", "from-env");
  expect(resolveAuthToken({ transport: { authToken: "from-config" } })).toBe("from-config");
});

test("resolveAuthToken falls back to the environment", () => {
  vi.stubEnv("LOCALLY_AUTH_TOKEN", "from-env");
  expect(resolveAuthToken({})).toBe("from-env");
});

test("resolveAuthToken trims, and reads blank as unset in either source", () => {
  vi.stubEnv("LOCALLY_AUTH_TOKEN", "");
  expect(resolveAuthToken({})).toBeUndefined();
  expect(resolveAuthToken({ transport: { authToken: "   " } })).toBeUndefined();
  expect(resolveAuthToken({ transport: { authToken: "  padded  " } })).toBe("padded");
});

test("resolveAuthToken is undefined when neither source sets one", () => {
  vi.stubEnv("LOCALLY_AUTH_TOKEN", undefined);
  expect(resolveAuthToken({})).toBeUndefined();
});

test("isLoopbackHost accepts the whole 127.0.0.0/8 block and the local names", () => {
  for (const host of ["127.0.0.1", "127.0.0.53", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
    expect(isLoopbackHost(host), host).toBe(true);
  }
});

test("isLoopbackHost rejects the wildcards and anything routable", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "mcp.internal", "128.0.0.1"]) {
    expect(isLoopbackHost(host), host).toBe(false);
  }
});

test("assertBindSafety refuses a non-loopback bind with no token", () => {
  let thrown: unknown;
  try {
    assertBindSafety("0.0.0.0", undefined);
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(LocallyError);
  const err = thrown as LocallyError;
  expect(err.category).toBe("config");
  expect(err.origin).toBe("local");
  expect(err.retriable).toBe(false);
});

test("assertBindSafety allows a non-loopback bind once a token is configured", () => {
  expect(() => assertBindSafety("0.0.0.0", "secret")).not.toThrow();
});

test("assertBindSafety allows a loopback bind with no token", () => {
  expect(() => assertBindSafety("127.0.0.1", undefined)).not.toThrow();
});

test("checkBearer accepts the configured token", () => {
  expect(checkBearer("Bearer secret", "secret")).toBe(true);
  expect(checkBearer("bearer secret", "secret")).toBe(true);
  expect(checkBearer("  Bearer\tsecret  ", "secret")).toBe(true);
});

test("checkBearer rejects a wrong token, including one of a different length", () => {
  expect(checkBearer("Bearer wrong", "secret")).toBe(false);
  expect(checkBearer("Bearer secre", "secret")).toBe(false);
  expect(checkBearer("Bearer secrets", "secret")).toBe(false);
  expect(checkBearer("Bearer " + "x".repeat(5000), "secret")).toBe(false);
});

test("checkBearer rejects a missing, empty, or non-bearer header", () => {
  expect(checkBearer(undefined, "secret")).toBe(false);
  expect(checkBearer("", "secret")).toBe(false);
  expect(checkBearer("Bearer", "secret")).toBe(false);
  expect(checkBearer("Bearer ", "secret")).toBe(false);
  expect(checkBearer("Basic c2VjcmV0", "secret")).toBe(false);
  expect(checkBearer("secret", "secret")).toBe(false);
});
