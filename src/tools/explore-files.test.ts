import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepFiles, globFiles, findFilesNamed, resetRipgrepCache } from "./explore-files.js";

const base = mkdtempSync(join(tmpdir(), "locally-explore-"));

mkdirSync(join(base, "src"));
mkdirSync(join(base, "node_modules"));
writeFileSync(join(base, "src", "alpha.ts"), "export const needle = 1;\nconst other = 2;\n");
writeFileSync(join(base, "src", "beta.ts"), "// no match here\n");
writeFileSync(join(base, "src", "notes.md"), "needle appears here too\n");
writeFileSync(join(base, "node_modules", "ignored.ts"), "needle in a vendored file\n");
writeFileSync(join(base, "dashes.ts"), "const flag = '--color=never';\n");

test("Glob lists paths and line counts, never file contents", async () => {
  const out = await globFiles({ path: base });
  expect(out).toContain("## Files");
  expect(out).toMatch(/alpha\.ts · \d+ lines/);
  // The dump is what made one broad call cheaper than several focused searches.
  expect(out).not.toContain("export const needle");
});

test("Glob narrows to a pattern", async () => {
  const out = await globFiles({ path: base, pattern: "*.md" });
  expect(out).toContain("notes.md");
  expect(out).not.toContain("alpha.ts");
});

test("Glob does not re-send the directory tree", async () => {
  // The task prompt already carries one; re-sending it per call is what made a single broad
  // call cheaper than several focused ones.
  const out = await globFiles({ path: base });
  expect(out).not.toContain("## Directory:");
});

test("Grep returns matching lines with line numbers and no directory tree", async () => {
  const out = await grepFiles({ path: base, pattern: "needle" });
  expect(out).toMatch(/alpha\.ts:1:export const needle/);
  // Re-sending the tree on every search is what makes searching look expensive.
  expect(out).not.toContain("## Directory:");
});

test("a pattern starting with a dash is a pattern, not a flag", async () => {
  const out = await grepFiles({ path: base, pattern: "--color" });
  expect(out).toContain("dashes.ts");
  expect(out).not.toContain("unrecognized");
});

test("ignored directories stay out of search results", async () => {
  const out = await grepFiles({ path: base, pattern: "needle" });
  expect(out).not.toContain("node_modules");
});

test("glob narrows the search", async () => {
  const out = await grepFiles({ path: base, pattern: "needle", glob: "*.md" });
  expect(out).toContain("notes.md");
  expect(out).not.toContain("alpha.ts");
});

test("-C pulls in surrounding lines", async () => {
  const out = await grepFiles({ path: base, pattern: "needle", glob: "*.ts", "-C": 1 });
  expect(out).toContain("const other = 2;");
});

test("max_results caps the output and says so", async () => {
  const out = await grepFiles({ path: base, pattern: "needle", max_results: 1 });
  expect(out).toContain("more matching line");
});

test("a pattern with no matches reports that plainly", async () => {
  const out = await grepFiles({ path: base, pattern: "zzz-not-present-zzz" });
  expect(out).toContain("(no results)");
});

test("Glob rejects a path that is not a directory", async () => {
  await expect(globFiles({ path: join(base, "dashes.ts") })).rejects.toThrow(/not a directory/);
});

test("falls back to grep when ripgrep is not on PATH", async () => {
  // A PATH carrying grep but not rg, so the fallback branch is the one exercised.
  const stubBin = mkdtempSync(join(tmpdir(), "locally-bin-"));
  symlinkSync(execSync("command -v grep").toString().trim(), join(stubBin, "grep"));

  const realPath = process.env.PATH;
  process.env.PATH = stubBin;
  resetRipgrepCache();
  try {
    const out = await grepFiles({ path: base, pattern: "needle" });
    expect(out).toContain("## Search (grep)");
    expect(out).toMatch(/alpha\.ts:1:/);
    expect(out).not.toContain("node_modules");
  } finally {
    process.env.PATH = realPath;
    resetRipgrepCache();
  }
});

// --- findFilesNamed -------------------------------------------------------------
// How the verifiers resolve a path the model wrote short. It replaced a whole-tree index capped at
// 20,000 paths, which in a monorepo could drop an entire subtree and report every citation into it
// as a missing file (issue #16).

test("finds a file anywhere under the root by name", async () => {
  const found = await findFilesNamed(base, "alpha.ts");
  expect(found).toEqual([join(base, "src", "alpha.ts")]);
});

test("matches the whole name, not a fragment of it", async () => {
  expect(await findFilesNamed(base, "lpha.ts")).toEqual([]);
});

test("skips ignored directories", async () => {
  expect(await findFilesNamed(base, "ignored.ts")).toEqual([]);
});

test("finds nothing for a name that is not there", async () => {
  expect(await findFilesNamed(base, "nowhere.ts")).toEqual([]);
});

test("falls back to the Node walk without ripgrep", async () => {
  const originalPath = process.env.PATH;
  const emptyDir = mkdtempSync(join(tmpdir(), "locally-nopath-"));
  process.env.PATH = emptyDir;
  resetRipgrepCache();
  try {
    expect(await findFilesNamed(base, "alpha.ts")).toEqual([join(base, "src", "alpha.ts")]);
  } finally {
    process.env.PATH = originalPath;
    resetRipgrepCache();
  }
});

// Ripgrep resolves overlapping globs last-match-wins, so the ignore globs have to be emitted after
// the positive pattern. listFilesWithRg was fixed for this; the search path had the same bug and
// was missed, so `*.ts` re-admitted node_modules to every filtered Grep.

test("a Glob pattern does not pull ignored directories back in", async () => {
  const out = await globFiles({ path: base, pattern: "*.ts" });
  expect(out).toContain("alpha.ts");
  expect(out).not.toContain("ignored.ts");
});

test("a Grep glob does not pull ignored directories back in", async () => {
  const out = await grepFiles({ path: base, pattern: "needle", glob: "*.ts" });
  expect(out).toContain("alpha.ts");
  expect(out).not.toContain("ignored.ts");
});

test("-i makes the search case-insensitive", async () => {
  expect(await grepFiles({ path: base, pattern: "NEEDLE" })).toContain("(no results)");
  expect(await grepFiles({ path: base, pattern: "NEEDLE", "-i": true })).toContain("alpha.ts");
});
