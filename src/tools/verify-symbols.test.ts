import { test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSymbols, verifySymbols, formatSymbolReport } from "./verify-symbols.js";
import { resetRipgrepCache } from "./explore-files.js";

let base: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "locally-symbols-")));
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(
    join(base, "src", "routes.ts"),
    [
      "export const ANALYSIS_PROMPT_VERSION = 'rka-analysis-v1';",
      "export function isEndpointFree(): boolean { return false; }",
      "const rka_chunk_sets_corpus_content_hash_uq = 'index';",
      "import { readFile, READ_FILE_SCHEMA } from './read-file.js';",
    ].join("\n")
  );
});

afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(() => resetRipgrepCache());

// --- extraction ---------------------------------------------------------------

test("picks up snake_case, SCREAMING_SNAKE and camelCase names in backticks", () => {
  const text = "The table `rka_corpus_reports`, the var `ANALYSIS_PROMPT_VERSION`, the flag `endpointFree`.";
  expect(extractSymbols(text)).toEqual([
    "rka_corpus_reports",
    "ANALYSIS_PROMPT_VERSION",
    "endpointFree",
  ]);
});

test("ignores prose outside backticks", () => {
  // Otherwise every paraphrase in the answer becomes a name to look up.
  expect(extractSymbols("The corpus_reports table is built at request time.")).toEqual([]);
});

test("ignores fenced code blocks", () => {
  // These hold examples the model wrote itself, so a miss there proves nothing about the repo.
  const text = "See below.\n\n```ts\nconst made_up_name = 1;\n```\n\nBut `real_thing` is used.";
  expect(extractSymbols(text)).toEqual(["real_thing"]);
});

test("skips short and undistinctive names", () => {
  // "path" matches in every tree, so its presence carries no information.
  expect(extractSymbols("`id`, `ok`, `path`, `query`, `handler`")).toEqual([]);
});

test("skips tokens that are not bare identifiers", () => {
  const text = "`src/app.ts:12`, `rg 'can[A-Z]'`, `npm run build`, `a-b-c`";
  expect(extractSymbols(text)).toEqual([]);
});

test("dedupes repeated names", () => {
  expect(extractSymbols("`my_table` and again `my_table`")).toEqual(["my_table"]);
});

// --- searching ----------------------------------------------------------------

test("flags a name that appears nowhere in the tree", async () => {
  const { checks } = await verifySymbols("The report is stored in `rka_corpus_reports`.", [base]);
  expect(checks).toEqual([{ symbol: "rka_corpus_reports", found: false }]);
});

test("passes a name that really is in the tree", async () => {
  const { checks } = await verifySymbols("Set by `ANALYSIS_PROMPT_VERSION`.", [base]);
  expect(checks).toEqual([{ symbol: "ANALYSIS_PROMPT_VERSION", found: true }]);
});

test("counts a name that only occurs inside a longer identifier as present", async () => {
  // The tree has isEndpointFree, not endpointFree. Matching is substring, not word-boundary,
  // on purpose: a false "does not exist" is the one failure this check cannot afford.
  const { checks } = await verifySymbols("Routes are marked `endpointFree`.", [base]);
  expect(checks).toEqual([{ symbol: "endpointFree", found: true }]);
});

test("a long name is not shadowed by a shorter one it starts with", async () => {
  // The bulk pass uses --only-matching, which reports one match per position: case-insensitively
  // `read_file` sits at position 0 of `READ_FILE_SCHEMA`, so the short name is emitted and the
  // long one never appears in the output. Reported five real constants as fabricated in an eval
  // run before the per-name recheck was added.
  const text = "The tool `read_file` takes the schema `READ_FILE_SCHEMA`.";
  const { checks } = await verifySymbols(text, [base]);
  expect(checks).toEqual([
    { symbol: "read_file", found: true },
    { symbol: "READ_FILE_SCHEMA", found: true },
  ]);
});

test("separates the real and invented names in one answer", async () => {
  const text = "It writes `rka_corpus_reports` guarded by `rka_chunk_sets_corpus_content_hash_uq`.";
  const { checks } = await verifySymbols(text, [base]);
  expect(checks).toEqual([
    { symbol: "rka_corpus_reports", found: false },
    { symbol: "rka_chunk_sets_corpus_content_hash_uq", found: true },
  ]);
});

test("checks nothing when the answer names nothing", async () => {
  expect(await verifySymbols("No distinctive names here.", [base])).toEqual({ checks: [], named: 0 });
});

