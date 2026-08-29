import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPairs,
  placementWindow,
  verifyPlacement,
  formatPlacementReport,
} from "./verify-placement.js";
import { resolveRoots } from "./sandbox.js";

let base: string;
let roots: string[];

/**
 * A file of `total` lines with real paragraph structure — a blank every fifth line — and the given
 * content at the given line numbers. Structure matters: the window is read off the file's own
 * blanks and indentation, so a fixture of solid text would not exercise it.
 */
function buildFile(total: number, entries: Record<number, string>, blankEvery = 5): string {
  const lines: string[] = [];
  for (let n = 1; n <= total; n += 1) {
    if (entries[n] !== undefined) lines.push(entries[n]);
    else if (blankEvery > 0 && n % blankEvery === 0) lines.push("");
    else lines.push(`const filler${n} = ${n};`);
  }
  return `${lines.join("\n")}\n`;
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "locally-place-")));
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(base, "dup", "a"), { recursive: true });
  mkdirSync(join(base, "dup", "b"), { recursive: true });

  // Issue #17's Error A, reconstructed: a decoy with a similar name near the cited line, and the
  // real symbol 68 lines further down.
  writeFileSync(
    join(base, "src", "schemas.ts"),
    buildFile(260, {
      129: "export const widgetPerformanceRollup = table('perf');",
      198: "export const widgetRollupSchema = z.object({});",
    })
  );
  writeFileSync(join(base, "src", "neighbour.ts"), buildFile(200, { 130: "export const widgetPerformanceRollupSchema = 1;" }));

  // A 41-line doc comment sitting directly on its export, blank lines either side: the case a flat
  // window of 30 gets wrong and the paragraph walk gets right.
  const doc: Record<number, string> = { 99: "", 100: "/**" };
  for (let n = 101; n <= 139; n += 1) doc[n] = ` * documentation line ${n}`;
  doc[140] = " */";
  doc[141] = "export const documentedThing = 1;";
  for (let n = 142; n <= 160; n += 1) doc[n] = `  const inner${n} = ${n};`;
  doc[161] = "";
  writeFileSync(join(base, "src", "documented.ts"), buildFile(200, doc));

  // No blank lines at all — generated or minified, and the structural window degenerates on it.
  const dense: Record<number, string> = { 190: "export const denseThing = 1;" };
  writeFileSync(join(base, "src", "dense.ts"), buildFile(200, dense, 0));

  // A name so common in its file that its absence from any one window proves nothing.
  const common: Record<number, string> = {};
  for (let n = 1; n <= 30; n += 1) common[n * 6] = `use(commonThing, ${n});`;
  writeFileSync(join(base, "src", "common.ts"), buildFile(220, common));

  // Two files with one basename: no way to tell which was meant.
  writeFileSync(join(base, "dup", "a", "shared.ts"), buildFile(200, { 180: "export const sharedThing = 1;" }));
  writeFileSync(join(base, "dup", "b", "shared.ts"), buildFile(200, { 190: "export const sharedThing = 2;" }));

  roots = resolveRoots([base]);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

// --- pairing ------------------------------------------------------------------

test("pairs the first distinctive token of a block note with that entry's location", () => {
  const pairs = extractPairs("<citations>\nsrc/schemas.ts:130 widgetRollupSchema definition\n</citations>");
  expect(pairs).toEqual([
    { symbol: "widgetRollupSchema", citation: { path: "src/schemas.ts", line: 130, note: "widgetRollupSchema definition" }, label: "src/schemas.ts:130" },
  ]);
});

test("takes only the first candidate in a note", () => {
  // The leading token is the subject being located; the ones after it are context whose own
  // locations are elsewhere by design, and checking those is the invented-relationship trap.
  const pairs = extractPairs("<citations>\nsrc/config.ts:50 LocallyConfig built by resolveAgentConfig\n</citations>");
  expect(pairs.map((p) => p.symbol)).toEqual(["LocallyConfig"]);
});

test("pairs an answer line carrying one citation and one backticked name", () => {
  const pairs = extractPairs("The `widgetRollupSchema` is defined at src/schemas.ts:130.");
  expect(pairs.map((p) => p.symbol)).toEqual(["widgetRollupSchema"]);
});

test("refuses a line with two distinct backticked names", () => {
  expect(extractPairs("`alphaSchema` and `betaSchema` both sit in src/schemas.ts:130.")).toEqual([]);
});

test("refuses a line with two citations", () => {
  expect(extractPairs("`alphaSchema` spans src/schemas.ts:130 and src/neighbour.ts:12.")).toEqual([]);
});

