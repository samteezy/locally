import { test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWithinRoots, resolveRoots } from "./sandbox.js";

// realpath the temp base so the expected values match what assertWithinRoots returns on
// platforms where the temp dir is itself a symlink (e.g. /tmp -> /private/tmp on macOS).
const base = realpathSync(mkdtempSync(join(tmpdir(), "locally-sbx-")));

const rootA = join(base, "a");
const rootB = join(base, "b");
const outside = join(base, "outside");
mkdirSync(rootA);
mkdirSync(rootB);
mkdirSync(outside);
writeFileSync(join(rootA, "file.txt"), "hi");
writeFileSync(join(outside, "secret.txt"), "s");
// A symlink that lives inside rootA but points at a file outside the roots.
symlinkSync(join(outside, "secret.txt"), join(rootA, "escape.txt"));

const roots = resolveRoots([rootA, rootB]);

test("allows an existing file inside a root", () => {
  expect(assertWithinRoots(join(rootA, "file.txt"), roots, { mustExist: true })).toBe(
    join(rootA, "file.txt")
  );
});

test("rejects ../ traversal escape", () => {
  expect(() =>
    assertWithinRoots(join(rootA, "..", "outside", "secret.txt"), roots, { mustExist: true })
  ).toThrow(/outside the allowed roots/);
});

test("rejects an absolute path outside the roots", () => {
  expect(() => assertWithinRoots("/etc/passwd", roots, { mustExist: true })).toThrow(
    /outside the allowed roots/
  );
});

test("rejects a symlink inside a root that points outside", () => {
  expect(() =>
    assertWithinRoots(join(rootA, "escape.txt"), roots, { mustExist: true })
  ).toThrow(/outside the allowed roots/);
});

test("allows a new (non-existent) file under a root", () => {
  expect(assertWithinRoots(join(rootA, "new.txt"), roots)).toBe(join(rootA, "new.txt"));
});

test("rejects a new file outside the roots", () => {
  expect(() => assertWithinRoots(join(outside, "new.txt"), roots)).toThrow(
    /outside the allowed roots/
  );
});

test("allows a path inside the second root", () => {
  expect(assertWithinRoots(join(rootB, "x.txt"), roots)).toBe(join(rootB, "x.txt"));
});

test("resolveRoots throws when no root resolves", () => {
  expect(() => resolveRoots([join(base, "does-not-exist")])).toThrow(/allowedRoots/);
});