test("searches every root", async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), "locally-symbols-alt-")));
  try {
    writeFileSync(join(other, "extra.ts"), "const second_root_only = 1;\n");
    const { checks } = await verifySymbols("See `second_root_only`.", [base, other]);
    expect(checks).toEqual([{ symbol: "second_root_only", found: true }]);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("falls back to grep when ripgrep is unavailable", async () => {
  const originalPath = process.env.PATH;
  const stubBin = realpathSync(mkdtempSync(join(tmpdir(), "locally-nobin-")));
  try {
    // A PATH with no rg on it, mirroring the fallback test in explore-files.test.ts.
    process.env.PATH = `${stubBin}:/usr/bin:/bin`;
    resetRipgrepCache();
    const { checks } = await verifySymbols("`ANALYSIS_PROMPT_VERSION` and `rka_corpus_reports`", [base]);
    expect(checks).toEqual([
      { symbol: "ANALYSIS_PROMPT_VERSION", found: true },
      { symbol: "rka_corpus_reports", found: false },
    ]);
  } finally {
    process.env.PATH = originalPath;
    resetRipgrepCache();
    rmSync(stubBin, { recursive: true, force: true });
  }
});

test("stays silent rather than guessing when a root cannot be searched", async () => {
  // An unusable root could be exactly where the name lives, so no report beats a wrong one.
  const { checks } = await verifySymbols("`some_missing_name`", [join(base, "does-not-exist")]);
  expect(checks).toEqual([]);
});

// --- the filtered-search gap (issue #17) --------------------------------------
// ripgrep skips gitignored and hidden files. `buildTree` — the directory map handed to the model —
// and `Read` walk the filesystem and honour only IGNORED_DIRS, so an answer can correctly describe
// a file no default rg search can see, and the checker used to call every name in it invented.
//
// Every other fixture in this file is a bare mkdtemp with no .git and no .gitignore, where ripgrep
// filters nothing. That is why this shipped, so these two need a fixture that does filter.

let filtered: string;

beforeAll(() => {
  filtered = realpathSync(mkdtempSync(join(tmpdir(), "locally-filtered-")));
  // An empty .git is enough for ripgrep to start honouring .gitignore.
  mkdirSync(join(filtered, ".git"), { recursive: true });
  mkdirSync(join(filtered, "generated"), { recursive: true });
  mkdirSync(join(filtered, ".config"), { recursive: true });
  writeFileSync(join(filtered, ".gitignore"), "generated/\n");
  writeFileSync(join(filtered, "generated", "schema.ts"), "export const alpha_items = pgTable('alpha_items');\n");
  writeFileSync(join(filtered, ".config", "wiring.ts"), "export const hiddenDirSymbol = 1;\n");
  // A NUL byte makes both ripgrep and `grep -I` skip the file; Node reads it fine.
  writeFileSync(join(filtered, "odd.ts"), "export const backstop_only_name = 1;\n\u0000\n");
});

afterAll(() => rmSync(filtered, { recursive: true, force: true }));

test("a name defined only in a gitignored file is not called invented", async () => {
  const { checks } = await verifySymbols("The table is `alpha_items`.", [filtered]);
  expect(checks).toEqual([{ symbol: "alpha_items", found: true }]);
});

test("a name defined only under a dot-directory is not called invented", async () => {
  const { checks } = await verifySymbols("Wired by `hiddenDirSymbol`.", [filtered]);
  expect(checks).toEqual([{ symbol: "hiddenDirSymbol", found: true }]);
});

test("a name in a file both search tools refuse to read is found by the backstop", async () => {
  // ripgrep and grep -I both skip a file with a NUL byte in it. `Read` does not, so the model can
  // have read this name legitimately. This is the case the third pass exists for: the gitignore gap
  // is a confirmed cause, but issue #17 came from a private repo whose exact trigger cannot be
  // replayed, so nothing may be reported missing on the word of an external tool alone.
  const { checks } = await verifySymbols("Guarded by `backstop_only_name`.", [filtered]);
  expect(checks).toEqual([{ symbol: "backstop_only_name", found: true }]);
});

test("a genuinely absent name is still reported, filtered fixture or not", async () => {
  const { checks } = await verifySymbols("The table is `never_written_anywhere`.", [filtered]);
  expect(checks).toEqual([{ symbol: "never_written_anywhere", found: false }]);
});

// --- reporting ----------------------------------------------------------------

test("report is silent when every name resolved", () => {
  expect(formatSymbolReport({ checks: [{ symbol: "real_one", found: true }], named: 1 })).toBe("");
});

test("report is silent when nothing was checked", () => {
  expect(formatSymbolReport({ checks: [], named: 0 })).toBe("");
});

test("report names the missing symbols", () => {
  const report = formatSymbolReport({
    checks: [
      { symbol: "real_one", found: true },
      { symbol: "made_up_table", found: false },
      { symbol: "MADE_UP_VAR", found: false },
    ],
    named: 3,
  });
  expect(report).toContain("3 names checked");
  expect(report).toContain("**2 do not appear anywhere in the tree**");
  expect(report).toContain("`made_up_table`");
  expect(report).toContain("`MADE_UP_VAR`");
  expect(report).not.toContain("`real_one`");
});

test("report says so when the cap truncated the list", () => {
  // Issue #17 read "60 names checked" as a count. 60 was the cap, and the answer had named more.
  const report = formatSymbolReport({ checks: [{ symbol: "made_up_table", found: false }], named: 84 });
  expect(report).toContain("1 of 84 names checked");
});

test("report names the search it ran", () => {
  const report = formatSymbolReport({ checks: [{ symbol: "made_up_table", found: false }], named: 1 });
  expect(report).toContain("substring, case-insensitive");
});

test("report reads correctly for a single miss", () => {
  const report = formatSymbolReport({ checks: [{ symbol: "made_up_table", found: false }], named: 1 });
  expect(report).toContain("1 name checked");
  expect(report).toContain("**1 does not appear anywhere in the tree**");
});