test("reads a markdown table row as one line", () => {
  const pairs = extractPairs("| `widgetRollupSchema` | src/schemas.ts:130 | the rollup |");
  expect(pairs.map((p) => p.symbol)).toEqual(["widgetRollupSchema"]);
});

test("ignores bare prose tokens outside a block", () => {
  // Only what the model set apart counts, the same rule verify-symbols.ts follows.
  expect(extractPairs("The widgetRollupSchema is defined at src/schemas.ts:130.")).toEqual([]);
});

test("reads nothing inside a fenced block", () => {
  expect(extractPairs("```\nThe `widgetRollupSchema` is at src/schemas.ts:130.\n```")).toEqual([]);
});

test("skips a claim the model hedged with LIKELY:", () => {
  expect(extractPairs("LIKELY: `widgetRollupSchema` is at src/schemas.ts:130.")).toEqual([]);
});

test("generic names are not paired", () => {
  expect(extractPairs("The `path` is read at src/schemas.ts:130.")).toEqual([]);
});

// --- the window ---------------------------------------------------------------

test("the window reaches the floor in both directions", () => {
  const lines = buildFile(300, {}).split("\n");
  expect(placementWindow(lines, 150, 150)).toEqual([120, 180]);
});

test("the window absorbs a paragraph that runs past the floor", () => {
  // Lines 100-160 are one unbroken paragraph with a blank either side. All of it is in range from
  // line 100, though its end is 60 lines away and the floor is 30.
  const entries: Record<number, string> = { 99: "", 161: "" };
  for (let n = 100; n <= 160; n += 1) entries[n] = `const inBlock${n} = ${n};`;
  const lines = buildFile(200, entries).split("\n");
  // 161 rather than 160: the trailing blank is swept up with the block, which costs nothing.
  expect(placementWindow(lines, 100, 100)).toEqual([70, 161]);
});

test("the window absorbs a doc comment separated from its code by a blank line", () => {
  // The paragraph walk alone stops at the blank; the comment-header step reaches across it.
  const entries: Record<number, string> = { 59: "", 96: "", 101: "" };
  for (let n = 60; n <= 95; n += 1) entries[n] = ` * documentation line ${n}`;
  for (let n = 97; n <= 100; n += 1) entries[n] = `const code${n} = ${n};`;
  const lines = buildFile(200, entries).split("\n");
  const [top] = placementWindow(lines, 100, 100);
  expect(top).toBeLessThanOrEqual(60);
});

// --- verdicts -----------------------------------------------------------------

test("flags a symbol its cited file keeps 68 lines away", async () => {
  // Issue #17's Error A. Neither existing check sees it: line 130 exists, and the name exists.
  const { checks } = await verifyPlacement("<citations>\nsrc/schemas.ts:130 widgetRollupSchema definition\n</citations>", roots);
  expect(checks).toEqual([
    { symbol: "widgetRollupSchema", label: "src/schemas.ts:130", agrees: false, nearestLine: 198 },
  ]);
});

test("passes the same symbol cited where it lives", async () => {
  const { checks } = await verifyPlacement("<citations>\nsrc/schemas.ts:198 widgetRollupSchema definition\n</citations>", roots);
  expect(checks).toEqual([{ symbol: "widgetRollupSchema", label: "src/schemas.ts:198", agrees: true }]);
});

test("passes a citation within the floor of the symbol", async () => {
  const { checks } = await verifyPlacement("<citations>\nsrc/schemas.ts:225 widgetRollupSchema definition\n</citations>", roots);
  expect(checks[0].agrees).toBe(true);
});

test("passes a citation to the opening line of a long doc comment", async () => {
  // 41 lines of JSDoc above the export — further than the floor, and correct. Structure, not a flat
  // count, is what keeps this silent.
  const { checks } = await verifyPlacement("<citations>\nsrc/documented.ts:100 documentedThing definition\n</citations>", roots);
  expect(checks).toEqual([{ symbol: "documentedThing", label: "src/documented.ts:100", agrees: true }]);
});

test("stays silent when the symbol is absent from the cited file", async () => {
  // The load-bearing rule, and the cross-file half of Error A. verify-symbols.ts owns whether the
  // name exists in the tree; this check owns nothing until the cited file has vouched for it.
  const { checks } = await verifyPlacement(
    "<citations>\nsrc/schemas.ts:130 widgetPerformanceRollupSchema re-export\n</citations>",
    roots
  );
  expect(checks).toEqual([]);
});

