import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepFiles, globFiles, findFilesNamed, buildTree, IGNORED_DIRS, resetRipgrepCache } from "./explore-files.js";
import { gitIgnoreView } from "./git-ignore.js";

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
    expect(out).toContain("## Search (grep,");
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

// --- git-backed fixture (issue #22) ----------------------------------------------
// Every fixture above is a bare mkdtemp with no .git, where git has no opinion and the tools
// behave as they always did. That is exactly why the gap shipped: the map, Read, Grep and Glob
// disagreed about which files existed, and nothing here could see it.
//
// `--exclude-standard` honours the tester's own global excludes, so neutralise them first.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

const gitBase = realpathSync(mkdtempSync(join(tmpdir(), "locally-gitexplore-")));
execFileSync("git", ["init", "-q"], { cwd: gitBase });

mkdirSync(join(gitBase, "src"));
mkdirSync(join(gitBase, ".github"));
mkdirSync(join(gitBase, "generated"));
writeFileSync(join(gitBase, ".gitignore"), "generated/\n");
writeFileSync(join(gitBase, "src", "app.ts"), "export const needle = 1;\n");
writeFileSync(join(gitBase, ".github", "ci.yml"), "name: needle\n");
writeFileSync(join(gitBase, "generated", "out.ts"), "export const onlyInGenerated = 1;\nconst needle = 2;\n");

/** Run a block with ripgrep off PATH, so the grep/walkFiles backend answers instead. */
async function withoutRipgrep<T>(fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  const stub = mkdtempSync(join(tmpdir(), "locally-greponly-"));
  symlinkSync(execSync("which grep").toString().trim(), join(stub, "grep"));
  symlinkSync(execSync("which git").toString().trim(), join(stub, "git"));
  process.env.PATH = stub;
  resetRipgrepCache();
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
    resetRipgrepCache();
  }
}

test("Grep searches hidden files — they are source, not build output", async () => {
  const out = await grepFiles({ path: gitBase, pattern: "needle" });
  expect(out).toContain(".github/ci.yml");
  expect(out).toContain("src/app.ts");
});

test("Grep skips gitignored files and says which filter ran", async () => {
  const out = await grepFiles({ path: gitBase, pattern: "needle" });
  expect(out).not.toContain("generated/out.ts");
  expect(out).toContain("git's ignore rules honoured");
});

test("a search that finds nothing widens past the ignore rules and labels the result", async () => {
  const out = await grepFiles({ path: gitBase, pattern: "onlyInGenerated" });
  expect(out).toContain("generated/out.ts");
  expect(out).toContain("widened past git's ignore rules");
});

test("include_ignored reaches a gitignored file without needing the first pass to fail", async () => {
  const out = await grepFiles({ path: gitBase, pattern: "needle", include_ignored: true });
  expect(out).toContain("generated/out.ts");
  expect(out).toContain("src/app.ts");
  expect(out).toContain("ignore rules off");
});

test("a name that is nowhere still reports no results after both passes", async () => {
  const out = await grepFiles({ path: gitBase, pattern: "definitelyAbsentToken" });
  expect(out).toContain("(no results)");
});

// `--hidden` un-hides .git as readily as .github, and rg does not special-case it. Keeping .git in
// IGNORED_DIRS is the only thing standing between a search and several hundred loose git objects,
// on both passes.
test(".git never leaks into results, at any width", async () => {
  for (const params of [
    { path: gitBase, pattern: "ref:" },
    { path: gitBase, pattern: "ref:", include_ignored: true },
  ]) {
    const out = await grepFiles(params);
    expect(out).not.toContain("/.git/");
  }
  const listing = await globFiles({ path: gitBase, include_ignored: true });
  expect(listing).not.toContain("/.git/");
});

test("Glob lists hidden files and omits gitignored ones", async () => {
  const out = await globFiles({ path: gitBase, pattern: "*.yml" });
  expect(out).toContain(".github/ci.yml");
  const all = await globFiles({ path: gitBase, pattern: "*.ts" });
  expect(all).toContain("src/app.ts");
  expect(all).not.toContain("generated/out.ts");
});

test("the directory map describes the same tree the search does", async () => {
  const view = await gitIgnoreView(gitBase);
  const tree = await buildTree(gitBase, 5, IGNORED_DIRS, view);
  expect(tree).toContain(".github");
  expect(tree).toContain("app.ts");
  // The map used to advertise this file while no search could reach it — issue #22 itself.
  expect(tree).not.toContain("out.ts");
});

// Without ripgrep, `grep -rn` honours neither .gitignore nor hidden-file rules, so the two backends
// used to give different answers to the same question. The issue's "Not covered here" note.
test("the grep backend filters the same way ripgrep does", async () => {
  await withoutRipgrep(async () => {
    const out = await grepFiles({ path: gitBase, pattern: "needle" });
    expect(out).toContain("## Search (grep,");
    expect(out).toContain(".github/ci.yml");
    expect(out).not.toContain("generated/out.ts");
    expect(out).toContain("git's ignore rules honoured");
  });
});

test("the grep backend widens on an empty result too", async () => {
  await withoutRipgrep(async () => {
    const out = await grepFiles({ path: gitBase, pattern: "onlyInGenerated" });
    expect(out).toContain("generated/out.ts");
    expect(out).toContain("widened past git's ignore rules");
  });
});

test("the Node walk backend filters the same way ripgrep does", async () => {
  await withoutRipgrep(async () => {
    const out = await globFiles({ path: gitBase, pattern: "*.ts" });
    expect(out).toContain("src/app.ts");
    expect(out).not.toContain("generated/out.ts");
  });
});

test("context lines survive the grep filter without leaving orphan separators", async () => {
  await withoutRipgrep(async () => {
    const out = await grepFiles({ path: gitBase, pattern: "needle", "-C": 1 });
    expect(out).toContain("src/app.ts");
    expect(out).not.toContain("generated/out.ts");
    // A "--" with nothing kept on one side of it is a block we dropped.
    expect(out.split("\n").filter(Boolean).at(-1)).not.toBe("--");
  });
});
