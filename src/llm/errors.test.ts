import { test, expect } from "vitest";
import { LocallyError, formatLocallyError } from "./errors.js";

test("LocallyError carries category, origin, retriable, and fix", () => {
  const err = new LocallyError("boom", {
    category: "timeout",
    origin: "local",
    retriable: true,
    fix: "raise the timeout",
  });
  expect(err.name).toBe("LocallyError");
  expect(err.message).toBe("boom");
  expect(err.category).toBe("timeout");
  expect(err.origin).toBe("local");
  expect(err.retriable).toBe(true);
  expect(err.fix).toBe("raise the timeout");
  expect(err).toBeInstanceOf(Error);
});

test("formatLocallyError renders the tag line, message, and fix for a LocallyError", () => {
  const out = formatLocallyError(
    new LocallyError("endpoint down", {
      category: "upstream",
      origin: "upstream",
      retriable: false,
      fix: "check the endpoint",
    })
  );
  expect(out).toBe("[locally error: upstream — upstream]\nendpoint down\nFix: check the endpoint");
  // Not retriable → no retriable marker in the tag.
  expect(out).not.toContain("retriable");
});

test("formatLocallyError adds the · retriable marker only when retriable", () => {
  const out = formatLocallyError(
    new LocallyError("slow", {
      category: "timeout",
      origin: "local",
      retriable: true,
      fix: "raise timeout",
    })
  );
  expect(out).toContain("[locally error: timeout — local · retriable]");
});

test("formatLocallyError renders a non-LocallyError as an internal local error", () => {
  const out = formatLocallyError(new Error("unexpected"));
  expect(out).toContain("[locally error: internal — local]");
  expect(out).toContain("unexpected");
  expect(out).toContain("Fix:");
});

test("formatLocallyError stringifies non-Error thrown values", () => {
  const out = formatLocallyError("just a string");
  expect(out).toContain("[locally error: internal — local]");
  expect(out).toContain("just a string");
});