test("stays silent on a misspelled name against a correct line", async () => {
  // Five citations in one real eval run named `LOCALY_…` with one L, all with correct line numbers.
  // Warning about those would be issue #17 happening again inside its own fix.
  const { checks } = await verifyPlacement("<citations>\nsrc/schemas.ts:198 widgetRollupSchemaa definition\n</citations>", roots);
  expect(checks).toEqual([]);
});

test("a substring match counts as present", async () => {
  const { checks } = await verifyPlacement("<citations>\nsrc/schemas.ts:198 widgetRollup definition\n</citations>", roots);
  expect(checks).toEqual([{ symbol: "widgetRollup", label: "src/schemas.ts:198", agrees: true }]);
});

test("stays silent when the name is all over the file", async () => {
  const { checks } = await verifyPlacement("<citations>\nsrc/common.ts:12 commonThing definition\n</citations>", roots);
  expect(checks).toEqual([]);
});

test("stays silent when the path could mean two files", async () => {
  const { checks } = await verifyPlacement("<citations>\nshared.ts:20 sharedThing definition\n</citations>", roots);
  expect(checks).toEqual([]);
});

test("stays silent when the path names no file", async () => {
  const { checks } = await verifyPlacement("<citations>\nsrc/ghost.ts:20 ghostThing definition\n</citations>", roots);
  expect(checks).toEqual([]);
});

test("stays silent on a file with no blank lines", async () => {
  const { checks } = await verifyPlacement("<citations>\nsrc/dense.ts:100 denseThing definition\n</citations>", roots);
  expect(checks).toEqual([]);
});

test("stays silent on a citation another check already reported", async () => {
  const skip = new Set(["src/schemas.ts:130"]);
  const { checks } = await verifyPlacement(
    "<citations>\nsrc/schemas.ts:130 widgetRollupSchema definition\n</citations>",
    roots,
    undefined,
    skip
  );
  expect(checks).toEqual([]);
});

test("stays silent when the cited line is past the end of the file", async () => {
  // The citation check owns that failure and already names it.
  const { checks } = await verifyPlacement("<citations>\nsrc/schemas.ts:9000 widgetRollupSchema definition\n</citations>", roots);
  expect(checks).toEqual([]);
});

test("stays silent on line 1 and on a range covering the file", async () => {
  const one = await verifyPlacement("<citations>\nsrc/schemas.ts:1 widgetRollupSchema definition\n</citations>", roots);
  expect(one.checks).toEqual([]);
  const whole = await verifyPlacement("<citations>\nsrc/schemas.ts:2-260 widgetRollupSchema definition\n</citations>", roots);
  expect(whole.checks).toEqual([]);
});

// --- report -------------------------------------------------------------------

test("a clean run says nothing", () => {
  expect(formatPlacementReport({ checks: [{ symbol: "a_b", label: "x.ts:4", agrees: true }], named: 1 })).toBe("");
  expect(formatPlacementReport({ checks: [], named: 0 })).toBe("");
});

test("one miss names the real line and says the file is right", () => {
  const out = formatPlacementReport({
    checks: [{ symbol: "widgetRollupSchema", label: "moduleA.ts:130", agrees: false, nearestLine: 199 }],
    named: 1,
  });
  expect(out).toContain("1 symbol/line pair checked");
  expect(out).toContain("**1 names a symbol that its cited file keeps elsewhere**");
  expect(out).toContain("`widgetRollupSchema` is cited at `moduleA.ts:130`");
  expect(out).toContain("nearest occurrence in that file is line 199");
  expect(out).toContain("The file is right and the line is not");
});

test("several misses are all named, and the passes are not", () => {
  const out = formatPlacementReport({
    checks: [
      { symbol: "fine_one", label: "a.ts:10", agrees: true },
      { symbol: "widgetRollupSchema", label: "moduleA.ts:130", agrees: false, nearestLine: 199 },
      { symbol: "gammaSchema", label: "moduleC.ts:44", agrees: false, nearestLine: 312 },
    ],
    named: 3,
  });
  expect(out).toContain("3 symbol/line pairs checked");
  expect(out).toContain("**2 name symbols their cited files keep elsewhere**");
  expect(out).toContain("nearest occurrence line 312");
  expect(out).not.toContain("fine_one");
});

test("the report says so when the cap truncated the list", () => {
  const out = formatPlacementReport({
    checks: [{ symbol: "a_b", label: "x.ts:4", agrees: false, nearestLine: 90 }],
    named: 60,
  });
  expect(out).toContain("1 of 60 symbol/line pairs checked");
});
