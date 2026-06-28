import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(
    assertWithinRoots(join(rootA, "file.txt"), roots, { mustExist: true }),
    join(rootA, "file.txt")
  );
});

test("rejects ../ traversal escape", () => {
  assert.throws(
    () => assertWithinRoots(join(rootA, "..", "outside", "secret.txt"), roots, { mustExist: true }),
    /outside the allowed roots/
  );
});

test("rejects an absolute path outside the roots", () => {
  assert.throws(
    () => assertWithinRoots("/etc/passwd", roots, { mustExist: true }),
    /outside the allowed roots/
  );
});

test("rejects a symlink inside a root that points outside", () => {
  assert.throws(
    () => assertWithinRoots(join(rootA, "escape.txt"), roots, { mustExist: true }),
    /outside the allowed roots/
  );
});

test("allows a new (non-existent) file under a root", () => {
  assert.equal(assertWithinRoots(join(rootA, "new.txt"), roots), join(rootA, "new.txt"));
});

test("rejects a new file outside the roots", () => {
  assert.throws(
    () => assertWithinRoots(join(outside, "new.txt"), roots),
    /outside the allowed roots/
  );
});

test("allows a path inside the second root", () => {
  assert.equal(assertWithinRoots(join(rootB, "x.txt"), roots), join(rootB, "x.txt"));
});

test("resolveRoots throws when no root resolves", () => {
  assert.throws(() => resolveRoots([join(base, "does-not-exist")]), /allowedRoots/);
});
