import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCitations, formatCitationReport } from "./verify-citations.js";
import { resolveRoots } from "./sandbox.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "locally-cite-")));
mkdirSync(join(base, "src"));
writeFileSync(join(base, "src", "app.ts"), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));

const roots = resolveRoots([base]);

test("accepts a citation whose line is in range", async () => {
  const checks = await verifyCitations("See src/app.ts:12 for the handler.", roots);
  expect(checks).toEqual([{ citation: "src/app.ts:12", ok: true }]);
});

test("flags a line past the end of the file", async () => {
  const checks = await verifyCitations("Defined at src/app.ts:900.", roots);
  expect(checks[0].ok).toBe(false);
  expect(checks[0].reason).toBe("file has 40 lines");
});

test("flags a file that does not exist", async () => {
  const checks = await verifyCitations("Look in src/imaginary.ts:3.", roots);
  expect(checks[0]).toEqual({ citation: "src/imaginary.ts:3", ok: false, reason: "file not found" });
});

test("rejects a citation that escapes the roots", async () => {
  const checks = await verifyCitations("See ../../etc/passwd.txt:1", roots);
  expect(checks[0].ok).toBe(false);
});

test("resolves absolute citations", async () => {
  const checks = await verifyCitations(`At ${join(base, "src", "app.ts")}:40.`, roots);
  expect(checks[0].ok).toBe(true);
});

test("deduplicates repeated citations", async () => {
  const checks = await verifyCitations("src/app.ts:12 and again src/app.ts:12", roots);
  expect(checks).toHaveLength(1);
});

test("ignores URLs and version-like text", async () => {
  const checks = await verifyCitations("See https://example.com:8080/x and v1.2:3", roots);
  expect(checks).toHaveLength(0);
});

test("report is empty when nothing was cited", () => {
  expect(formatCitationReport([])).toBe("");
});

test("report confirms a clean set", () => {
  expect(formatCitationReport([{ citation: "a.ts:1", ok: true }])).toContain("all resolve");
});

test("report names each failure and warns the caller", () => {
  const out = formatCitationReport([
    { citation: "a.ts:1", ok: true },
    { citation: "b.ts:900", ok: false, reason: "file has 40 lines" },
  ]);
  expect(out).toContain("2 citations checked");
  expect(out).toContain("1 did not resolve");
  expect(out).toContain("b.ts:900 (file has 40 lines)");
  expect(out).toContain("unverified");
});
