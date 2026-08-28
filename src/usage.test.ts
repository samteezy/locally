import { test, expect, beforeEach } from "vitest";
import { withUsageFooter, formatUsageReport, resetUsage, getSessionStats } from "./usage.js";

beforeEach(() => resetUsage());

const run = (promptTokens: number, completionTokens: number) => ({
  text: "answer",
  model: "test-model",
  promptTokens,
  completionTokens,
  iterations: 3,
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
