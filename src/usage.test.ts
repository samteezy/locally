import { test, expect, beforeEach } from "vitest";
import { withUsageFooter, formatUsageReport, resetUsage, getSessionStats } from "./usage.js";
import type { AgentRunResult } from "./llm/agent-loop.js";

beforeEach(() => resetUsage());

const run = (
  promptTokens: number,
  completionTokens: number,
  overrides: Partial<AgentRunResult> = {}
): AgentRunResult => ({
  text: "answer",
  model: "test-model",
  promptTokens,
  completionTokens,
  iterations: 3,
  durationMs: 12_000,
  cappedAtMaxIterations: false,
  filesRead: 4,
  filesReadPaths: [],
  filesMatchedPaths: [],
  filesListedPaths: [],
  nudged: false,
  ...overrides,
});

test("footer reports read and returned separately", () => {
  const out = withUsageFooter(run(44000, 2400));
  expect(out).toContain("~44k read locally");
  expect(out).toContain("~2.4k returned");
});

test("footer never claims the sum was kept off the frontier model", () => {
  const out = withUsageFooter(run(44000, 2400));
  expect(out).not.toContain("46k");
  expect(out).not.toMatch(/kept? .* off the frontier/i);
});

test("footer says so when the endpoint reports no usage", () => {
  expect(withUsageFooter(run(0, 0))).toContain("token usage not reported by endpoint");
});

test("report attributes the saving to completion tokens only", () => {
  withUsageFooter(run(44000, 2400));
  const report = formatUsageReport();
  expect(report).toContain("~44k tokens read locally");
  expect(report).toContain("~2.4k tokens returned");
  expect(report).toContain("~2.4k is what actually stayed off the frontier model");
  expect(report).not.toContain("46k");
});

test("counters accumulate across runs", () => {
  withUsageFooter(run(1000, 100));
  withUsageFooter(run(2000, 200));
  expect(getSessionStats()).toEqual({ taskCount: 2, promptTokens: 3000, completionTokens: 300 });
});

test("report is explicit when nothing has run", () => {
  expect(formatUsageReport()).toBe("locally has not handled any tasks since this server started.");
});

test("footer reports files read and elapsed time", () => {
  const out = withUsageFooter(run(1000, 100, { durationMs: 200_000, filesRead: 12 }));
  expect(out).toContain("12 files read");
  expect(out).toContain("3m20s");
});

test("footer pluralises a single file read", () => {
  expect(withUsageFooter(run(1000, 100, { filesRead: 1 }))).toContain("1 file read");
});

test("footer says nothing about the cap on a run that finished on its own", () => {
  expect(withUsageFooter(run(1000, 100))).not.toContain("hit cap");
});

test("footer flags a run that ran out of iterations", () => {
  // A capped run stopped because it ran out of budget, not because it was done — the caller
  // cannot otherwise tell the two apart (issue #13).
  const out = withUsageFooter(run(1000, 100, { cappedAtMaxIterations: true }));
  expect(out).toContain("3 iters (hit cap)");
});

test("footer renders sub-minute runs in seconds", () => {
  expect(withUsageFooter(run(1000, 100, { durationMs: 45_400 }))).toContain("45s");
});
