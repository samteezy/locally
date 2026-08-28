import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPaths, isPathToken, verifyPaths, formatPathReport } from "./verify-paths.js";
import { resolveRoots } from "./sandbox.js";

let base: string;
let roots: string[];

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "locally-paths-")));
  mkdirSync(join(base, "schemas"), { recursive: true });
  writeFileSync(join(base, "schemas", "corpus.ts"), "export const corpus = 1;\n");
  writeFileSync(join(base, "schemas", "chunkSet.ts"), "export const chunkSet = 1;\n");
  roots = resolveRoots([base]);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

// --- extraction ---------------------------------------------------------------

test("accepts a filename with a source extension", () => {
  expect(isPathToken("chunk.ts")).toBe(true);
  expect(isPathToken("chunkSets/processor.test.ts")).toBe(true);
  expect(isPathToken("src/db/schema.sql")).toBe(true);
});

test("rejects tokens that only look like paths", () => {
  // Every one of these appears in ordinary answer prose; a warning about any of them would cost
  // more than the files it would catch.
  expect(isPathToken("Node.js")).toBe(false);
  expect(isPathToken("Vue.js")).toBe(false);
  expect(isPathToken("socket.io")).toBe(false);
  expect(isPathToken("v1.2")).toBe(false);
  expect(isPathToken("some.unknownext")).toBe(false);
  expect(isPathToken("src/*.ts")).toBe(false);
  expect(isPathToken("2.ts")).toBe(false);
  expect(isPathToken("rka_corpus_reports")).toBe(false);
});

test("reads paths from code spans and table cells", () => {
  const text = ["Schemas live in `schemas/corpus.ts`.", "", "| `schemas/chunk.ts` | validates chunks |"].join("\n");
  expect(extractPaths(text)).toEqual(["schemas/corpus.ts", "schemas/chunk.ts"]);
});

test("ignores a path written in bare prose", () => {
  // Not set apart, so not an assertion that the file exists.
  expect(extractPaths("The schemas/corpus.ts pattern is used throughout.")).toEqual([]);
});

test("ignores fenced blocks", () => {
  expect(extractPaths("```\nimport x from 'imaginary/thing.ts';\n```")).toEqual([]);
});

test("strips a line number so a citation is checked once, as a path", () => {
  expect(extractPaths("`schemas/corpus.ts:12`")).toEqual(["schemas/corpus.ts"]);
});

test("deduplicates repeats", () => {
  expect(extractPaths("`chunk.ts` and `chunk.ts` again")).toEqual(["chunk.ts"]);
});

// --- existence ----------------------------------------------------------------
// Issue #16 run A named 7 Zod schema files that do not exist, one per real database table, each
// with a plausible description. It never opened the directory.

test("flags a file that exists nowhere in the tree", async () => {
  const checks = await verifyPaths("The schema is `schemas/document.ts`.", roots);
  expect(checks).toEqual([{ path: "schemas/document.ts", exists: false }]);
});

test("passes a file that exists, cited short", async () => {
  const checks = await verifyPaths("The schema is `corpus.ts`.", roots);
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ path: "corpus.ts", exists: true });
});

test("resolves against the mapped task path", async () => {
  const checks = await verifyPaths("See `chunkSet.ts`.", roots, join(base, "schemas"));
  expect(checks[0].exists).toBe(true);
});

test("skips paths another check already reported", async () => {
  const text = "`schemas/document.ts` and `schemas/ghost.ts`";
  const checks = await verifyPaths(text, roots, undefined, new Set(["schemas/document.ts"]));
  expect(checks).toEqual([{ path: "schemas/ghost.ts", exists: false }]);
});

test("nothing to check returns nothing", async () => {
  expect(await verifyPaths("No paths here at all.", roots)).toEqual([]);
});

// --- report -------------------------------------------------------------------

test("a clean run says nothing", () => {
  expect(formatPathReport([{ path: "corpus.ts", exists: true }])).toBe("");
  expect(formatPathReport([])).toBe("");
});

test("names every missing file", () => {
  const out = formatPathReport([
    { path: "corpus.ts", exists: true },
    { path: "chunk.ts", exists: false },
    { path: "document.ts", exists: false },
  ]);
  expect(out).toContain("3 file paths checked");
  expect(out).toContain("**2 do not exist anywhere in the tree**");
  expect(out).toContain("`chunk.ts`, `document.ts`");
  expect(out).toContain("Treat the claims describing them as invented");
});

test("uses the singular for one missing file", () => {
  const out = formatPathReport([{ path: "chunk.ts", exists: false }]);
  expect(out).toContain("**1 does not exist anywhere in the tree**");
});
