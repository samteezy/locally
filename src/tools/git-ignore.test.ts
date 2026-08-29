import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIgnoreView, viewDenies, resetGitCache } from "./git-ignore.js";

// `--exclude-standard` honours the *tester's* global excludes and system config, so a developer
// with `*.log` in ~/.config/git/ignore would see different results from CI. Neutralise both before
// anything spawns git; execFile inherits process.env, so this covers the module's own calls too.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

/**
 * A repository, not a commit. `git init` alone is enough for `ls-files --others`, which is what
 * keeps this fixture from needing a configured user.name/user.email.
 */
const repo = mkdtempSync(join(tmpdir(), "locally-gitignore-"));
execFileSync("git", ["init", "-q"], { cwd: repo });

mkdirSync(join(repo, "src"));
mkdirSync(join(repo, ".github"));
mkdirSync(join(repo, "generated"));
writeFileSync(join(repo, ".gitignore"), "generated/\n*.log\n");
writeFileSync(join(repo, "src", "alpha.ts"), "export const needle = 1;\n");
writeFileSync(join(repo, ".github", "workflow.yml"), "name: ci\n");
writeFileSync(join(repo, "generated", "schema.ts"), "export const generated = 1;\n");
writeFileSync(join(repo, "debug.log"), "noise\n");

// A nested .gitignore with a negation — the case a hand-rolled parser gets wrong, and the reason
// this shells out to git rather than reading the files itself.
mkdirSync(join(repo, "vendor"));
writeFileSync(join(repo, "vendor", ".gitignore"), "*\n!important.ts\n");
writeFileSync(join(repo, "vendor", "bulk.ts"), "// ignored\n");
writeFileSync(join(repo, "vendor", "important.ts"), "// kept by negation\n");

const bare = mkdtempSync(join(tmpdir(), "locally-nogit-"));
writeFileSync(join(bare, "alpha.ts"), "export const needle = 1;\n");

test("a directory outside any repository gets no view", async () => {
  expect(await gitIgnoreView(bare)).toBeNull();
});

test("gitignored files and directories are denied", async () => {
  const view = await gitIgnoreView(repo);
  expect(view).not.toBeNull();
  expect(viewDenies(view, "generated")).toBe(true);
  expect(viewDenies(view, "debug.log")).toBe(true);
});

test("ordinary and hidden source is not denied", async () => {
  const view = await gitIgnoreView(repo);
  expect(viewDenies(view, "src/alpha.ts")).toBe(false);
  // Hidden, but ordinary source — the half of issue #22 with no argument on the other side.
  expect(viewDenies(view, ".github/workflow.yml")).toBe(false);
  expect(viewDenies(view, ".gitignore")).toBe(false);
});

test("a file inside a denied directory is denied through its ancestor", async () => {
  const view = await gitIgnoreView(repo);
  // --directory collapses the whole tree to "generated"; nothing lists the file itself.
  expect(view!.denied.has("generated/schema.ts")).toBe(false);
  expect(viewDenies(view, "generated/schema.ts")).toBe(true);
  expect(viewDenies(view, "generated/deep/nested/x.ts")).toBe(true);
});

test("--directory collapses an ignored tree instead of enumerating it", async () => {
  const view = await gitIgnoreView(repo);
  expect(view!.denied.has("generated")).toBe(true);
  expect([...view!.denied].some((d) => d.startsWith("generated/"))).toBe(false);
});

test("a nested .gitignore and its negation are both honoured", async () => {
  const view = await gitIgnoreView(repo);
  expect(viewDenies(view, "vendor/bulk.ts")).toBe(true);
  expect(viewDenies(view, "vendor/important.ts")).toBe(false);
});

test("a tracked file matching an ignore rule stays visible", async () => {
  const forced = mkdtempSync(join(tmpdir(), "locally-forced-"));
  execFileSync("git", ["init", "-q"], { cwd: forced });
  mkdirSync(join(forced, "dist"));
  writeFileSync(join(forced, ".gitignore"), "dist/\n");
  writeFileSync(join(forced, "dist", "keep.js"), "// checked in on purpose\n");
  execFileSync("git", ["add", "-f", "dist/keep.js"], { cwd: forced });

  const view = await gitIgnoreView(forced);
  expect(viewDenies(view, "dist/keep.js")).toBe(false);
});

/**
 * git reports a submodule as a single gitlink, so an allow-list built from `ls-files --cached
 * --others` would have contained `vendored` and nothing beneath it — hiding every file in the
 * submodule from the map and from Glob while `Read` opened them happily. That is the bug issue #22
 * exists to fix, and it is why this is a deny set.
 */
test("a submodule's contents are not denied", async () => {
  const sub = mkdtempSync(join(tmpdir(), "locally-sub-"));
  execFileSync("git", ["init", "-q"], { cwd: sub });
  writeFileSync(join(sub, "deep.ts"), "export const insideSubmodule = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: sub });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], { cwd: sub });

  const outer = mkdtempSync(join(tmpdir(), "locally-outer-"));
  execFileSync("git", ["init", "-q"], { cwd: outer });
  execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendored"],
    { cwd: outer }
  );

  const view = await gitIgnoreView(outer);
  expect(viewDenies(view, "vendored/deep.ts")).toBe(false);
});

test("a file path resolves against its own directory rather than failing", async () => {
  const view = await gitIgnoreView(join(repo, "src", "alpha.ts"));
  expect(view).not.toBeNull();
});

test("a null view denies nothing — it never means the tree is empty", () => {
  expect(viewDenies(null, "anything/at/all.ts")).toBe(false);
  expect(viewDenies(null, "node_modules")).toBe(false);
});

test("the root itself is never denied", async () => {
  const view = await gitIgnoreView(repo);
  expect(viewDenies(view, "")).toBe(false);
});

test("without git on PATH there is no view", async () => {
  const originalPath = process.env.PATH;
  const emptyDir = mkdtempSync(join(tmpdir(), "locally-nogitbin-"));
  process.env.PATH = emptyDir;
  resetGitCache();
  try {
    expect(await gitIgnoreView(repo)).toBeNull();
  } finally {
    process.env.PATH = originalPath;
    resetGitCache();
  }
});
