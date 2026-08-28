import { test, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "./read-file.js";

const base = mkdtempSync(join(tmpdir(), "locally-read-"));

const sample = join(base, "sample.ts");
writeFileSync(sample, ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n"));

const long = join(base, "long.txt");
writeFileSync(long, Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));

test("prefixes every line with its 1-based number", async () => {
  const out = await readFile({ path: sample });
  expect(out).toContain("1\talpha");
  expect(out).toContain("5\tepsilon");
});

test("numbers are absolute under offset, not relative to the slice", async () => {
  const out = await readFile({ path: sample, offset: 3, limit: 2 });
  expect(out).toContain("3\tgamma");
  expect(out).toContain("4\tdelta");
  expect(out).not.toContain("1\tgamma");
  expect(out).not.toContain("epsilon");
});

test("truncates past the default cap and says how to continue", async () => {
  const out = await readFile({ path: long });
  expect(out).toContain("2000\tline 2000");
  expect(out).not.toContain("2001\tline 2001");
  expect(out).toContain("500 more lines");
  expect(out).toContain("read from line 2001");
});

test("no truncation footer when the whole file fits", async () => {
  const out = await readFile({ path: sample });
  expect(out).not.toContain("more line");
});

test("reports the path in the failure message", async () => {
  await expect(readFile({ path: join(base, "nope.ts") })).rejects.toThrow(/Cannot read file .*nope\.ts/);
});
