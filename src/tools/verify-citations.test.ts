import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCitations, formatCitationReport, extractCitations } from "./verify-citations.js";
import { resolveRoots } from "./sandbox.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "locally-cite-")));
mkdirSync(join(base, "src"));
writeFileSync(join(base, "src", "app.ts"), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
mkdirSync(join(base, "features", "chunks"), { recursive: true });
writeFileSync(join(base, "features", "chunks", "ChunkSetPage.tsx"), "x\n".repeat(80));

const roots = resolveRoots([base]);

test("accepts a citation whose line is in range", async () => {
  const checks = await verifyCitations("See src/app.ts:12 for the handler.", roots);
  expect(checks[0]).toMatchObject({ citation: "src/app.ts:12", ok: true });
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
  // Silence here used to be indistinguishable from a well-cited answer (issue #13). The wording
  // reports on the checker, not the answer: an answer whose citations were all in table cells was
  // told it named no location at all, which was false (issue #16).
  const report = formatCitationReport([]);
  expect(report).toContain("none parsed");
  expect(report).toContain("nothing in this answer was checked");
  expect(report).not.toContain("names no path:line");
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
  expect(out).toContain("points past the end of its file");
  expect(out).toContain("b.ts:900 (file has 40 lines)");
  expect(out).toContain("unverified");
});

test("report separates an invented file from a number past the end", () => {
  // Two different problems for the caller, and until issue #16 they were one undifferentiated count.
  const out = formatCitationReport([
    { citation: "ghost.ts:1", ok: false, reason: "file not found" },
    { citation: "b.ts:900", ok: false, reason: "file has 40 lines" },
  ]);
  expect(out).toContain("1 names a file that does not exist");
  expect(out).toContain("ghost.ts:1");
  expect(out).toContain("1 points past the end of its file");
});

// --- short paths --------------------------------------------------------------
// A model that writes `agent-loop.ts:107` instead of `src/llm/agent-loop.ts:107` is being
// sloppy, not fabricating. Reporting that as "file not found" flagged 49 of 68 correct
// citations in one eval run and buried the ones that were genuinely wrong.

test("resolves a bare filename that matches one file in the tree", async () => {
  const checks = await verifyCitations("See app.ts:3 for the handler.", roots);
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ citation: "app.ts:3", ok: true });
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
  // One match in the tree, so the report can name its length rather than shrug.
  expect(checks[0].reason).toBe("file has 40 lines");
});

test("does not match a filename on a partial segment", async () => {
  // "pp.ts" must not resolve to "app.ts" — the suffix has to start at a path boundary.
  const checks = await verifyCitations("See pp.ts:3.", roots);
  expect(checks[0].ok).toBe(false);
});

// --- citation forms -----------------------------------------------------------
// Issue #16 run A wrote every citation into a `| File | Line |` table and prose ranges, and an
// inline-only extractor read none of them — so a heavily-cited answer was reported as citing nothing.

test("reads a path:start-end range", async () => {
  const checks = await verifyCitations("The handler spans src/app.ts:12-30.", roots);
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ citation: "src/app.ts:12-30", ok: true });
});

test("flags a range whose end runs past the file", async () => {
  const checks = await verifyCitations("src/app.ts:30-450 holds it.", roots);
  expect(checks[0].ok).toBe(false);
  expect(checks[0].reason).toBe("file has 40 lines");
});

test("reads a markdown table row pairing a file cell with a line cell", async () => {
  const text = ["| File | Line |", "| --- | --- |", "| `src/app.ts` | 12 |"].join("\n");
  const checks = await verifyCitations(text, roots);
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ citation: "src/app.ts:12", ok: true });
});

test("reads a table cell holding a line range", () => {
  const text = "| src/app.ts | lines 26-30 | validates chunks |";
  expect(extractCitations(text)).toEqual([{ path: "src/app.ts", line: 26, endLine: 30 }]);
});

test("does not manufacture a citation from a table with no line column", () => {
  // A summary table's counts are not line numbers; only a cell holding nothing but a number counts.
  const text = "| `src/app.ts` | 12 tables | exports the schema |";
  expect(extractCitations(text)).toEqual([]);
});

test("does not pair a line cell with an ambiguous row of two paths", () => {
  const text = "| `src/app.ts` | `src/other.ts` | 12 |";
  expect(extractCitations(text)).toEqual([]);
});

test("reads a prose line reference", () => {
  expect(extractCitations("The subsystem lives in src/app.ts, lines 26-30.")).toEqual([
    { path: "src/app.ts", line: 26, endLine: 30 },
  ]);
});

test("does not read a prose reference across a line break", () => {
  expect(extractCitations("Defined in src/app.ts\nSomething else at lines 26-30.")).toEqual([]);
});

test("does not read table or prose forms inside a fenced block", () => {
  const text = ["```", "| example.ts | 12 |", "see other.ts, line 4", "```"].join("\n");
  expect(extractCitations(text)).toEqual([]);
});

test("still reads an inline citation inside a fenced block", () => {
  // Inline path:line in a fence is usually pasted tool output, which is a real citation.
  expect(extractCitations("```\nsrc/app.ts:12: const x = 1\n```")).toEqual([
    { path: "src/app.ts", line: 12 },
  ]);
});

test("deduplicates the same location written in two forms", async () => {
  const text = ["src/app.ts:12 is the handler.", "", "| `src/app.ts` | 12 |"].join("\n");
  expect(await verifyCitations(text, roots)).toHaveLength(1);
});

// --- resolution base ----------------------------------------------------------
// Issue #16 run B mapped `apps/web/src/features` and cited bare basenames from it. Resolving those
// against the repository root alone found nothing, and all 19 correct citations were called missing.

test("resolves a bare basename against the mapped task path first", async () => {
  const checks = await verifyCitations("See ChunkSetPage.tsx:47.", roots, join(base, "features", "chunks"));
  expect(checks[0]).toMatchObject({ citation: "ChunkSetPage.tsx:47", ok: true });
});

test("resolves a basename from a mapped subdirectory even without the task path", async () => {
  // The targeted by-name search is what makes this work with no index to fall out of.
  const checks = await verifyCitations("See ChunkSetPage.tsx:47.", roots);
  expect(checks[0].ok).toBe(true);
});

test("a task path outside the roots does not smuggle a file in", async () => {
  const checks = await verifyCitations("See passwd.txt:1.", roots, "/etc");
  expect(checks[0]).toMatchObject({ ok: false, reason: "file not found" });
});
