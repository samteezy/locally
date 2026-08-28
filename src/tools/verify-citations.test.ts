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

test("an answer that cited nothing is called out, not passed over in silence", () => {
  // Silence here used to be indistinguishable from a well-cited answer (issue #13).
  const report = formatCitationReport([]);
  expect(report).toContain("none");
  expect(report).toContain("Treat it as unverified");
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

// --- short paths --------------------------------------------------------------
// A model that writes `agent-loop.ts:107` instead of `src/llm/agent-loop.ts:107` is being
// sloppy, not fabricating. Reporting that as "file not found" flagged 49 of 68 correct
// citations in one eval run and buried the ones that were genuinely wrong.

test("resolves a bare filename that matches one file in the tree", async () => {
  const checks = await verifyCitations("See app.ts:3 for the handler.", roots);
  expect(checks).toEqual([{ citation: "app.ts:3", ok: true }]);
});

test("resolves a partial path that matches one file in the tree", async () => {
  const checks = await verifyCitations("See src/app.ts:3.", roots);
  expect(checks[0].ok).toBe(true);
});

test("still flags a bare filename that matches nothing", async () => {
  const checks = await verifyCitations("See nowhere.ts:3.", roots);
  expect(checks).toEqual([{ citation: "nowhere.ts:3", ok: false, reason: "file not found" }]);
});

test("flags a line past the end of a file found by short path", async () => {
  const checks = await verifyCitations("See app.ts:9000.", roots);
  expect(checks[0].ok).toBe(false);
  expect(checks[0].reason).toBe("line out of range");
});

test("does not match a filename on a partial segment", async () => {
  // "pp.ts" must not resolve to "app.ts" — the suffix has to start at a path boundary.
  const checks = await verifyCitations("See pp.ts:3.", roots);
  expect(checks[0].ok).toBe(false);
});
