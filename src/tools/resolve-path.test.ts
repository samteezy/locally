import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileResolver } from "./resolve-path.js";
import { resolveRoots } from "./sandbox.js";

let base: string;
let roots: string[];

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "locally-resolve-")));
  // Deeply nested, and named the same as a file near the top: the two cases a bare basename has
  // to survive — one that a truncated tree index would have missed, one that is ambiguous.
  mkdirSync(join(base, "apps", "web", "src", "features", "chunks"), { recursive: true });
  mkdirSync(join(base, "server", "chunks"), { recursive: true });
  writeFileSync(join(base, "apps", "web", "src", "features", "chunks", "page.tsx"), "a\nb\nc\n");
  writeFileSync(join(base, "server", "chunks", "page.tsx"), "a\n".repeat(200));
  writeFileSync(join(base, "readme.md"), "one\ntwo\n");
  roots = resolveRoots([base]);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

test("resolves a path relative to a root", async () => {
  const found = await new FileResolver(roots).candidates("readme.md");
  expect(found).toHaveLength(1);
  expect(found[0].lines).toBe(3);
});

test("resolves a bare basename buried deep in the tree", async () => {
  // The whole-tree index this replaced listed every file under the roots and kept the first 20,000;
  // in a monorepo an entire subtree could fall outside that slice and every citation into it came
  // back "file not found" (issue #16). A targeted by-name search has no such cap.
  const found = await new FileResolver(roots).candidates("apps/web/src/features/chunks/page.tsx");
  expect(found).toHaveLength(1);
});

test("prefers the file under the mapped task path", async () => {
  const taskPath = join(base, "apps", "web", "src", "features", "chunks");
  const found = await new FileResolver(roots, taskPath).candidates("page.tsx");
  expect(found).toHaveLength(1);
  expect(found[0].path).toBe(join(taskPath, "page.tsx"));
});

test("returns every same-named file when nothing disambiguates", async () => {
  const found = await new FileResolver(roots).candidates("page.tsx");
  expect(found).toHaveLength(2);
});

test("matches a partial path only at a segment boundary", async () => {
  expect(await new FileResolver(roots).candidates("chunks/page.tsx")).toHaveLength(2);
  expect(await new FileResolver(roots).candidates("age.tsx")).toEqual([]);
});

test("a path that escapes the roots resolves to nothing", async () => {
  expect(await new FileResolver(roots).candidates("../../etc/passwd")).toEqual([]);
  expect(await new FileResolver(roots).candidates("/etc/hostname")).toEqual([]);
});

test("a task path outside the roots cannot smuggle a file in", async () => {
  expect(await new FileResolver(roots, "/etc").candidates("hostname")).toEqual([]);
});

test("returns the canonical path, so two spellings of one file compare equal", async () => {
  const resolver = new FileResolver(roots);
  const direct = await resolver.candidates("readme.md");
  const roundabout = await resolver.candidates("server/../readme.md");
  expect(roundabout[0].path).toBe(direct[0].path);
});

test("a missing file is simply absent", async () => {
  expect(await new FileResolver(roots).candidates("schemas/document.ts")).toEqual([]);
});
